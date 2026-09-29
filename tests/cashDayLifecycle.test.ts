import { describe, expect, it } from 'vitest';
import {
  capDenoms,
  cashReasonProblem,
  evaluateClose,
  evaluateOpen,
  formatCountDiff,
  matchDenoms,
  matchTotalDiffInr,
  splitHandover,
  unpaidGate,
  zeroCountNeedsConfirm,
} from '@/lib/cash/day';
import { expectedCashInr, overShortInr } from '@/lib/cash/denoms';

// Pure rules for the cash day lifecycle (Open → Close → Handover), no mocks:
// expected cash, variance, the per-denomination Match column, the handover
// split, the unpaid-order gate and the ₹0-count guard. The SAME functions run
// in the close form and in PATCH /api/cash-days.

describe('expected cash over [opened_at, close]', () => {
  it('= float + cash sales − cash refunds + cash in − cash out', () => {
    expect(expectedCashInr(1500, 4200, 300, 500, 2000)).toBe(3900);
  });

  it('cash in/out default to 0 (pre-handover callers)', () => {
    expect(expectedCashInr(5000, 500, 100)).toBe(5400);
  });

  it('variance = counted − expected', () => {
    expect(overShortInr(3900, 3900)).toBe(0);
    expect(overShortInr(3800, 3900)).toBe(-100);
  });
});

describe('Match column', () => {
  const expected = { '500': 2, '100': 5, '10': 10 };

  it('shows the count difference per denomination', () => {
    const rows = matchDenoms({ '500': 2, '100': 3, '10': 11 }, expected);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['500'].diff).toBe(0);
    expect(byKey['100']).toMatchObject({ expected: 5, actual: 3, diff: -2 });
    expect(byKey['10'].diff).toBe(1);
    expect(byKey['1'].diff).toBe(0); // rows nobody expected or counted still match
    expect(rows).toHaveLength(9);
  });

  it('total difference is in rupees (actual − expected)', () => {
    // 2×500 + 3×100 + 11×10 = 1410 vs 1000 + 500 + 100 = 1600
    expect(matchTotalDiffInr({ '500': 2, '100': 3, '10': 11 }, expected)).toBe(-190);
    expect(matchTotalDiffInr(expected, expected)).toBe(0);
  });

  it('formats ✓ / +n / −n', () => {
    expect(formatCountDiff(0)).toBe('✓');
    expect(formatCountDiff(2)).toBe('+2');
    expect(formatCountDiff(-1)).toBe('−1');
  });

  it('tolerates garbage counts', () => {
    const rows = matchDenoms({ '500': -3, '100': 'x' } as never, null);
    expect(rows.every((r) => r.diff === 0)).toBe(true);
  });
});

describe('evaluateOpen', () => {
  it('has nothing to compare with when the last close left no float', () => {
    expect(evaluateOpen({ countedInr: 1500, floatLeftInr: null, reason: '' })).toEqual({
      differenceInr: null,
      expectedFloatInr: null,
      problem: null,
    });
  });

  it('a matching float needs no reason', () => {
    const r = evaluateOpen({ countedInr: 1500, floatLeftInr: 1500, reason: '' });
    expect(r.differenceInr).toBe(0);
    expect(r.problem).toBeNull();
  });

  it('any difference (over or short) needs a reason', () => {
    expect(evaluateOpen({ countedInr: 1300, floatLeftInr: 1500, reason: '' }).problem).toMatch(/reason/i);
    expect(evaluateOpen({ countedInr: 1700, floatLeftInr: 1500, reason: 'ok' }).problem).toMatch(/reason/i);
    const ok = evaluateOpen({ countedInr: 1300, floatLeftInr: 1500, reason: 'owner took ₹200 for milk' });
    expect(ok.problem).toBeNull();
    expect(ok.differenceInr).toBe(-200);
  });
});

describe('handover split', () => {
  it('cash taken out = counted − float left (computed, not typed)', () => {
    const counted = { '500': 7, '100': 10, '10': 20 }; // 3500 + 1000 + 200 = 4700
    const floatLeft = { '100': 10, '10': 20 }; // 1200
    const s = splitHandover(counted, floatLeft);
    expect(s.countedInr).toBe(4700);
    expect(s.floatLeftInr).toBe(1200);
    expect(s.takenOutInr).toBe(3500);
    expect(s.ok).toBe(true);
  });

  it('flags every denomination where more is left than counted', () => {
    const s = splitHandover({ '500': 1, '100': 2 }, { '500': 2, '100': 2, '50': 1 });
    expect(s.ok).toBe(false);
    expect(s.exceeds.map((e) => e.key)).toEqual(['500', '50']);
    expect(s.exceeds[0]).toMatchObject({ counted: 1, floatLeft: 2 });
  });

  it('capDenoms prefills the float with the previous float, capped at what was counted', () => {
    const previousFloat = { '500': 2, '100': 10, '10': 30 };
    const counted = { '500': 1, '100': 12, '10': 5 };
    expect(capDenoms(previousFloat, counted)).toEqual({
      '500': 1,
      '200': 0,
      '100': 10,
      '50': 0,
      '20': 0,
      '10': 5,
      '5': 0,
      '2': 0,
      '1': 0,
    });
    // Nothing counted yet → nothing can be left.
    expect(splitHandover({}, capDenoms(previousFloat, {})).floatLeftInr).toBe(0);
  });
});

describe('unpaidGate', () => {
  it('lets a close through when nothing is unpaid', () => {
    expect(unpaidGate({ unpaidCount: 0, isManager: false, overrideReason: '' }).allowed).toBe(true);
  });

  it('blocks a close while orders are unpaid', () => {
    const g = unpaidGate({ unpaidCount: 3, isManager: true, overrideReason: '' });
    expect(g.allowed).toBe(false);
    expect(g.code).toBe('UNPAID_ORDERS');
    expect(g.message).toMatch(/3 unpaid orders/);
  });

  it('a plain staffer cannot override, even with a reason', () => {
    const g = unpaidGate({ unpaidCount: 1, isManager: false, overrideReason: 'customer left without paying' });
    expect(g.allowed).toBe(false);
    expect(g.code).toBe('UNPAID_OVERRIDE_FORBIDDEN');
  });

  it('a manager can override with a real reason', () => {
    expect(unpaidGate({ unpaidCount: 1, isManager: true, overrideReason: 'ok' }).code).toBe('UNPAID_OVERRIDE_REASON');
    const g = unpaidGate({ unpaidCount: 1, isManager: true, overrideReason: 'customer left without paying' });
    expect(g).toMatchObject({ allowed: true, overridden: true });
  });
});

describe('zero-count guard', () => {
  it('needs an extra confirmation only when ₹0 is counted while cash is expected', () => {
    expect(zeroCountNeedsConfirm(0, 2500)).toBe(true);
    expect(zeroCountNeedsConfirm(0, 0)).toBe(false);
    expect(zeroCountNeedsConfirm(100, 2500)).toBe(false);
  });
});

describe('evaluateClose', () => {
  const base = {
    openingTotalInr: 1500,
    flows: { cashSalesInr: 3000, cashRefundsInr: 200, cashInInr: 0, cashOutInr: 300 },
    closingDenoms: { '500': 8, '100': 10, '10': 0 }, // 5000
    floatLeftDenoms: { '500': 2, '100': 5 }, // 1500
    closeReason: '',
    confirmZeroCount: false,
    unpaidCount: 0,
    isManager: false,
    unpaidOverrideReason: '',
  };

  it('a clean close: expected 4000 vs counted 5000 needs a reason, computes the handover', () => {
    const e = evaluateClose(base);
    expect(e.expectedInr).toBe(1500 + 3000 - 200 - 300);
    expect(e.countedInr).toBe(5000);
    expect(e.varianceInr).toBe(1000);
    expect(e.floatLeftInr).toBe(1500);
    expect(e.takenOutInr).toBe(3500);
    expect(e.problems.map((p) => p.code)).toEqual(['REASON_REQUIRED']);
    expect(evaluateClose({ ...base, closeReason: 'owner added cash, not recorded' }).problems).toEqual([]);
  });

  it('ties out: counted equals expected, no reason needed', () => {
    const tie = evaluateClose({
      ...base,
      closingDenoms: { '500': 5 }, // 2500 = 1500 float + 1000 sales
      flows: { cashSalesInr: 1000, cashRefundsInr: 0, cashInInr: 0, cashOutInr: 0 },
      floatLeftDenoms: { '500': 3 },
    });
    expect(tie.expectedInr).toBe(2500);
    expect(tie.varianceInr).toBe(0);
    expect(tie.problems).toEqual([]);
    expect(tie.takenOutInr).toBe(1000);
  });

  it('counted ₹0 while cash is expected needs the explicit confirmation, then a reason for the variance', () => {
    const zero = { ...base, closingDenoms: {}, floatLeftDenoms: {} };
    expect(evaluateClose(zero).problems.map((p) => p.code)).toEqual(['ZERO_COUNT_UNCONFIRMED', 'REASON_REQUIRED']);
    const confirmed = evaluateClose({ ...zero, confirmZeroCount: true, closeReason: 'cash already banked' });
    expect(confirmed.problems).toEqual([]);
    expect(confirmed.takenOutInr).toBe(0);
  });

  it('rejects a float left that exceeds the count, per denomination', () => {
    const e = evaluateClose({ ...base, closeReason: 'x'.repeat(6), floatLeftDenoms: { '500': 9 } });
    expect(e.problems[0].code).toBe('FLOAT_EXCEEDS_COUNT');
  });

  it('unpaid orders block; only a manager override with a reason releases it', () => {
    const withReason = { ...base, closeReason: 'owner added cash, not recorded', unpaidCount: 2 };
    expect(evaluateClose(withReason).problems.map((p) => p.code)).toEqual(['UNPAID_ORDERS']);
    expect(
      evaluateClose({ ...withReason, unpaidOverrideReason: 'walk-outs, owner informed' }).problems.map((p) => p.code),
    ).toEqual(['UNPAID_OVERRIDE_FORBIDDEN']);
    const released = evaluateClose({ ...withReason, isManager: true, unpaidOverrideReason: 'walk-outs, owner informed' });
    expect(released.problems).toEqual([]);
    expect(released.overridden).toBe(true);
  });
});

describe('cashReasonProblem', () => {
  it('needs a few real characters, not "ok"', () => {
    expect(cashReasonProblem('', 'x')).not.toBeNull();
    expect(cashReasonProblem('  ok ', 'x')).not.toBeNull();
    expect(cashReasonProblem('two notes stuck', 'x')).toBeNull();
    expect(cashReasonProblem('a'.repeat(301), 'x')).not.toBeNull();
  });
});
