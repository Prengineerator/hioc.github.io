// PIN-1 — the pure policy rules for staff PINs (docs/PHASE-6-SPEC.md §6, D6-7).
//
// Deliberately free of any Supabase/bcrypt/next import so every rule here is
// unit-testable without a database or a request: format, trivial-PIN
// rejection, and the lockout arithmetic. The DB- and bcrypt-touching half
// (hashing, reading/writing staff_pins, pin_audit) lives in
// lib/staff/pinAuth.ts.

/** D6-7: a PIN is exactly 4 digits. (The task brief that spawned this ticket
 * floated "4-6 digits" as an example range, but docs/PHASE-6-SPEC.md is
 * explicit and repeated on this — D6-7, PIN-1, PIN-2's AC all say "4 digits" —
 * so the spec's concrete decision wins over the paraphrase.) */
export const PIN_LENGTH = 4;

/** 5 consecutive failures locks the PIN; before that, a wrong guess just
 * increments the counter with no lockout (D6-7). */
export const LOCKOUT_THRESHOLD = 5;
/** First lockout duration, once the threshold is reached. */
export const LOCKOUT_BASE_SECONDS = 60;
/** Lockout doubles with every failure past the threshold, capped at 15 min. */
export const LOCKOUT_MAX_SECONDS = 15 * 60;

export type PinFormatProblem =
  | 'wrong_length'
  | 'not_digits'
  | 'trivial';

/**
 * Format + strength check ONLY — never touches a database or a lockout
 * counter. Used both when the owner sets/resets a PIN (PIN-5, where a trivial
 * PIN must be refused outright) and as a cheap first gate before a verify
 * attempt ever reaches bcrypt.
 */
export function pinFormatProblem(pin: string): PinFormatProblem | null {
  if (pin.length !== PIN_LENGTH) return 'wrong_length';
  if (!/^\d+$/.test(pin)) return 'not_digits';
  if (isTrivialPin(pin)) return 'trivial';
  return null;
}

export function pinFormatMessage(problem: PinFormatProblem): string {
  switch (problem) {
    case 'wrong_length':
      return `PIN must be exactly ${PIN_LENGTH} digits`;
    case 'not_digits':
      return 'PIN must contain only digits';
    case 'trivial':
      return 'That PIN is too easy to guess — choose one that is not repeated, sequential, or a birth year';
  }
}

/**
 * D6-7 / PIN-1: "0000, 1234, birth-year-alike patterns 19xx/20xx" rejected at
 * set time. Extended to cover every repeated-digit and every
 * ascending/descending run of PIN_LENGTH digits, not just the two named
 * examples — "1234" naming the pattern means the whole family of sequential
 * runs (2345, 3456, ... and their mirror 9876, 8765, ...) is the actual rule,
 * not a one-item blocklist.
 */
export function isTrivialPin(pin: string): boolean {
  if (pin.length !== PIN_LENGTH || !/^\d+$/.test(pin)) return true; // fail closed

  // All the same digit: 0000, 1111, ... 9999.
  if (new Set(pin.split('')).size === 1) return true;

  // Ascending or descending run: each digit exactly ±1 from the last.
  const digits = pin.split('').map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return true;

  // Birth-year-alike: looks like a year from 1900-2099. Only meaningful for
  // 4-digit PINs (PIN_LENGTH), which is the only length the spec defines.
  if (PIN_LENGTH === 4 && /^(19|20)\d{2}$/.test(pin)) return true;

  return false;
}

/**
 * D6-7's lockout arithmetic: below the threshold, no lock. At/above it, the
 * lock doubles with each additional failure, capped at 15 minutes.
 *
 * `failedAttempts` is the counter's value AFTER the failure that just
 * happened (i.e. call this once staff_pins.failed_attempts has already been
 * incremented in memory), so `computeLockoutSeconds(5)` is the "5 consecutive
 * failures" case the spec names, and returns the first lock.
 */
export function computeLockoutSeconds(failedAttempts: number): number {
  if (failedAttempts < LOCKOUT_THRESHOLD) return 0;
  const doublings = failedAttempts - LOCKOUT_THRESHOLD;
  const seconds = LOCKOUT_BASE_SECONDS * 2 ** doublings;
  return Math.min(seconds, LOCKOUT_MAX_SECONDS);
}

export interface PinLockState {
  failed_attempts: number;
  locked_until: string | null;
}

/** Whether `state` is CURRENTLY locked, given the row and the current time
 * (injected so this stays pure/testable — no `Date.now()` inside). */
export function isLockedOut(state: PinLockState, nowMs: number): boolean {
  if (!state.locked_until) return false;
  const until = Date.parse(state.locked_until);
  return Number.isFinite(until) && until > nowMs;
}

/** Seconds remaining on a lockout, for the "try again in Xs" message. 0 when
 * not locked. */
export function lockoutSecondsRemaining(state: PinLockState, nowMs: number): number {
  if (!isLockedOut(state, nowMs)) return 0;
  const until = Date.parse(state.locked_until as string);
  return Math.ceil((until - nowMs) / 1000);
}

/**
 * The next lockout row after ONE MORE wrong guess. Pure — the caller
 * (lib/staff/pinAuth.ts) persists the result. `nowMs` is the failure's
 * timestamp, injected for testability.
 */
export function applyFailedAttempt(state: PinLockState, nowMs: number): PinLockState {
  const failed_attempts = state.failed_attempts + 1;
  const lockoutSeconds = computeLockoutSeconds(failed_attempts);
  const locked_until = lockoutSeconds > 0 ? new Date(nowMs + lockoutSeconds * 1000).toISOString() : state.locked_until;
  return { failed_attempts, locked_until };
}

/** The row after a SUCCESSFUL verify — always resets the counter and clears
 * any lock, even one that had already expired (tidy state, and PIN-1's AC:
 * "the correct PIN works and resets the counter"). */
export function resetOnSuccess(): PinLockState {
  return { failed_attempts: 0, locked_until: null };
}
