import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import { loadEmploymentRows, employmentOnDate } from '@/lib/attendance/employment';
import { shiftEndInstant } from '@/lib/attendance/businessDate';
import type { AttendanceSession } from '@/lib/types';

export const dynamic = 'force-dynamic';

// SHEET-3 — close sessions somebody forgot to close.
//
// This is not polish. Without it a forgotten clock-out is UNRECOVERABLE by the
// staffer: the one-open-session index means their next clock-in just returns
// the stale shift, so their only way out is to clock out and record a 20-hour
// day. Attendance cannot safely be switched on until this runs.
//
// What it does NOT do is guess someone's pay. A session it closes is marked
// `auto_closed` and left UNAPPROVED, and rollUpDay() gives an unapproved
// auto-close zero payable minutes (D5-4). The owner sees it in the queue and
// either approves it or corrects it. Never a silently-paid guess.
//
// Protected by CRON_SECRET and fails CLOSED when it is unset — same posture as
// /api/cron/expire-orders.
//
// SCHEDULED DAILY (03:00 IST), not hourly. Vercel's Hobby plan permits at most
// one run per day, and an over-frequent expression fails the DEPLOY outright
// instead of degrading — which silently froze production on an old build until
// it was tracked down. If the plan ever changes, hourly is a one-line edit.
//
// Daily costs nothing here, by design: this job closes a session AT its shift
// end, never at "now" (see `closeAt`). A once-a-day sweep therefore records
// exactly the times an hourly one would; all that changes is how long a
// forgotten clock-out waits before surfacing in the approval queue. 03:00 IST
// is past the cafe's midnight close plus the two-hour grace, so one pass clears
// the whole day.

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const admin = createAdminSupabaseClient();
  const settings = await getAttendanceSettings();
  const now = Date.now();

  const { data: openRows, error } = await admin
    .from('attendance_sessions')
    .select('*')
    .eq('status', 'open');
  if (error) return errorResponse(500, 'Could not read open attendance sessions');

  const open = (openRows ?? []) as AttendanceSession[];
  if (open.length === 0) {
    return NextResponse.json({ scanned: 0, closed: 0, capped: 0 });
  }

  const dates = open.map((s) => s.business_date).sort();
  const employment = await loadEmploymentRows(dates[0], dates[dates.length - 1]);

  const absoluteCapMs = settings.max_session_hours * 3_600_000;
  let closed = 0;
  let capped = 0;

  for (const session of open) {
    const clockInMs = Date.parse(session.clock_in_at);
    if (!Number.isFinite(clockInMs)) continue;

    const record = employmentOnDate(employment, session.user_id, session.business_date);

    // Two independent reasons to close, whichever comes first:
    //  1. the contracted shift ended a while ago (the normal case);
    //  2. the absolute cap — the backstop for somebody with no employment
    //     record at all, who would otherwise stay open forever.
    let dueAt: number | null = null;
    if (record) {
      const end = shiftEndInstant(session.clock_in_at, record.shift_start_time, record.shift_end_time);
      if (end) {
        const candidate = end.getTime() + settings.auto_close_grace_min * 60_000;
        // Only trust the shift end if it actually lands AFTER the clock-in.
        // Someone who starts at 22:00 against a 10:00–19:00 record — a swapped
        // shift, a covered shift, a stale employment row — would otherwise get
        // a due time earlier than when they arrived, and we would write a
        // clock_out_at BEFORE the clock_in_at, which the times-ordered CHECK
        // rejects. Fall back to the absolute cap: it is always later.
        if (candidate > clockInMs) dueAt = candidate;
      }
    }
    const capAt = clockInMs + absoluteCapMs;
    const effectiveDue = dueAt === null ? capAt : Math.min(dueAt, capAt);
    if (now < effectiveDue) continue;

    const isCap = effectiveDue === capAt && (dueAt === null || capAt < dueAt);
    // Close AT the due moment, not at "now" — a cron that ran six hours late
    // must not hand someone six extra hours.
    const closeAt = new Date(effectiveDue).toISOString();

    const flags = Array.from(new Set([...(session.flags ?? []), 'auto_closed']));

    // Status-guarded, which is what makes this idempotent AND race-safe: a real
    // clock-out landing at the same moment wins or loses cleanly, and a second
    // cron run finds nothing left open.
    const { data: updated, error: updErr } = await admin
      .from('attendance_sessions')
      .update({
        clock_out_at: closeAt,
        status: 'auto_closed',
        flags,
        notes: isCap
          ? `Auto-closed at the ${settings.max_session_hours}h maximum — no shift end on record.`
          : 'Auto-closed at the end of the scheduled shift.',
      })
      .eq('id', session.id)
      .eq('status', 'open')
      .select('id')
      .maybeSingle();

    if (updErr) {
      console.error('attendance: auto-close failed', session.id, updErr);
      continue;
    }
    if (updated) {
      closed += 1;
      if (isCap) capped += 1;
    }
  }

  return NextResponse.json({ scanned: open.length, closed, capped });
}
