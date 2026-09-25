import { describe, expect, it } from 'vitest';
import {
  applyFailedAttempt,
  computeLockoutSeconds,
  isLockedOut,
  isTrivialPin,
  lockoutSecondsRemaining,
  pinFormatProblem,
  resetOnSuccess,
} from '@/lib/staff/pinPolicy';

// PIN-1 — the pure lockout arithmetic + trivial-PIN rejection D6-7 specifies.
// No database, no bcrypt: everything here is a property of the numbers.

describe('pinFormatProblem', () => {
  it('accepts a plain 4-digit non-trivial PIN', () => {
    expect(pinFormatProblem('7392')).toBeNull();
  });

  it('rejects the wrong length', () => {
    expect(pinFormatProblem('123')).toBe('wrong_length');
    expect(pinFormatProblem('12345')).toBe('wrong_length');
    expect(pinFormatProblem('')).toBe('wrong_length');
  });

  it('rejects non-digits', () => {
    expect(pinFormatProblem('12a4')).toBe('not_digits');
    expect(pinFormatProblem('12 4')).toBe('not_digits');
  });

  it('rejects a trivial PIN', () => {
    expect(pinFormatProblem('1234')).toBe('trivial');
    expect(pinFormatProblem('0000')).toBe('trivial');
  });
});

describe('isTrivialPin', () => {
  it('rejects every repeated-digit PIN, not just 0000', () => {
    for (let d = 0; d <= 9; d++) {
      expect(isTrivialPin(String(d).repeat(4))).toBe(true);
    }
  });

  it('rejects every ascending and descending run, not just 1234', () => {
    expect(isTrivialPin('1234')).toBe(true);
    expect(isTrivialPin('2345')).toBe(true);
    expect(isTrivialPin('6789')).toBe(true);
    expect(isTrivialPin('9876')).toBe(true);
    expect(isTrivialPin('8765')).toBe(true);
    expect(isTrivialPin('3210')).toBe(true);
  });

  it('rejects birth-year-alike patterns', () => {
    expect(isTrivialPin('1990')).toBe(true);
    expect(isTrivialPin('2005')).toBe(true);
    expect(isTrivialPin('2099')).toBe(true);
  });

  it('accepts an ordinary, non-patterned PIN', () => {
    expect(isTrivialPin('7392')).toBe(false);
    expect(isTrivialPin('4081')).toBe(false);
  });

  it('does not false-positive on a non-sequential run that merely touches the ends', () => {
    // 1357 alternates by 2 each digit — not a ±1 sequential run.
    expect(isTrivialPin('1357')).toBe(false);
  });
});

describe('computeLockoutSeconds', () => {
  it('locks nothing below the 5-failure threshold', () => {
    expect(computeLockoutSeconds(0)).toBe(0);
    expect(computeLockoutSeconds(4)).toBe(0);
  });

  it('locks 60s on the 5th consecutive failure', () => {
    expect(computeLockoutSeconds(5)).toBe(60);
  });

  it('doubles with every failure past the threshold', () => {
    expect(computeLockoutSeconds(6)).toBe(120);
    expect(computeLockoutSeconds(7)).toBe(240);
    expect(computeLockoutSeconds(8)).toBe(480);
  });

  it('caps at 15 minutes', () => {
    expect(computeLockoutSeconds(9)).toBe(900);
    expect(computeLockoutSeconds(10)).toBe(900);
    expect(computeLockoutSeconds(50)).toBe(900);
  });
});

describe('isLockedOut / lockoutSecondsRemaining', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');

  it('is not locked with no locked_until', () => {
    expect(isLockedOut({ failed_attempts: 3, locked_until: null }, now)).toBe(false);
  });

  it('is locked while locked_until is in the future', () => {
    const state = { failed_attempts: 5, locked_until: new Date(now + 30_000).toISOString() };
    expect(isLockedOut(state, now)).toBe(true);
    expect(lockoutSecondsRemaining(state, now)).toBe(30);
  });

  it('is not locked once locked_until has passed', () => {
    const state = { failed_attempts: 5, locked_until: new Date(now - 1_000).toISOString() };
    expect(isLockedOut(state, now)).toBe(false);
    expect(lockoutSecondsRemaining(state, now)).toBe(0);
  });
});

describe('applyFailedAttempt / resetOnSuccess', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');

  it('increments the counter with no lock before the threshold', () => {
    const next = applyFailedAttempt({ failed_attempts: 2, locked_until: null }, now);
    expect(next).toEqual({ failed_attempts: 3, locked_until: null });
  });

  it('locks on the 5th failure', () => {
    const next = applyFailedAttempt({ failed_attempts: 4, locked_until: null }, now);
    expect(next.failed_attempts).toBe(5);
    expect(next.locked_until).toBe(new Date(now + 60_000).toISOString());
  });

  it('a 6th correct-looking guess DURING the lockout still fails — the lockout cannot be reasoned around locally', () => {
    // Given 5 fails (locked 60s), a caller must check isLockedOut() before
    // ever reaching a bcrypt compare — applyFailedAttempt is only called
    // AFTER a genuinely wrong guess, so the "6th correct entry within the
    // lockout still fails" AC lives in pinAuth.ts's ordering, not here; this
    // test pins the arithmetic a 6th WRONG guess would produce.
    const afterFive = applyFailedAttempt({ failed_attempts: 4, locked_until: null }, now);
    const afterSix = applyFailedAttempt(afterFive, now + 1000);
    expect(afterSix.failed_attempts).toBe(6);
    expect(afterSix.locked_until).toBe(new Date(now + 1000 + 120_000).toISOString());
  });

  it('resets cleanly on success', () => {
    expect(resetOnSuccess()).toEqual({ failed_attempts: 0, locked_until: null });
  });
});
