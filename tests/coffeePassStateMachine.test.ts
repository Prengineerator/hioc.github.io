import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { passState } from '@/lib/passes/rules';
import {
  canAdjustPass,
  canTransitionPassStatus,
  DERIVED_PASS_STATES,
  PASS_STATES,
  PASS_STATUS_TRANSITIONS,
  PASS_STORED_STATUSES,
  PASS_TERMINAL_STATUSES,
  writersOf,
  type PassStoredStatus,
} from '@/lib/passes/stateMachine';

// A HIOC Ritual pass (lib/passes/stateMachine.ts): the stored status the
// database writes, the two states derived from cups and dates, and the
// issuing trigger's new refusal to issue a pass on a cancelled sale.

describe('the stored status', () => {
  it('moves only as the database functions move it', () => {
    expect(PASS_STATUS_TRANSITIONS.map((t) => [t.from, t.to, t.writer])).toEqual([
      [null, 'active', 'coffee_pass_issue_on_paid'],
      ['active', 'refunded', 'coffee_pass_void_for_refund'],
      ['active', 'refunded', 'coffee_pass_return_on_order'],
      ['refunded', 'active', 'coffee_pass_restore_after_failed_refund'],
    ]);
    const froms: (PassStoredStatus | null)[] = [null, ...PASS_STORED_STATUSES];
    for (const from of froms) {
      for (const to of PASS_STORED_STATUSES) {
        const legal = PASS_STATUS_TRANSITIONS.some((t) => t.from === from && t.to === to);
        expect(canTransitionPassStatus(from, to).ok, `${from} → ${to}`).toBe(legal);
      }
    }
    expect(canTransitionPassStatus('active', 'refunded', 'coffee_pass_restore_after_failed_refund').ok).toBe(false);
  });

  it("'void' has no writer, and nothing leaves it", () => {
    expect(writersOf('void')).toEqual([]);
    expect(PASS_TERMINAL_STATUSES).toEqual(['void']);
    expect(PASS_STATUS_TRANSITIONS.some((t) => t.from === 'void')).toBe(false);
  });

  it('derives used_up and expired, never stores them', () => {
    expect(DERIVED_PASS_STATES).toEqual(['used_up', 'expired']);
    for (const s of DERIVED_PASS_STATES) expect((PASS_STORED_STATUSES as readonly string[]).includes(s)).toBe(false);
    expect([...PASS_STORED_STATUSES, ...DERIVED_PASS_STATES].sort()).toEqual([...PASS_STATES].sort());
  });
});

describe('the state a screen shows (passState)', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  const later = '2026-11-20T18:30:00Z';
  it('says refunded / void from the stored status, whatever the cups', () => {
    expect(passState({ status: 'refunded', expires_at: later, drinks_remaining: 5 }, now)).toBe('refunded');
    expect(passState({ status: 'void', expires_at: later, drinks_remaining: 5 }, now)).toBe('void');
  });
  it('derives the rest from an active pass', () => {
    expect(passState({ status: 'active', expires_at: later, drinks_remaining: 2 }, now)).toBe('active');
    expect(passState({ status: 'active', expires_at: later, drinks_remaining: 0 }, now)).toBe('used_up');
    expect(passState({ status: 'active', expires_at: '2026-11-01T00:00:00Z', drinks_remaining: 2 }, now)).toBe('expired');
  });
});

describe('who may change a pass', () => {
  it('a manager adjusts any pass whose stored status is active (used up or lapsed included)', () => {
    expect(canAdjustPass({ status: 'active' })).toBe(true);
    expect(canAdjustPass({ status: 'refunded' })).toBe(false);
    expect(canAdjustPass({ status: 'void' })).toBe(false);
  });
});

describe('the issuing trigger (supabase/2026-11-peripheral-money-state-machine.sql)', () => {
  const read = (f: string) => readFileSync(path.resolve(__dirname, '..', 'supabase', f), 'utf8');
  const fn = (sql: string) => {
    const start = sql.indexOf('create or replace function public.coffee_pass_issue_on_paid()');
    return sql.slice(start, sql.indexOf('end $$;', start) + 'end $$;'.length);
  };
  const next = fn(read('2026-11-peripheral-money-state-machine.sql'));
  const guard = /\n {2}-- 2026-11:[\s\S]*?\n {2}end if;\n/;

  it('refuses a cancelled or rejected sale order', () => {
    expect(next).toMatch(/if new\.status::text in \('rejected', 'cancelled'\) then\s+raise warning[^;]+;\s+return null;/);
  });

  it('is otherwise exactly the per-drink version', () => {
    expect(guard.test(next)).toBe(true);
    expect(next.replace(guard, '')).toBe(fn(read('2026-10-coffee-pass-per-drink.sql')));
  });
});
