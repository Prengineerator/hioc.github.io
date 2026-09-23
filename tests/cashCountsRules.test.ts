import { describe, it, expect } from 'vitest';
import {
  expectedAtCount,
  shortageToCharge,
  overrideReasonProblem,
  kindForPunch,
} from '@/lib/cash/counts';

// The pure money rules behind the clock-in / clock-out cash count
// (docs/PHASE-5-CASH-COUNTS.md). A shortage here becomes a deduction on
// someone's salary once the owner approves it, so every branch is pinned.

describe('expectedAtCount', () => {
  it('previous counted + settled − refunded − cash out + cash in', () => {
    expect(
      expectedAtCount(2000, { cashSettledInr: 1500, cashRefundedInr: 100, cashOutInr: 1000, cashInInr: 500 }),
    ).toBe(2900);
  });

  it('with no activity, the drawer should hold exactly what was last counted', () => {
    expect(expectedAtCount(3120, { cashSettledInr: 0, cashRefundedInr: 0, cashOutInr: 0, cashInInr: 0 })).toBe(3120);
  });
});

describe('shortageToCharge', () => {
  it('charges nothing for an exact count or an overage', () => {
    expect(shortageToCharge(0, 0)).toBe(0);
    expect(shortageToCharge(250, 0)).toBe(0);
  });

  it('charges nothing without a previous count to compare with', () => {
    expect(shortageToCharge(null, 0)).toBe(0);
  });

  it('with ₹0 tolerance, any shortfall is charged', () => {
    expect(shortageToCharge(-1, 0)).toBe(1);
    expect(shortageToCharge(-340, 0)).toBe(340);
  });

  it('a shortfall within tolerance is recorded but not charged', () => {
    expect(shortageToCharge(-5, 10)).toBe(0);
    expect(shortageToCharge(-10, 10)).toBe(0);
  });

  it('beyond tolerance, the WHOLE shortfall is charged — tolerance is not an allowance', () => {
    expect(shortageToCharge(-11, 10)).toBe(11);
    expect(shortageToCharge(-500, 10)).toBe(500);
  });

  it('a negative tolerance is treated as zero', () => {
    expect(shortageToCharge(-3, -50)).toBe(3);
  });
});

describe('overrideReasonProblem', () => {
  it('needs a real reason', () => {
    expect(overrideReasonProblem('ok')).not.toBeNull();
    expect(overrideReasonProblem('   ')).not.toBeNull();
    expect(overrideReasonProblem(undefined)).not.toBeNull();
    expect(overrideReasonProblem('Rush at close, counted by manager')).toBeNull();
    expect(overrideReasonProblem('x'.repeat(301))).not.toBeNull();
  });
});

describe('kindForPunch', () => {
  it('maps punch type to checkpoint kind', () => {
    expect(kindForPunch('in')).toBe('clock_in');
    expect(kindForPunch('out')).toBe('clock_out');
  });
});
