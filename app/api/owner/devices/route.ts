import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { DEVICE_COLUMNS, getEnrolledDevice } from '@/lib/api/device';
import {
  DEVICE_COOKIE,
  clearedDeviceCookieOptions,
  deviceCookieOptions,
  hashDeviceToken,
  newDeviceToken,
} from '@/lib/api/deviceCookie';
import type { PosDevice } from '@/lib/types';

export const dynamic = 'force-dynamic';

// DEV-2 — the owner's device registry: enroll the machine you are sitting at,
// name it, set its defaults (DEV-3), and revoke it when it leaves the building.
//
// Owner-only, every method, and every read goes through DEVICE_COLUMNS so
// token_hash cannot ride along in a response. Enrollment is the only place a
// plaintext secret exists at all, and it exists there for one Set-Cookie.

const MAX_NAME_LEN = 40;
const ORDER_TYPES = ['takeaway', 'dine_in'] as const;

/**
 * PostgREST's answer when the table does not exist. Worth translating rather
 * than passing through: the first person to open this page is the owner, on the
 * deploy where the migration has not been applied yet, and "Could not find the
 * table 'public.pos_devices' in the schema cache" reads as a broken page rather
 * than as one instruction away from working.
 */
const MISSING_TABLE = 'PGRST205';
const MISSING_TABLE_MSG =
  'Device registry is not set up yet — apply supabase/2026-08-pos-devices.sql';

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  return (
    error?.code === MISSING_TABLE ||
    error?.code === '42P01' ||
    /could not find the table/i.test(error?.message ?? '')
  );
}

/** Reads a three-state DEV-3 field: absent = leave alone, null = defer to the
 *  store setting, value = this device's own answer. */
function readTriState<T>(
  body: Record<string, unknown>,
  key: string,
  valid: (v: unknown) => boolean,
): { ok: true; present: boolean; value: T | null } | { ok: false } {
  if (!(key in body)) return { ok: true, present: false, value: null };
  const raw = body[key];
  if (raw === null) return { ok: true, present: true, value: null };
  if (!valid(raw)) return { ok: false };
  return { ok: true, present: true, value: raw as T };
}

// GET — every device, newest first, plus which one is asking. The caller needs
// that last part to label "this device" in the list: revoking the machine you
// are standing at is a legitimate thing to do (a till being retired) and a
// destructive thing to do by accident.
export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('pos_devices')
    .select(DEVICE_COLUMNS)
    .order('enrolled_at', { ascending: false });
  if (error) return errorResponse(500, isMissingTable(error) ? MISSING_TABLE_MSG : error.message);

  const current = await getEnrolledDevice();
  return NextResponse.json({
    devices: (data ?? []) as PosDevice[],
    currentDeviceId: current?.id ?? null,
  });
}

// POST { name } — enroll THIS machine. The device being enrolled is always the
// one making the request: there is no way to hand a secret to a machine that
// isn't here, and pretending otherwise would mean emailing a token around.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return errorResponse(400, 'Name this device so you can recognise it later');
  if (name.length > MAX_NAME_LEN) {
    return errorResponse(400, `Name must be ${MAX_NAME_LEN} characters or fewer`);
  }

  // Re-enrolling a machine that is ALREADY enrolled re-keys the row it has,
  // rather than inserting a second one.
  //
  // Two reasons, and the first is a bug this shape avoids: inserting first and
  // retiring the old row afterwards means the most ordinary re-enrollment —
  // same machine, same name, new key — collides with its own name on
  // idx_pos_devices_active_name and comes back "already enrolled". Doing the
  // retire first instead would leave the machine unenrolled whenever the insert
  // then fails for a real reason. The second is that there was never a second
  // device here to represent: it is one till being handed a new key, and a
  // trail of dead rows per re-key makes the revoke list harder to read for no
  // gain. The old cookie stops resolving the instant token_hash changes.
  const existing = await getEnrolledDevice();

  const token = newDeviceToken();
  const admin = createAdminSupabaseClient();
  const credential = { name, token_hash: hashDeviceToken(token) };

  const { data, error } = existing
    ? await admin
        .from('pos_devices')
        .update(credential)
        .eq('id', existing.id)
        // enrolled_at / enrolled_by are left alone: they say when this machine
        // became known and to whom, which a re-key does not change.
        .is('revoked_at', null)
        .select(DEVICE_COLUMNS)
        .maybeSingle()
    : await admin
        .from('pos_devices')
        .insert({ ...credential, enrolled_by: owner.id })
        .select(DEVICE_COLUMNS)
        .single();

  if (error) {
    // 23505 on idx_pos_devices_active_name: an ACTIVE device already answers to
    // this name. Revoked ones don't collide, so "Counter 1" is reusable once the
    // old Counter 1 is retired.
    if (error.code === '23505') {
      return errorResponse(409, `A device called "${name}" is already enrolled`);
    }
    if (isMissingTable(error)) return errorResponse(500, MISSING_TABLE_MSG);
    return errorResponse(500, error.message);
  }
  // Only reachable on the re-key path (maybeSingle), and only if the device was
  // revoked from another screen between the lookup and the write.
  if (!data) return errorResponse(409, 'This device was revoked while you were enrolling it — reload and try again');

  const res = NextResponse.json({
    device: data as PosDevice,
    // What the machine used to be called, when a re-key renamed it. Null when
    // this is a first enrollment or the name did not change — the UI only has
    // something to report in the first case.
    renamedFrom: existing && existing.name !== name ? existing.name : null,
    rekeyed: Boolean(existing),
  });
  // The one and only moment the plaintext secret exists outside this function.
  res.cookies.set(DEVICE_COOKIE, token, deviceCookieOptions(request.headers.get('host')));
  return res;
}

// PATCH { id, name?, default_order_type?, auto_print_kot?, auto_print_bill?,
//         revoke? } — rename, set DEV-3 defaults, or kill the device.
export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return errorResponse(400, 'id is required');

  const patch: Record<string, unknown> = {};

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return errorResponse(400, 'A device name is required');
    if (name.length > MAX_NAME_LEN) {
      return errorResponse(400, `Name must be ${MAX_NAME_LEN} characters or fewer`);
    }
    patch.name = name;
  }

  const orderType = readTriState<string>(body, 'default_order_type', (v) =>
    ORDER_TYPES.includes(v as (typeof ORDER_TYPES)[number]),
  );
  if (!orderType.ok) return errorResponse(400, 'default_order_type must be takeaway, dine_in, or null');
  if (orderType.present) patch.default_order_type = orderType.value;

  for (const key of ['auto_print_kot', 'auto_print_bill'] as const) {
    const flag = readTriState<boolean>(body, key, (v) => typeof v === 'boolean');
    if (!flag.ok) return errorResponse(400, `${key} must be true, false, or null`);
    if (flag.present) patch[key] = flag.value;
  }

  // Revocation is one-way on purpose (migration header): there is no un-revoke,
  // because a device whose cookie may have walked out of the building doesn't
  // get to come back — it gets re-enrolled, with a new secret.
  if (body.revoke === true) patch.revoked_at = new Date().toISOString();

  if (Object.keys(patch).length === 0) return errorResponse(400, 'Nothing to update');

  // Read before the write: afterwards this machine's device no longer resolves,
  // and "the lookup returns nothing" cannot tell "I just revoked myself" apart
  // from "I was never enrolled".
  const self = body.revoke === true ? await getEnrolledDevice() : null;

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('pos_devices')
    .update(patch)
    .eq('id', id)
    // Editing a revoked device is meaningless and its name no longer holds the
    // active-name index, so scope the write to live rows.
    .is('revoked_at', null)
    .select(DEVICE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === '23505') return errorResponse(409, 'Another active device already has that name');
    if (isMissingTable(error)) return errorResponse(500, MISSING_TABLE_MSG);
    return errorResponse(500, error.message);
  }
  if (!data) return errorResponse(404, 'Device not found, or already revoked');

  const res = NextResponse.json({ device: data as PosDevice });

  // Revoking the machine you are sitting at: drop its cookie in the same
  // response. The lookup would fail from now on anyway, but leaving a dead
  // secret in the browser means a later audit of that machine finds a
  // credential for a device that no longer exists.
  if (self?.id === id) {
    res.cookies.set(DEVICE_COOKIE, '', clearedDeviceCookieOptions(request.headers.get('host')));
  }

  return res;
}
