import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStaffOrOwner } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { clientIp } from '@/lib/api/rateLimit';
import { evaluateStoreNetwork } from '@/lib/attendance/network';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { evaluateGeofence, type GeoReading } from '@/lib/attendance/geofence';
import { detectIntegrityFlags } from '@/lib/attendance/integrity';
import { getAttendanceSettings, geofenceConfigFrom } from '@/lib/attendance/settings';
import { cashRequirementFor, recordCount, recordOverride } from '@/lib/cash/checkpoints';
import { kindForPunch, type CashCountResult, type PunchCashRequirement } from '@/lib/cash/counts';
import type { AttendanceFlag, AttendanceSession, CashDenoms, PunchType } from '@/lib/types';

export const dynamic = 'force-dynamic';

// ATT-1 / GEO-1 / GEO-3 — clock in and clock out.
//
// AUTHORIZATION: a valid staff session, and nothing more. This route is
// deliberately NOT behind hasPermission(). That helper fails CLOSED to manager
// for any key whose role_permissions row is missing, so a punch key would stop
// the entire team marking attendance the moment a seed row went astray — which
// is exactly the trap Phase 4's TAB-1 sidestepped. See SECURITY-PLAYBOOK A-4.
//
// WHAT THE CLIENT IS TRUSTED FOR: raw sensor readings only — lat, lng, accuracy,
// fix age. Not the time (A-1), not the distance, not the verdict (A-2). If a
// body carries `distance_m` or `accepted`, they are ignored rather than
// validated, because validating them implies they could ever be used.

/** A retry inside this window returns the existing session instead of opening a second one. */
const RETRY_IDEMPOTENCY_MS = 60_000;

interface PunchBody {
  type: PunchType;
  reading: GeoReading;
  /** CC-2: the drawer count taken alongside this punch, if any. Optional even
   *  when a count is required — its absence is what triggers the 428 gate. */
  cashDenoms?: CashDenoms;
}

function parseBody(raw: Record<string, unknown>): PunchBody | null {
  const type = raw.type;
  if (type !== 'in' && type !== 'out') return null;

  // Numbers only. A string here is either a broken client or a probing one;
  // either way isValidReading() would reject it downstream, but refusing the
  // shape up front keeps the failure legible.
  const lat = raw.lat;
  const lng = raw.lng;
  const accuracyM = raw.accuracy_m;
  const fixAgeMs = raw.fix_age_ms ?? 0;
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    typeof accuracyM !== 'number' ||
    typeof fixAgeMs !== 'number'
  ) {
    return null;
  }

  // cash_denoms is sanitized server-side by recordCount() — here we only need
  // to know whether the client SENT a denomination map at all, so a garbage
  // shape (an array, a string) is treated as "not sent" rather than crashing.
  const cashDenoms =
    raw.cash_denoms && typeof raw.cash_denoms === 'object' && !Array.isArray(raw.cash_denoms)
      ? (raw.cash_denoms as CashDenoms)
      : undefined;

  return { type, reading: { lat, lng, accuracyM, fixAgeMs }, cashDenoms };
}

/**
 * Best-effort: records the cash checkpoint for a punch that has ALREADY been
 * accepted and written. Never throws — a failure here must not undo the
 * punch, so it's logged and surfaced to the caller as `cashCountError`
 * instead. Prefers an actual count (the staffer counted) over a standing
 * override even if both are present, so an override is never burned when the
 * staffer went ahead and counted anyway.
 */
async function recordCashCheckpoint(
  admin: SupabaseClient,
  userId: string,
  punchType: PunchType,
  sessionId: string,
  cashDenoms: CashDenoms | undefined,
  usableOverride: PunchCashRequirement['override'],
): Promise<{ cashCount?: CashCountResult; cashCountError?: string }> {
  try {
    if (cashDenoms) {
      const cashCount = await recordCount(admin, {
        kind: kindForPunch(punchType),
        userId,
        denoms: cashDenoms,
        attendanceSessionId: sessionId,
      });
      return { cashCount };
    }
    if (usableOverride) {
      const cashCount = await recordOverride(admin, {
        userId,
        punchType,
        attendanceSessionId: sessionId,
      });
      return { cashCount };
    }
    return {};
  } catch (err) {
    console.error('attendance: failed to record the cash checkpoint for an accepted punch', err);
    return {
      cashCountError: 'The punch was recorded, but the cash count could not be saved — tell a manager.',
    };
  }
}

async function logAttempt(
  userId: string,
  punchType: PunchType,
  reading: GeoReading,
  distanceM: number | null,
  reason: string,
): Promise<void> {
  // Best-effort. A refusal that fails to log is still a refusal — never let the
  // audit write turn a clean 422 into a 500.
  try {
    const admin = createAdminSupabaseClient();
    await admin.from('attendance_punch_attempts').insert({
      user_id: userId,
      punch_type: punchType,
      lat: reading.lat,
      lng: reading.lng,
      accuracy_m: reading.accuracyM,
      distance_m: distanceM,
      reason,
    });
  } catch (err) {
    console.error('attendance: failed to log refused punch', err);
  }
}

export async function POST(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return unauthorized();
  const userId = account.user.id;

  const raw = await parseJsonBody(request);
  if (!raw) return errorResponse(400, 'Request body must be a JSON object');

  const body = parseBody(raw);
  if (!body) {
    return errorResponse(400, 'A punch needs type ("in" or "out") and numeric lat, lng and accuracy_m.');
  }

  const admin = createAdminSupabaseClient();
  const settings = await getAttendanceSettings();

  // The open session decides what a punch MEANS, so read it before deciding
  // anything else.
  const { data: openRow, error: openErr } = await admin
    .from('attendance_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'open')
    .maybeSingle();
  if (openErr) return errorResponse(500, 'Could not read your attendance state');
  const open = openRow as AttendanceSession | null;

  // --- Retry idempotency ---------------------------------------------------
  // A flaky connection makes staff tap twice. Answer the retry with the result
  // of the first attempt rather than opening a second shift or refusing a
  // clock-out that already happened.
  const nowMs = Date.now();
  if (body.type === 'in' && open && nowMs - Date.parse(open.clock_in_at) < RETRY_IDEMPOTENCY_MS) {
    return NextResponse.json({ session: open, alreadyOpen: true, repeat: true });
  }
  if (body.type === 'in' && open) {
    // Not a retry — a genuine second clock-in over a live shift. Return the
    // open session and let the UI show its true state rather than stacking.
    return NextResponse.json({ session: open, alreadyOpen: true, repeat: false });
  }
  if (body.type === 'out' && !open) {
    const { data: recent } = await admin
      .from('attendance_sessions')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['closed', 'auto_closed'])
      .order('clock_out_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const last = recent as AttendanceSession | null;
    if (last?.clock_out_at && nowMs - Date.parse(last.clock_out_at) < RETRY_IDEMPOTENCY_MS) {
      return NextResponse.json({ session: last, repeat: true });
    }
    return errorResponse(409, "You're not clocked in right now.");
  }

  // --- CC-2: cash count gate ------------------------------------------------
  // Resolved before anything irreversible happens (the session insert/RPC
  // below). cashRequirementFor() fails safe to "not required" on any error —
  // a bug in this subsystem must never block the whole team from punching.
  const cashReq = await cashRequirementFor(admin, userId);
  const usableOverride =
    cashReq.override && cashReq.override.punchType === body.type ? cashReq.override : null;
  if (cashReq.required && !usableOverride && !body.cashDenoms) {
    return NextResponse.json(
      { error: 'Count the cash drawer before you clock in/out.', code: 'CASH_COUNT_REQUIRED' },
      { status: 428 },
    );
  }

  // --- The geofence decides, server-side (A-2) -----------------------------
  const verdict = evaluateGeofence(body.reading, geofenceConfigFrom(settings));
  if (!verdict.accepted) {
    await logAttempt(userId, body.type, body.reading, verdict.distanceM, verdict.code);
    // 422, not 403: the request was well-formed and authorized — it is the
    // real-world condition that failed. The message is written to be shown
    // verbatim and says what to do next.
    return NextResponse.json(
      { error: verdict.reason, code: verdict.distanceM === null ? verdict.code : 'outside', distance_m: verdict.distanceM },
      { status: 422 },
    );
  }

  // --- GEO-2 integrity signals (flag, never block) -------------------------
  const { data: priorRow } = await admin
    .from('attendance_sessions')
    .select('clock_in_at, clock_in_lat, clock_in_lng, clock_in_accuracy_m')
    .eq('user_id', userId)
    .order('clock_in_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const prior = priorRow as {
    clock_in_at: string;
    clock_in_lat: number | null;
    clock_in_lng: number | null;
    clock_in_accuracy_m: number | null;
  } | null;

  const integrityFlags = detectIntegrityFlags({
    lat: body.reading.lat,
    lng: body.reading.lng,
    accuracyM: body.reading.accuracyM,
    atMs: nowMs,
    prior: prior?.clock_in_lat != null
      ? {
          lat: Number(prior.clock_in_lat),
          lng: Number(prior.clock_in_lng),
          accuracyM: prior.clock_in_accuracy_m === null ? null : Number(prior.clock_in_accuracy_m),
          atMs: Date.parse(prior.clock_in_at),
        }
      : null,
  });
  // NET-1 — did this come through the cafe's connection? A browser cannot read
  // the WiFi name, so the public IP is the closest available proof, and it is a
  // genuinely useful one: a spoofed GPS from home passes the geofence and fails
  // HERE. Flagged, never blocking — the cafe's IP is probably dynamic, and a
  // blocking check would lock the team out on a morning the router rebooted.
  const network = evaluateStoreNetwork(clientIp(request), settings.store_networks);

  const flags = Array.from(
    new Set([...verdict.flags, ...integrityFlags, ...network.flags]),
  ) as AttendanceFlag[];

  if (body.type === 'in') {
    // NOTE what is absent: clock_in_at and business_date. The column default
    // supplies the time and a trigger derives the date (A-1 / GEO-3). Passing
    // either would be the bug this design exists to prevent.
    const { data: created, error } = await admin
      .from('attendance_sessions')
      .insert({
        user_id: userId,
        clock_in_lat: body.reading.lat,
        clock_in_lng: body.reading.lng,
        clock_in_accuracy_m: body.reading.accuracyM,
        clock_in_distance_m: verdict.distanceM,
        flags,
      })
      .select('*')
      .single();

    if (error) {
      // 23505 = the one-open-session partial unique index. Two taps raced; the
      // loser reports the winner's session rather than an error.
      if ((error as { code?: string }).code === '23505') {
        const { data: existing } = await admin
          .from('attendance_sessions')
          .select('*')
          .eq('user_id', userId)
          .eq('status', 'open')
          .maybeSingle();
        if (existing) return NextResponse.json({ session: existing, alreadyOpen: true, repeat: true });
      }
      console.error('attendance: clock-in insert failed', error);
      return errorResponse(500, 'Could not record your clock-in. Please try again.');
    }

    // CC-2: the punch is already written — a cash-count failure from here on
    // is logged and surfaced, never lets us undo it.
    const { cashCount, cashCountError } = await recordCashCheckpoint(
      admin,
      userId,
      'in',
      (created as AttendanceSession).id,
      body.cashDenoms,
      usableOverride,
    );
    return NextResponse.json({ session: created, repeat: false, cashCount, cashCountError });
  }

  // --- Clock out -----------------------------------------------------------
  // Via RPC so `clock_out_at` comes from the DATABASE's clock, not this
  // process's (A-1). Sending our own would also risk writing a clock-out
  // fractionally BEFORE a clock-in that came from the DB default, which the
  // times-ordered CHECK would reject — a legitimate punch failing on clock
  // drift between two hosts.
  const { data: closedRows, error: closeErr } = await admin.rpc('attendance_clock_out', {
    p_session_id: open!.id,
    p_user_id: userId,
    p_lat: body.reading.lat,
    p_lng: body.reading.lng,
    p_accuracy_m: body.reading.accuracyM,
    p_distance_m: verdict.distanceM,
    p_flags: Array.from(new Set([...(open!.flags ?? []), ...flags])),
  });

  if (closeErr) {
    console.error('attendance: clock-out failed', closeErr);
    return errorResponse(500, 'Could not record your clock-out. Please try again.');
  }

  const closed = (closedRows as AttendanceSession[] | null)?.[0] ?? null;
  if (!closed) {
    // Zero rows means the status guard matched nothing — an auto-close got
    // there first, or a duplicate request already closed it.
    return errorResponse(409, 'That shift was already closed. Refresh to see its current state.');
  }

  const { cashCount, cashCountError } = await recordCashCheckpoint(
    admin,
    userId,
    'out',
    closed.id,
    body.cashDenoms,
    usableOverride,
  );
  return NextResponse.json({ session: closed, repeat: false, cashCount, cashCountError });
}
