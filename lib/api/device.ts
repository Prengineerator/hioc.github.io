// DEV-2 — resolving the device cookie against the pos_devices table.
//
// The crypto and cookie-shape half is lib/api/deviceCookie.ts (pure, tested).
// This half needs the database and next/headers, so it is server-only.

import 'server-only';
import { cookies } from 'next/headers';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { DEVICE_COOKIE, hashDeviceToken } from '@/lib/api/deviceCookie';
import type { PosDevice } from '@/lib/types';

/**
 * Every column of pos_devices EXCEPT token_hash. Written out rather than using
 * `*` so the secret cannot ride along into a response by accident — the same
 * discipline TABLE_COLUMNS applies to tables.qr_token.
 */
export const DEVICE_COLUMNS =
  'id, name, enrolled_by, enrolled_at, last_seen_at, revoked_at, default_order_type, auto_print_kot, auto_print_bill';

/** Don't rewrite last_seen_at on every boot — hourly resolution is plenty for
 *  "is that machine still in use?", and this is a write on a read path. */
const SEEN_STALE_MS = 60 * 60 * 1000;

/**
 * The device this request came from, or null.
 *
 * Null covers every failure: no cookie, an unknown secret, a REVOKED device,
 * and a database that cannot answer (including the table not existing because
 * the migration has not been applied). Failing to "unenrolled" is the safe
 * direction in both places this is used — the POS falls back to store-level
 * defaults, and the 6C lock screen does not appear on a machine we cannot
 * identify. It is never the thing granting access, so failing open is not a
 * thing this function can do.
 */
export async function getEnrolledDevice(): Promise<PosDevice | null> {
  const token = cookies().get(DEVICE_COOKIE)?.value;
  if (!token) return null;

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('pos_devices')
    .select(DEVICE_COLUMNS)
    .eq('token_hash', hashDeviceToken(token))
    .is('revoked_at', null)
    .maybeSingle();

  if (error) {
    console.error('getEnrolledDevice: pos_devices lookup failed', error);
    return null;
  }
  return (data as PosDevice | null) ?? null;
}

/**
 * Records that we heard from this machine. Best-effort and non-blocking by
 * design: it is a convenience for the owner's device list, and a failed write
 * must never turn into a failed POS boot.
 */
export async function touchDeviceSeen(device: PosDevice): Promise<void> {
  const last = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
  if (Number.isFinite(last) && Date.now() - last < SEEN_STALE_MS) return;

  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from('pos_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id);
  if (error) console.error('touchDeviceSeen: update failed', error);
}
