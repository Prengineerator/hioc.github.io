// PIN-1/PIN-3/PIN-5 — the database + bcrypt half of staff PINs. The pure
// rules (format, trivial-PIN rejection, lockout arithmetic) live in
// lib/staff/pinPolicy.ts and are unit-tested without a database; this file
// wires them to staff_pins/pin_audit (supabase/2026-08-staff-pins.sql) and is
// exercised through the route tests that mock the admin client instead (the
// lockout counter's races: tests/pinAuthLockout.test.ts).

import 'server-only';
import bcrypt from 'bcryptjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import {
  LOCKOUT_THRESHOLD,
  applyFailedAttempt,
  isLockedOut,
  lockoutSecondsRemaining,
  pinFormatProblem,
  resetOnSuccess,
  type PinLockState,
} from '@/lib/staff/pinPolicy';
import type { PinAuditAction, StaffPinState } from '@/lib/types';

const BCRYPT_ROUNDS = 10;

type PgError = { code?: string; message?: string } | null | undefined;

/** Same test PostgREST uses everywhere else in this codebase for "the
 * migration hasn't been applied yet" (see lib/api/device.ts). */
export function isMissingPinTable(error: PgError): boolean {
  if (!error) return false;
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    /could not find the table/i.test(error.message ?? '')
  );
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

async function loadPinRow(
  admin: SupabaseClient,
  userId: string,
): Promise<{ row: StaffPinState | null; pinHash: string | null; error: PgError }> {
  const { data, error } = await admin
    .from('staff_pins')
    .select('user_id, pin_hash, failed_attempts, locked_until, set_by, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { row: null, pinHash: null, error };
  if (!data) return { row: null, pinHash: null, error: null };
  const row = data as StaffPinState & { pin_hash: string };
  const { pin_hash, ...rest } = row;
  return { row: rest as StaffPinState, pinHash: pin_hash, error: null };
}

export type PinVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_pin' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }
  | { ok: false; reason: 'wrong_pin'; retryAfterSeconds: number }
  | { ok: false; reason: 'unavailable' };

/**
 * How many times a verify writes the counter, re-reading it after each round
 * another request won. Contention ends at the lock: every round has a winner,
 * at most LOCKOUT_THRESHOLD wrong guesses can win before the PIN locks (one,
 * once it has locked before), and from then on the racing guesses see the
 * lock and stop. So threshold + 1 rounds is enough in the worst case, and the
 * loop stays bounded.
 */
const MAX_COUNTER_WRITES = LOCKOUT_THRESHOLD + 1;

type CounterWrite = 'won' | 'lost' | 'error';

/**
 * Writes the lockout columns only if failed_attempts still holds what this
 * request last read — a compare-and-set, so two guesses racing through bcrypt
 * can never both write "+1" over the same count (the lost-increment bug: N
 * parallel wrong guesses used to count as one).
 */
async function writeCounter(
  admin: SupabaseClient,
  userId: string,
  expectedFailedAttempts: number,
  next: PinLockState,
): Promise<CounterWrite> {
  const { data, error } = await admin
    .from('staff_pins')
    .update({ failed_attempts: next.failed_attempts, locked_until: next.locked_until, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('failed_attempts', expectedFailedAttempts)
    .select('user_id')
    .maybeSingle();
  if (error) {
    console.error('verifyPin: staff_pins counter write failed', error);
    return 'error';
  }
  return data ? 'won' : 'lost';
}

/**
 * PIN-1's verify path, enforced server-side from the staff_pins ROW (the
 * primary control — POST /api/device/operator additionally wraps this in the
 * rate_limits helper as belt-and-braces, per D6-7 / spec §6 PIN-1).
 *
 * Ordering matters for the AC "a 6th correct entry within the lockout still
 * fails": the lockout check happens BEFORE bcrypt ever runs, so a correct PIN
 * typed during a lockout window is refused without even being compared.
 *
 * The lockout row as a state machine (arithmetic in lib/staff/pinPolicy.ts):
 *   counting (no lock in force) —wrong→ counting, or locked at the threshold
 *   locked (locked_until ahead) —time→  counting at the same count, where one
 *                                       more wrong guess locks again, doubled
 *   counting —correct→ reset (0, no lock)
 *   any      —owner set / reset / unlock→ reset (setPin / unlockPin)
 * Every guess's write is a compare-and-set on failed_attempts, re-read and
 * retried when another guess got there first: no wrong guess is lost, and a
 * correct PIN never resets a lock that guesses racing it reached while it was
 * in bcrypt — it re-reads, sees the lock, and is refused like any other
 * attempt inside one.
 */
export async function verifyPin(userId: string, pin: string): Promise<PinVerifyResult> {
  const admin = createAdminSupabaseClient();
  const { pinHash, row, error } = await loadPinRow(admin, userId);
  if (error) {
    if (isMissingPinTable(error)) return { ok: false, reason: 'unavailable' };
    console.error('verifyPin: staff_pins lookup failed', error);
    return { ok: false, reason: 'unavailable' };
  }
  if (!row || !pinHash) return { ok: false, reason: 'no_pin' };

  let lockState: PinLockState = { failed_attempts: row.failed_attempts, locked_until: row.locked_until };
  const readAt = Date.now();
  if (isLockedOut(lockState, readAt)) {
    return { ok: false, reason: 'locked', retryAfterSeconds: lockoutSecondsRemaining(lockState, readAt) };
  }

  const matches = await bcrypt.compare(pin, pinHash);

  for (let round = 0; round < MAX_COUNTER_WRITES; round++) {
    const now = Date.now();
    // Guesses racing this one may have locked the PIN while bcrypt ran. From
    // here on this attempt is one made inside the lock: refused, and — like
    // any attempt inside a lock — not counted.
    if (isLockedOut(lockState, now)) {
      const retryAfterSeconds = lockoutSecondsRemaining(lockState, now);
      return matches ? { ok: false, reason: 'locked', retryAfterSeconds } : { ok: false, reason: 'wrong_pin', retryAfterSeconds };
    }
    if (matches) {
      const outcome = await writeCounter(admin, userId, lockState.failed_attempts, resetOnSuccess());
      // As before, a correct PIN is not refused because the tidy-up write failed.
      if (outcome !== 'lost') return { ok: true };
    } else {
      const next = applyFailedAttempt(lockState, now);
      const outcome = await writeCounter(admin, userId, lockState.failed_attempts, next);
      if (outcome !== 'lost') {
        return { ok: false, reason: 'wrong_pin', retryAfterSeconds: lockoutSecondsRemaining(next, now) };
      }
    }
    // Lost the race: another guess (or an owner unlock) wrote first. Re-read and go again.
    const fresh = await loadPinRow(admin, userId);
    if (fresh.error || !fresh.row) {
      if (fresh.error) console.error('verifyPin: staff_pins re-read failed', fresh.error);
      return matches ? { ok: false, reason: 'unavailable' } : { ok: false, reason: 'wrong_pin', retryAfterSeconds: 0 };
    }
    lockState = { failed_attempts: fresh.row.failed_attempts, locked_until: fresh.row.locked_until };
  }

  // Still contended after every round: other guesses are writing the counter
  // right now. A wrong guess reports what it would have done; a correct one is
  // not let through on a count it could not settle.
  const now = Date.now();
  console.error('verifyPin: attempt counter still contended after retries', { userId });
  if (matches) {
    return { ok: false, reason: 'locked', retryAfterSeconds: Math.max(1, lockoutSecondsRemaining(lockState, now)) };
  }
  return {
    ok: false,
    reason: 'wrong_pin',
    retryAfterSeconds: lockoutSecondsRemaining(applyFailedAttempt(lockState, now), now),
  };
}

/**
 * PIN-5: owner set/reset. `pin` has already passed pinFormatProblem() at the
 * route layer (caller's job — this function assumes a valid PIN and just
 * writes it). Always clears any lockout: a fresh PIN is a fresh start, not a
 * continuation of whoever last tried the old one.
 */
export async function setPin(
  userId: string,
  pin: string,
  setBy: string,
  action: PinAuditAction,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const format = pinFormatProblem(pin);
  if (format) return { ok: false, error: 'Invalid PIN' }; // defence in depth; route validates first
  const admin = createAdminSupabaseClient();
  const pin_hash = await hashPin(pin);
  const nowIso = new Date().toISOString();

  const { error } = await admin
    .from('staff_pins')
    .upsert(
      { user_id: userId, pin_hash, failed_attempts: 0, locked_until: null, set_by: setBy, updated_at: nowIso },
      { onConflict: 'user_id' },
    );
  if (error) {
    if (isMissingPinTable(error)) {
      return { ok: false, error: 'PIN migration not applied yet — run supabase/2026-08-staff-pins.sql' };
    }
    return { ok: false, error: error.message };
  }

  const { error: auditError } = await admin
    .from('pin_audit')
    .insert({ user_id: userId, action, performed_by: setBy });
  if (auditError) {
    // The PIN write already committed; a missing audit row is a paper-trail
    // gap, not a reason to tell the owner the PIN wasn't set.
    console.error('setPin: pin_audit insert failed', auditError);
  }

  return { ok: true };
}

/** PIN-5: unlock early (clears failed_attempts/locked_until without changing
 * the PIN itself). Audited the same as set/reset. */
export async function unlockPin(userId: string, performedBy: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from('staff_pins')
    .update({ failed_attempts: 0, locked_until: null, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error) {
    if (isMissingPinTable(error)) {
      return { ok: false, error: 'PIN migration not applied yet — run supabase/2026-08-staff-pins.sql' };
    }
    return { ok: false, error: error.message };
  }
  const { error: auditError } = await admin
    .from('pin_audit')
    .insert({ user_id: userId, action: 'unlock', performed_by: performedBy });
  if (auditError) console.error('unlockPin: pin_audit insert failed', auditError);
  return { ok: true };
}

/** Current lock state for the owner's team screen (PIN-5: "see lock state").
 * Never returns pin_hash. `hasPin: false` when no row exists yet. */
export async function getPinState(
  userId: string,
): Promise<{ hasPin: boolean; locked: boolean; retryAfterSeconds: number } | null> {
  const admin = createAdminSupabaseClient();
  const { row, error } = await loadPinRow(admin, userId);
  if (error) {
    if (isMissingPinTable(error)) return null;
    console.error('getPinState: staff_pins lookup failed', error);
    return null;
  }
  if (!row) return { hasPin: false, locked: false, retryAfterSeconds: 0 };
  const now = Date.now();
  const lockState: PinLockState = { failed_attempts: row.failed_attempts, locked_until: row.locked_until };
  return {
    hasPin: true,
    locked: isLockedOut(lockState, now),
    retryAfterSeconds: lockoutSecondsRemaining(lockState, now),
  };
}
