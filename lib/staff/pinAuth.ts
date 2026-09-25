// PIN-1/PIN-3/PIN-5 — the database + bcrypt half of staff PINs. The pure
// rules (format, trivial-PIN rejection, lockout arithmetic) live in
// lib/staff/pinPolicy.ts and are unit-tested without a database; this file
// wires them to staff_pins/pin_audit (supabase/2026-08-staff-pins.sql) and is
// exercised through the route tests that mock the admin client instead.

import 'server-only';
import bcrypt from 'bcryptjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import {
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
 * PIN-1's verify path, enforced server-side from the staff_pins ROW (the
 * primary control — POST /api/device/operator additionally wraps this in the
 * rate_limits helper as belt-and-braces, per D6-7 / spec §6 PIN-1).
 *
 * Ordering matters for the AC "a 6th correct entry within the lockout still
 * fails": the lockout check happens BEFORE bcrypt ever runs, so a correct PIN
 * typed during a lockout window is refused without even being compared.
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

  const now = Date.now();
  const lockState: PinLockState = { failed_attempts: row.failed_attempts, locked_until: row.locked_until };
  if (isLockedOut(lockState, now)) {
    return { ok: false, reason: 'locked', retryAfterSeconds: lockoutSecondsRemaining(lockState, now) };
  }

  const matches = await bcrypt.compare(pin, pinHash);
  if (matches) {
    const next = resetOnSuccess();
    const { error: updateError } = await admin
      .from('staff_pins')
      .update({ failed_attempts: next.failed_attempts, locked_until: next.locked_until, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (updateError) console.error('verifyPin: failed to reset attempt counter', updateError);
    return { ok: true };
  }

  const next = applyFailedAttempt(lockState, now);
  const { error: updateError } = await admin
    .from('staff_pins')
    .update({ failed_attempts: next.failed_attempts, locked_until: next.locked_until, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (updateError) console.error('verifyPin: failed to record failed attempt', updateError);

  return { ok: false, reason: 'wrong_pin', retryAfterSeconds: lockoutSecondsRemaining(next, now) };
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
