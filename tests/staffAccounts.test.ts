import { describe, it, expect } from 'vitest';
import {
  normalizeLoginId,
  loginEmailFor,
  normalizePersonalEmail,
  passwordProblem,
  HISTORY_CHECKS,
} from '@/lib/staff/accounts';

// The login ID is <id>@hioc.in and is NOT a mailbox; the personal email is
// where every staff email goes. These rules are shared by the owner APIs, the
// team screen and the forgot-password flow, so they are pinned here once.

describe('normalizeLoginId', () => {
  it('accepts a bare ID or the full hioc.in address, any case', () => {
    expect(normalizeLoginId('ayush')).toBe('ayush');
    expect(normalizeLoginId('  Ayush.Garg ')).toBe('ayush.garg');
    expect(normalizeLoginId('AYUSH@HIOC.IN')).toBe('ayush');
  });

  it('refuses another domain — a login ID is always @hioc.in', () => {
    expect(normalizeLoginId('ayush@gmail.com')).toBeNull();
  });

  it('matches the SQL CHECK: starts with a letter, 2–30 chars of [a-z0-9._-]', () => {
    expect(normalizeLoginId('a')).toBeNull();
    expect(normalizeLoginId('1ayush')).toBeNull();
    expect(normalizeLoginId('ay ush')).toBeNull();
    expect(normalizeLoginId('a'.repeat(30))).toBe('a'.repeat(30));
    expect(normalizeLoginId('a'.repeat(31))).toBeNull();
    expect(normalizeLoginId('')).toBeNull();
    expect(normalizeLoginId(undefined)).toBeNull();
  });
});

describe('loginEmailFor', () => {
  it('builds the auth email', () => {
    expect(loginEmailFor('ayush')).toBe('ayush@hioc.in');
  });
});

describe('normalizePersonalEmail', () => {
  it('accepts a real address, lower-cased', () => {
    expect(normalizePersonalEmail(' Ayush@Gmail.com ')).toBe('ayush@gmail.com');
  });

  it('refuses a hioc.in address — that is a login ID, mail to it vanishes', () => {
    expect(normalizePersonalEmail('ayush@hioc.in')).toBeNull();
    expect(normalizePersonalEmail('Ayush@HIOC.IN')).toBeNull();
  });

  it('refuses garbage', () => {
    expect(normalizePersonalEmail('not-an-email')).toBeNull();
    expect(normalizePersonalEmail('')).toBeNull();
    expect(normalizePersonalEmail(null)).toBeNull();
  });
});

describe('passwordProblem', () => {
  it('requires 8–72 characters', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/);
    expect(passwordProblem('longenough')).toBeNull();
    expect(passwordProblem('x'.repeat(73))).toMatch(/at most 72/);
    expect(passwordProblem(undefined)).not.toBeNull();
  });
});

describe('HISTORY_CHECKS', () => {
  it('covers every table whose rows would be lost or orphaned by a delete', () => {
    const keys = HISTORY_CHECKS.map((c) => `${c.table}.${c.column}`);
    for (const k of [
      'attendance_sessions.user_id',
      'staff_employment.user_id',
      'payroll_run_lines.user_id',
      'leave_requests.user_id',
      'orders.created_by',
    ]) {
      expect(keys).toContain(k);
    }
  });
});
