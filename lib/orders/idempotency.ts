// POS4-2 — replay-safe order creation.
//
// The failure this prevents: on flaky cafe wifi a POST /api/orders succeeds
// server-side but the response never arrives. The staffer sees an error and taps
// again — and the customer gets a second identical order, which on the POS
// "Collect now" path means they are charged twice. The POS's in-flight ref
// guards a double TAP within one page; it cannot guard a re-submit after a
// network failure. Only the server can.
//
// Contract: the client sends an `Idempotency-Key` header. The first request
// CLAIMS the key (a row with a null order_id), creates the order, then completes
// the claim. A replay of the same key returns the original order. A concurrent
// duplicate — key claimed but not yet completed — is rejected rather than
// allowed to race.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

// Bound the header so a hostile or broken client can't write unbounded rows.
const MAX_KEY_LENGTH = 200;
const MIN_KEY_LENGTH = 8;

export type ClaimResult =
  | { state: 'claimed' } // proceed with creation
  | { state: 'replay'; orderId: string } // return the original order
  | { state: 'in_flight' } // an identical request is mid-creation
  | { state: 'unavailable' }; // the table isn't there — proceed without the guard

/** Reads and validates the header. Returns null when absent or implausible. */
export function readIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get('idempotency-key');
  if (!raw) return null;
  const key = raw.trim();
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) return null;
  return key;
}

/**
 * Attempts to claim `key` for a new order.
 *
 * Degrades to 'unavailable' if the idempotency_keys table doesn't exist yet
 * (migration not applied). Losing replay protection is bad; refusing to take a
 * customer's order because a bookkeeping table is missing is worse — so this
 * fails OPEN, and says so in the log.
 */
export async function claimIdempotencyKey(
  admin: Admin,
  key: string,
  userId: string | null,
): Promise<ClaimResult> {
  const { error } = await admin.from('idempotency_keys').insert({ key, created_by: userId });

  if (!error) return { state: 'claimed' };

  // 23505 = unique violation: this key has been used or is being used.
  if (error.code === '23505') {
    const { data } = await admin
      .from('idempotency_keys')
      .select('order_id')
      .eq('key', key)
      .maybeSingle();
    const orderId = (data as { order_id: string | null } | null)?.order_id ?? null;
    return orderId ? { state: 'replay', orderId } : { state: 'in_flight' };
  }

  console.error(
    'idempotency claim failed — proceeding WITHOUT replay protection. ' +
      'Is supabase/2026-08-idempotent-orders.sql applied?',
    error,
  );
  return { state: 'unavailable' };
}

/**
 * Completes a claim by pointing it at the created order. Best-effort: the order
 * exists and must be returned regardless, so a failure here only costs replay
 * protection for that one key.
 */
export async function completeIdempotencyKey(
  admin: Admin,
  key: string,
  orderId: string,
): Promise<void> {
  const { error } = await admin.from('idempotency_keys').update({ order_id: orderId }).eq('key', key);
  if (error) console.error('idempotency completion failed', key, orderId, error);
}

/**
 * Releases a claim when creation failed, so the staffer's retry isn't rejected
 * as a duplicate of an order that never existed.
 */
export async function releaseIdempotencyKey(admin: Admin, key: string): Promise<void> {
  const { error } = await admin.from('idempotency_keys').delete().eq('key', key).is('order_id', null);
  if (error) console.error('idempotency release failed', key, error);
}
