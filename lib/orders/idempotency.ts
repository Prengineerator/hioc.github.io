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
//
// A key's life (idempotency_keys, one row per key):
//
//   free ──claim (insert)──▶ claimed ──complete (order_id set)──▶ completed
//                              │                                    (the end:
//                              ├──release (row deleted)──▶ free       replays get
//                              │   creation failed; nothing exists    its order)
//                              └──older than IDEMPOTENCY_CLAIM_TTL_MS──▶ stale
//   stale ──reclaim (compare-and-set on the claim seen)──▶ claimed
//
// 'free' is no row: never claimed, or released. 'stale' is derived, never
// written: a claim whose request died between claiming and completing (the
// platform killed it, or it crashed before it could release). Without it such
// a key answered "already being placed" for ever, and the POS keeps the key
// on that answer (lib/pos/ritual.ts), so the staffer could never place the
// order.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export const IDEMPOTENCY_KEY_STATES = ['free', 'claimed', 'stale', 'completed'] as const;
export type IdempotencyKeyState = (typeof IDEMPOTENCY_KEY_STATES)[number];

/**
 * How long a claim with no order holds before it may be taken over. Both
 * callers (POST /api/orders, POST /api/passes/sell) claim right before they
 * create the order and complete right after, so a live request holds a claim
 * for seconds; neither route raises maxDuration, so the platform kills any
 * request by its default ceiling of 300 s. Ten minutes is twice that: a
 * reclaim can never race a request that is still alive and about to create
 * the order (which would be the duplicate this table exists to stop), and a
 * dead claim frees itself in minutes instead of never.
 */
export const IDEMPOTENCY_CLAIM_TTL_MS = 10 * 60 * 1000;

export interface IdempotencyKeyRow {
  order_id: string | null;
  created_at?: string | null;
}

/**
 * Where a key stands. A claim whose age can't be read counts as live: a
 * duplicate order is worse than a retry that waits.
 */
export function idempotencyKeyState(row: IdempotencyKeyRow | null, nowMs: number): IdempotencyKeyState {
  if (!row) return 'free';
  if (row.order_id) return 'completed';
  const claimedAt = Date.parse(row.created_at ?? '');
  if (Number.isNaN(claimedAt)) return 'claimed';
  return nowMs - claimedAt >= IDEMPOTENCY_CLAIM_TTL_MS ? 'stale' : 'claimed';
}

export const IDEMPOTENCY_KEY_TRANSITIONS: readonly { op: 'claim' | 'complete' | 'release' | 'reclaim'; from: IdempotencyKeyState; to: IdempotencyKeyState }[] = [
  { op: 'claim', from: 'free', to: 'claimed' },
  { op: 'complete', from: 'claimed', to: 'completed' },
  { op: 'release', from: 'claimed', to: 'free' },
  { op: 'reclaim', from: 'stale', to: 'claimed' },
];

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
      .select('order_id, created_at')
      .eq('key', key)
      .maybeSingle();
    const row = (data as IdempotencyKeyRow | null) ?? null;
    const state = idempotencyKeyState(row, Date.now());
    if (state === 'completed') return { state: 'replay', orderId: row!.order_id as string };
    if (state === 'stale') return reclaimStaleKey(admin, key, userId, row!.created_at as string);
    return { state: 'in_flight' };
  }

  console.error(
    'idempotency claim failed — proceeding WITHOUT replay protection. ' +
      'Is supabase/2026-08-idempotent-orders.sql applied?',
    error,
  );
  return { state: 'unavailable' };
}

/**
 * Takes over a stale claim: compare-and-set on the claim time read, still with
 * no order, so of two retries only one gets it, and a claim that was completed
 * meanwhile is never taken. The claim time moves to now, so the new holder has
 * the full TTL. Losing answers what the key is now.
 */
async function reclaimStaleKey(admin: Admin, key: string, userId: string | null, seenClaimedAt: string): Promise<ClaimResult> {
  const { data: taken, error } = await admin
    .from('idempotency_keys')
    .update({ created_at: new Date().toISOString(), created_by: userId })
    .eq('key', key)
    .eq('created_at', seenClaimedAt)
    .is('order_id', null)
    .select('key')
    .maybeSingle();
  if (!error && taken) {
    console.error('idempotency: took over a claim left by a request that never finished', key, seenClaimedAt);
    return { state: 'claimed' };
  }
  if (error) console.error('idempotency reclaim failed', key, error);
  const { data } = await admin.from('idempotency_keys').select('order_id').eq('key', key).maybeSingle();
  const orderId = (data as { order_id: string | null } | null)?.order_id ?? null;
  return orderId ? { state: 'replay', orderId } : { state: 'in_flight' };
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
  // claimed → completed only: a completed key keeps the order it first pointed at.
  const { error } = await admin.from('idempotency_keys').update({ order_id: orderId }).eq('key', key).is('order_id', null);
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
