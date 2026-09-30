import { describe, expect, it } from 'vitest';
import {
  addDaysToIstDate,
  daysBetweenIstDates,
  endOfIstDay,
  isWithinSendWindow,
  istDate,
  istDayStart,
  istHour,
  istMonthStart,
  istWeekStart,
} from '@/lib/marketing/ist';
import {
  applyVip,
  buildContactStats,
  customerKey,
  detectDrop,
  isValidOrderStatus,
  lifecycleStage,
  matchesAudience,
  stageThresholds,
  typicalGapDays,
  vipThreshold,
  weeklyActive,
  type ContactStatsContext,
  type ContactStatsInput,
} from '@/lib/marketing/segments';
import { DEFAULT_PLAYBOOKS } from '@/lib/marketing/types';
import type { ContactStats, StageThresholds, WeeklyPoint, WinbackParamsBundle } from '@/lib/marketing/types';

// Wednesday 30 Sep 2026, 11:30 IST.
const NOW = new Date('2026-09-30T06:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number, from: Date = NOW) => new Date(from.getTime() - n * DAY).toISOString();

const WINBACK: WinbackParamsBundle = {
  winback_1: { ...DEFAULT_PLAYBOOKS.winback_1.params },
  winback_2: { ...DEFAULT_PLAYBOOKS.winback_2.params },
  winback_3: { ...DEFAULT_PLAYBOOKS.winback_3.params },
};

const CTX: ContactStatsContext = {
  now: NOW,
  winback: WINBACK,
  points_expiry_days: 30,
  expiring_days_ahead: 5,
};

function input(over: Partial<ContactStatsInput> = {}): ContactStatsInput {
  return {
    phone: '+919876543210',
    user_id: 'u1',
    name: 'Asha Rao',
    role: 'customer',
    consent_opted_in: true,
    opt_out_listed: false,
    orders: [],
    points_rows: [],
    ...over,
  };
}

describe('IST helpers', () => {
  it('istDate reads the IST calendar day, not the UTC one', () => {
    expect(istDate('2026-09-30T18:29:59Z')).toBe('2026-09-30');
    expect(istDate('2026-09-30T18:30:00Z')).toBe('2026-10-01'); // IST midnight
  });

  it('istDayStart is midnight IST as a UTC instant', () => {
    expect(istDayStart('2026-09-30T06:00:00Z').toISOString()).toBe('2026-09-29T18:30:00.000Z');
    expect(istDayStart('2026-09-29T18:30:00Z').toISOString()).toBe('2026-09-29T18:30:00.000Z');
    expect(istDayStart('2026-09-29T18:29:59Z').toISOString()).toBe('2026-09-28T18:30:00.000Z');
  });

  it('istMonthStart is the 1st at midnight IST', () => {
    expect(istMonthStart('2026-09-30T06:00:00Z').toISOString()).toBe('2026-08-31T18:30:00.000Z');
    // 00:10 IST on 1 Oct is still 30 Sep in UTC, but it is October in IST.
    expect(istMonthStart('2026-09-30T18:40:00Z').toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('istHour is the IST wall-clock hour', () => {
    expect(istHour('2026-09-30T06:00:00Z')).toBe(11);
    expect(istHour('2026-09-30T18:29:00Z')).toBe(23);
    expect(istHour('2026-09-30T18:30:00Z')).toBe(0);
  });

  it('isWithinSendWindow is [start, end) in IST', () => {
    expect(isWithinSendWindow('2026-09-30T05:29:59Z', 11, 20)).toBe(false); // 10:59:59 IST
    expect(isWithinSendWindow('2026-09-30T05:30:00Z', 11, 20)).toBe(true); // 11:00 IST
    expect(isWithinSendWindow('2026-09-30T14:29:59Z', 11, 20)).toBe(true); // 19:59:59 IST
    expect(isWithinSendWindow('2026-09-30T14:30:00Z', 11, 20)).toBe(false); // 20:00 IST
    // An end of 24 runs to midnight.
    expect(isWithinSendWindow('2026-09-30T18:29:00Z', 11, 24)).toBe(true); // 23:59 IST
    expect(isWithinSendWindow('2026-09-30T18:30:00Z', 11, 24)).toBe(false); // 00:00 IST
  });

  it('addDaysToIstDate and daysBetweenIstDates are calendar arithmetic', () => {
    expect(addDaysToIstDate('2026-09-28', 7)).toBe('2026-10-05');
    expect(addDaysToIstDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysToIstDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(daysBetweenIstDates('2026-09-01', '2026-10-01')).toBe(30);
    expect(daysBetweenIstDates('2026-10-01', '2026-09-01')).toBe(-30);
  });

  it('istWeekStart is the Monday of the IST week, and Sunday belongs to the week before Monday', () => {
    expect(istWeekStart('2026-09-30T06:00:00Z')).toBe('2026-09-28'); // Wednesday
    expect(istWeekStart('2026-09-27T18:29:59Z')).toBe('2026-09-21'); // Sunday 23:59:59 IST
    expect(istWeekStart('2026-09-27T18:30:00Z')).toBe('2026-09-28'); // Monday 00:00 IST
    expect(istWeekStart('2026-09-28T06:00:00Z')).toBe('2026-09-28'); // the Monday itself
  });

  it('endOfIstDay is 23:59:59.999 IST, N days on — not 24h × N', () => {
    // Sent at 3pm IST on 5 Oct, valid 10 days → through the end of 15 Oct IST.
    const d = endOfIstDay('2026-10-05T09:30:00Z', 10);
    expect(d.toISOString()).toBe('2026-10-15T18:29:59.999Z');
    expect(istDate(d)).toBe('2026-10-15');
    expect(endOfIstDay('2026-10-05T09:30:00Z').toISOString()).toBe('2026-10-05T18:29:59.999Z');
  });

  it('endOfIstDay rolls over month ends', () => {
    expect(istDate(endOfIstDay('2026-09-30T06:00:00Z', 7))).toBe('2026-10-07');
  });
});

describe('typicalGapDays', () => {
  const stamps = (...ago: number[]) => ago.map((n) => daysAgo(n));

  it('is null with fewer than 3 orders', () => {
    expect(typicalGapDays([])).toBeNull();
    expect(typicalGapDays(stamps(10))).toBeNull();
    expect(typicalGapDays(stamps(10, 20))).toBeNull();
  });

  it('is the median gap between consecutive order days', () => {
    // 60, 50, 40, 20, 10 days ago → gaps 10, 10, 20, 10 → median 10
    expect(typicalGapDays(stamps(60, 50, 40, 20, 10))).toBe(10);
  });

  it('averages the two middle gaps when there is an even number of gaps', () => {
    // 100, 90, 70, 40, 0 days ago → gaps 10, 20, 30, 40 → median (20 + 30) / 2 = 25
    expect(typicalGapDays(stamps(100, 90, 70, 40, 0))).toBe(25);
  });

  it('counts two orders on the same IST day as one visit', () => {
    // Three orders but only two distinct days, 12 days apart → one gap of 12.
    const t = ['2026-09-10T05:00:00Z', '2026-09-10T09:00:00Z', '2026-09-22T05:00:00Z'];
    expect(typicalGapDays(t)).toBe(12);
  });

  it('is null when every order is on one day', () => {
    expect(typicalGapDays(['2026-09-10T05:00:00Z', '2026-09-10T06:00:00Z', '2026-09-10T07:00:00Z'])).toBeNull();
  });

  it('treats an IST day boundary as a day boundary (23:59 and 00:01 IST are two days)', () => {
    const t = ['2026-09-10T18:00:00Z', '2026-09-10T19:00:00Z', '2026-09-20T05:00:00Z']; // 23:30 on the 10th, 00:30 on the 11th IST
    // Distinct IST days: 10th, 11th, 20th → gaps 1, 9 → median 5
    expect(typicalGapDays(t)).toBe(5);
  });

  it('clamps to [2, 60]', () => {
    expect(typicalGapDays(stamps(3, 2, 1))).toBe(2); // daily: gaps 1, 1 → clamped up to 2
    expect(typicalGapDays(stamps(300, 200, 100))).toBe(60); // gaps 100, 100 → clamped down to 60
  });
});

describe('stageThresholds', () => {
  it('uses default_days when there is no rhythm', () => {
    expect(stageThresholds(null, WINBACK)).toEqual({
      stage1_days: 30,
      stage2_days: 60,
      stage3_days: 90,
      lost_after_days: 180,
    });
  });

  it('personalises: round(multiplier × gap), clamped to [min_days, max_days]', () => {
    expect(stageThresholds(10, WINBACK).stage1_days).toBe(25); // 2.5 × 10
    expect(stageThresholds(2, WINBACK).stage1_days).toBe(14); // 5 → clamped up to min 14
    expect(stageThresholds(60, WINBACK).stage1_days).toBe(45); // 150 → clamped down to max 45
    expect(stageThresholds(7, WINBACK).stage1_days).toBe(18); // 17.5 rounds to 18
  });

  it('stages 2 and 3 follow stage 1 by their offsets; lost is winback_3.max_days', () => {
    const t = stageThresholds(10, WINBACK);
    expect(t.stage2_days).toBe(25 + 30);
    expect(t.stage3_days).toBe(25 + 60);
    expect(t.lost_after_days).toBe(180);
  });

  it('respects edited params', () => {
    const t = stageThresholds(null, {
      winback_1: { gap_multiplier: 3, min_days: 7, max_days: 30, default_days: 21 },
      winback_2: { offset_days: 10 },
      winback_3: { offset_days: 20, max_days: 90 },
    });
    expect(t).toEqual({ stage1_days: 21, stage2_days: 31, stage3_days: 41, lost_after_days: 90 });
  });
});

describe('lifecycleStage (spec §1.2)', () => {
  // stage1 = 20 → stage2 = 50, stage3 = 80, lost = 180. 0.8 × 20 = 16.
  const t: StageThresholds = { stage1_days: 20, stage2_days: 50, stage3_days: 80, lost_after_days: 180 };

  it('no_orders without a valid order', () => {
    expect(lifecycleStage(0, null, t)).toBe('no_orders');
    expect(lifecycleStage(0, 5, t)).toBe('no_orders');
  });

  it('active below 0.8 × stage1, at_risk from there up to stage1 (boundaries are exact)', () => {
    expect(lifecycleStage(5, 0, t)).toBe('active');
    expect(lifecycleStage(5, 15, t)).toBe('active');
    expect(lifecycleStage(5, 16, t)).toBe('at_risk');
    expect(lifecycleStage(5, 19, t)).toBe('at_risk');
  });

  it('a non-integer 0.8 × stage1 boundary works in integers (stage1 = 14 → 11.2)', () => {
    const t14: StageThresholds = { stage1_days: 14, stage2_days: 44, stage3_days: 74, lost_after_days: 180 };
    expect(lifecycleStage(5, 11, t14)).toBe('active');
    expect(lifecycleStage(5, 12, t14)).toBe('at_risk');
  });

  it('lapsed_1 from stage1 up to stage2', () => {
    expect(lifecycleStage(5, 20, t)).toBe('lapsed_1');
    expect(lifecycleStage(5, 49, t)).toBe('lapsed_1');
  });

  it('lapsed_2 from stage2 up to stage3', () => {
    expect(lifecycleStage(5, 50, t)).toBe('lapsed_2');
    expect(lifecycleStage(5, 79, t)).toBe('lapsed_2');
  });

  it('lapsed_3 from stage3 up to lost_after, then lost', () => {
    expect(lifecycleStage(5, 80, t)).toBe('lapsed_3');
    expect(lifecycleStage(5, 179, t)).toBe('lapsed_3');
    expect(lifecycleStage(5, 180, t)).toBe('lost');
    expect(lifecycleStage(5, 400, t)).toBe('lost');
  });

  it('new = exactly one order and not yet lapsed; it wins over at_risk (table order)', () => {
    expect(lifecycleStage(1, 3, t)).toBe('new');
    expect(lifecycleStage(1, 18, t)).toBe('new'); // would be at_risk with more orders
    expect(lifecycleStage(1, 20, t)).toBe('lapsed_1'); // lapsing beats new
    expect(lifecycleStage(2, 3, t)).toBe('active');
  });

  it('a daily regular is lapsed after 14 days, a monthly visitor only after 45 (spec example)', () => {
    const daily = stageThresholds(2, WINBACK);
    const monthly = stageThresholds(30, WINBACK);
    expect(lifecycleStage(40, 14, daily)).toBe('lapsed_1');
    expect(lifecycleStage(12, 14, monthly)).toBe('active');
    expect(lifecycleStage(12, 44, monthly)).toBe('at_risk');
    expect(lifecycleStage(12, 45, monthly)).toBe('lapsed_1');
  });
});

describe('buildContactStats', () => {
  const order = (id: string, ago: number, total: number, status?: string) => ({ id, created_at: daysAgo(ago), total_inr: total, status });

  it('an empty contact is no_orders with zeros and nulls', () => {
    const s = buildContactStats(input(), CTX);
    expect(s).toMatchObject({
      order_count: 0,
      total_spend_inr: 0,
      aov_inr: 0,
      first_order_at: null,
      last_order_at: null,
      days_since_last_order: null,
      typical_gap_days: null,
      stage: 'no_orders',
      points_balance: 0,
      expiring_points: 0,
      expiry_date: null,
      vip: false,
    });
    expect(s.stage1_days).toBe(30);
  });

  it('computes count, spend, mean order value, first/last and elapsed days', () => {
    const s = buildContactStats(
      input({ orders: [order('a', 40, 200), order('b', 20, 300), order('c', 12, 250)] }),
      CTX,
    );
    expect(s.order_count).toBe(3);
    expect(s.total_spend_inr).toBe(750);
    expect(s.aov_inr).toBe(250);
    expect(s.days_since_last_order).toBe(12);
    expect(s.first_order_at).toBe(daysAgo(40));
    expect(s.last_order_at).toBe(daysAgo(12));
    // gaps 20, 8 → median 14 → stage1 = clamp(round(2.5 × 14)) = 35
    expect(s.typical_gap_days).toBe(14);
    expect(s.stage1_days).toBe(35);
    expect(s.stage).toBe('active');
  });

  it('rounds the mean order value to whole rupees', () => {
    const s = buildContactStats(input({ orders: [order('a', 5, 100), order('b', 4, 101)] }), CTX);
    expect(s.aov_inr).toBe(101); // 100.5 → 101
  });

  it('floors elapsed days (13.9 days is 13) and never goes negative', () => {
    const s = buildContactStats(input({ orders: [{ created_at: new Date(NOW.getTime() - 13.9 * DAY).toISOString(), total_inr: 100 }] }), CTX);
    expect(s.days_since_last_order).toBe(13);
    const future = buildContactStats(input({ orders: [{ created_at: new Date(NOW.getTime() + DAY).toISOString(), total_inr: 100 }] }), CTX);
    expect(future.days_since_last_order).toBe(0);
  });

  it('ignores cancelled and rejected orders, and counts one order id once', () => {
    const s = buildContactStats(
      input({
        orders: [
          order('a', 30, 200),
          order('a', 30, 200), // the same order matched by user id AND by phone
          order('b', 20, 999, 'cancelled'),
          order('c', 10, 999, 'rejected'),
          order('d', 5, 100, 'completed'),
        ],
      }),
      CTX,
    );
    expect(s.order_count).toBe(2);
    expect(s.total_spend_inr).toBe(300);
    expect(s.days_since_last_order).toBe(5);
  });

  it('skips orders with an unparseable date', () => {
    const s = buildContactStats(input({ orders: [{ created_at: 'not a date', total_inr: 100 }, order('a', 5, 100)] }), CTX);
    expect(s.order_count).toBe(1);
  });

  it('stages a single recent order as new and a lapsed one as lapsed_1', () => {
    expect(buildContactStats(input({ orders: [order('a', 3, 100)] }), CTX).stage).toBe('new');
    expect(buildContactStats(input({ orders: [order('a', 31, 100)] }), CTX).stage).toBe('lapsed_1'); // default 30
  });

  it('carries identity, consent and a template-ready first name through', () => {
    const s = buildContactStats(input({ name: '  priya   sharma ', role: null, opt_out_listed: true }), CTX);
    expect(s).toMatchObject({ phone: '+919876543210', user_id: 'u1', first_name: 'priya', role: null, consent_opted_in: true, opt_out_listed: true });
  });

  it('points: balance, ₹ value, expiring within days_ahead and 7 days, and the expiry date', () => {
    const s = buildContactStats(
      input({
        orders: [order('a', 2, 100)],
        points_rows: [
          { points: 40, created_at: daysAgo(27) }, // expires in 3 days
          { points: 30, created_at: daysAgo(20) }, // expires in 10 days
          { points: -10, created_at: daysAgo(1) }, // redeemed — eats the oldest first
        ],
      }),
      CTX,
    );
    expect(s.points_balance).toBe(60);
    expect(s.points_value_inr).toBe(60);
    expect(s.expiring_points).toBe(30); // 40 − 10 redeemed, due within 5 days
    expect(s.expiring_points_7d).toBe(30);
    // The oldest credit still has points left: 27 days ago + 30 days = 3 days from now.
    expect(s.expiry_date).toBe(istDate(new Date(NOW.getTime() + 3 * DAY)));
  });

  it('a wider window than the playbook sees more points (7 days vs days_ahead 2)', () => {
    const rows = [{ points: 50, created_at: daysAgo(25) }]; // expires in 5 days
    const s = buildContactStats(input({ points_rows: rows }), { ...CTX, expiring_days_ahead: 2 });
    expect(s.expiring_points).toBe(0);
    expect(s.expiring_points_7d).toBe(50);
  });

  it('never shows an expiry date in the past (a late expire job) — clamps to today', () => {
    const s = buildContactStats(input({ points_rows: [{ points: 40, created_at: daysAgo(35) }] }), CTX);
    expect(s.expiring_points).toBe(40);
    expect(s.expiry_date).toBe(istDate(NOW));
  });

  it('points that never expire (points_expiry_days 0) have no expiring points and no date', () => {
    const s = buildContactStats(input({ points_rows: [{ points: 40, created_at: daysAgo(90) }] }), { ...CTX, points_expiry_days: 0 });
    expect(s.points_balance).toBe(40);
    expect(s.expiring_points).toBe(0);
    expect(s.expiry_date).toBeNull();
  });

  it('values points at inr_per_point, floored', () => {
    const s = buildContactStats(input({ points_rows: [{ points: 25, created_at: daysAgo(1) }] }), { ...CTX, inr_per_point: 0.5 });
    expect(s.points_balance).toBe(25);
    expect(s.points_value_inr).toBe(12);
  });

  it('a negative ledger sum is a zero balance', () => {
    const s = buildContactStats(input({ points_rows: [{ points: -5, created_at: daysAgo(1) }] }), CTX);
    expect(s.points_balance).toBe(0);
  });
});

describe('isValidOrderStatus', () => {
  it('rejects cancelled and rejected only; an absent status is valid', () => {
    expect(isValidOrderStatus('completed')).toBe(true);
    expect(isValidOrderStatus('preparing')).toBe(true);
    expect(isValidOrderStatus(undefined)).toBe(true);
    expect(isValidOrderStatus('cancelled')).toBe(false);
    expect(isValidOrderStatus('rejected')).toBe(false);
  });
});

describe('vip', () => {
  const c = (order_count: number, total_spend_inr: number) => ({ order_count, total_spend_inr });

  it('is the top 20% by spend among contacts with ≥ 3 orders', () => {
    const pop = [
      c(10, 1000), c(9, 900), c(8, 800), c(7, 700), c(6, 600),
      c(5, 500), c(4, 400), c(3, 300), c(3, 200), c(3, 100),
    ];
    expect(vipThreshold(pop)).toBe(900); // ceil(10 × 0.2) = 2 → the 2nd biggest
    const flagged = applyVip(pop.map((p, i) => ({ ...stub(i), ...p })));
    expect(flagged.filter((x) => x.vip).map((x) => x.total_spend_inr)).toEqual([1000, 900]);
  });

  it('ignores contacts with fewer than 3 orders even when they spend the most', () => {
    const pop = [c(2, 99999), c(3, 300), c(4, 400)];
    expect(vipThreshold(pop)).toBe(400);
    const flagged = applyVip(pop.map((p, i) => ({ ...stub(i), ...p })));
    expect(flagged.map((x) => x.vip)).toEqual([false, false, true]);
  });

  it('one qualifying contact is the whole top 20%', () => {
    expect(vipThreshold([c(3, 300)])).toBe(300);
  });

  it('is null (and nobody is a VIP) when nobody has 3 orders', () => {
    const pop = [c(1, 500), c(2, 800)];
    expect(vipThreshold(pop)).toBeNull();
    expect(applyVip(pop.map((p, i) => ({ ...stub(i), ...p }))).some((x) => x.vip)).toBe(false);
    expect(vipThreshold([])).toBeNull();
  });

  it('ties at the line are all in', () => {
    const pop = [c(5, 500), c(5, 500), c(5, 500), c(5, 100), c(5, 100)]; // ceil(5 × 0.2) = 1 → line at 500
    const flagged = applyVip(pop.map((p, i) => ({ ...stub(i), ...p })));
    expect(flagged.filter((x) => x.vip)).toHaveLength(3);
  });

  it('does not mutate its input', () => {
    const pop = [{ ...stub(0), order_count: 5, total_spend_inr: 500 }];
    applyVip(pop);
    expect(pop[0].vip).toBe(false);
  });
});

function stub(i: number): ContactStats {
  return {
    phone: `+91987654${String(i).padStart(4, '0')}`,
    user_id: null,
    first_name: 'there',
    role: 'customer',
    consent_opted_in: true,
    opt_out_listed: false,
    order_count: 0,
    total_spend_inr: 0,
    aov_inr: 0,
    first_order_at: null,
    last_order_at: null,
    days_since_last_order: null,
    typical_gap_days: null,
    stage1_days: 30,
    stage: 'active',
    points_balance: 0,
    points_value_inr: 0,
    expiring_points: 0,
    expiring_value_inr: 0,
    expiry_date: null,
    expiring_points_7d: 0,
    expiring_value_7d_inr: 0,
    vip: false,
  };
}

describe('matchesAudience', () => {
  const contact = (over: Partial<ContactStats> = {}): ContactStats => ({
    ...stub(1),
    stage: 'lapsed_1',
    order_count: 5,
    total_spend_inr: 1500,
    days_since_last_order: 40,
    points_balance: 80,
    vip: true,
    ...over,
  });

  it('an empty filter matches everyone, including customers with no orders', () => {
    expect(matchesAudience(contact(), {})).toBe(true);
    expect(matchesAudience(contact({ stage: 'no_orders', order_count: 0, days_since_last_order: null }), {})).toBe(true);
    expect(matchesAudience(contact(), { stages: [] })).toBe(true);
  });

  it('stages: any of the listed', () => {
    expect(matchesAudience(contact(), { stages: ['lapsed_1', 'lapsed_2'] })).toBe(true);
    expect(matchesAudience(contact(), { stages: ['active'] })).toBe(false);
  });

  it('vip_only', () => {
    expect(matchesAudience(contact(), { vip_only: true })).toBe(true);
    expect(matchesAudience(contact({ vip: false }), { vip_only: true })).toBe(false);
  });

  it('min_orders, min_spend_inr and min_points are inclusive floors', () => {
    expect(matchesAudience(contact(), { min_orders: 5 })).toBe(true);
    expect(matchesAudience(contact(), { min_orders: 6 })).toBe(false);
    expect(matchesAudience(contact(), { min_spend_inr: 1500 })).toBe(true);
    expect(matchesAudience(contact(), { min_spend_inr: 1501 })).toBe(false);
    expect(matchesAudience(contact(), { min_points: 80 })).toBe(true);
    expect(matchesAudience(contact(), { min_points: 81 })).toBe(false);
  });

  it('last order between from and to days ago, inclusive at both ends', () => {
    expect(matchesAudience(contact(), { last_order_from_days: 40, last_order_to_days: 40 })).toBe(true);
    expect(matchesAudience(contact(), { last_order_from_days: 41 })).toBe(false);
    expect(matchesAudience(contact(), { last_order_to_days: 39 })).toBe(false);
    expect(matchesAudience(contact(), { last_order_from_days: 30, last_order_to_days: 60 })).toBe(true);
  });

  it('a customer with no orders never matches a last-order bound', () => {
    const none = contact({ stage: 'no_orders', order_count: 0, days_since_last_order: null });
    expect(matchesAudience(none, { last_order_from_days: 0 })).toBe(false);
    expect(matchesAudience(none, { last_order_to_days: 999 })).toBe(false);
  });

  it('every condition must hold together', () => {
    expect(matchesAudience(contact(), { stages: ['lapsed_1'], vip_only: true, min_points: 50 })).toBe(true);
    expect(matchesAudience(contact(), { stages: ['lapsed_1'], vip_only: true, min_points: 500 })).toBe(false);
  });
});

describe('weeklyActive (spec §1.9)', () => {
  const at = (iso: string, extra: Record<string, string | null> = {}) => ({ created_at: iso, user_id: null, customer_user_id: null, customer_phone: null, ...extra });

  it('returns the last 9 COMPLETE IST weeks, oldest first, zeros for empty weeks', () => {
    const series = weeklyActive([], NOW);
    expect(series).toHaveLength(9);
    expect(series[0].week_start).toBe('2026-07-27');
    expect(series[8].week_start).toBe('2026-09-21'); // the week containing NOW (28 Sep) is in progress and excluded
    expect(series.every((p) => p.customers === 0 && p.orders === 0)).toBe(true);
    expect(series.map((p) => p.week_start)).toEqual(
      [...series.map((p) => p.week_start)].sort(),
    );
  });

  it('a week runs Monday 00:00 IST to Sunday 23:59:59 IST', () => {
    const series = weeklyActive(
      [
        at('2026-09-20T18:29:59Z', { user_id: 'a' }), // Sun 20 Sep 23:59:59 IST → week of 14 Sep
        at('2026-09-20T18:30:00Z', { user_id: 'b' }), // Mon 21 Sep 00:00 IST → week of 21 Sep
        at('2026-09-27T18:29:59Z', { user_id: 'c' }), // Sun 27 Sep 23:59:59 IST → week of 21 Sep
        at('2026-09-27T18:30:00Z', { user_id: 'd' }), // Mon 28 Sep 00:00 IST → the current week: excluded
      ],
      NOW,
    );
    const byWeek = Object.fromEntries(series.map((p) => [p.week_start, p]));
    expect(byWeek['2026-09-14']).toMatchObject({ customers: 1, orders: 1 });
    expect(byWeek['2026-09-21']).toMatchObject({ customers: 2, orders: 2 });
    expect(series.reduce((s, p) => s + p.orders, 0)).toBe(3);
  });

  it('counts distinct customers, but every order', () => {
    const series = weeklyActive(
      [
        at('2026-09-22T05:00:00Z', { user_id: 'a' }),
        at('2026-09-23T05:00:00Z', { user_id: 'a' }),
        at('2026-09-24T05:00:00Z', { user_id: 'b' }),
      ],
      NOW,
    );
    expect(series[8]).toMatchObject({ week_start: '2026-09-21', customers: 2, orders: 3 });
  });

  it('identifies by user id, else counter-linked user id, else the normalised phone', () => {
    const series = weeklyActive(
      [
        at('2026-09-22T05:00:00Z', { user_id: 'a' }),
        at('2026-09-22T06:00:00Z', { customer_user_id: 'a' }), // same account, counter-linked → same customer
        at('2026-09-22T07:00:00Z', { customer_phone: '+919876543210' }),
        at('2026-09-22T08:00:00Z', { customer_phone: '9876543210' }), // same phone, older format
        at('2026-09-22T09:00:00Z', { customer_phone: '098765 43210' }),
      ],
      NOW,
    );
    expect(series[8].customers).toBe(2);
    expect(series[8].orders).toBe(5);
  });

  it('an anonymous walk-in is an order but not a customer', () => {
    const series = weeklyActive([at('2026-09-22T05:00:00Z'), at('2026-09-22T06:00:00Z', { customer_phone: 'nope' })], NOW);
    expect(series[8]).toMatchObject({ customers: 0, orders: 2 });
  });

  it('ignores orders older than the window and unparseable dates', () => {
    const series = weeklyActive([at('2026-01-05T05:00:00Z', { user_id: 'a' }), at('garbage', { user_id: 'b' })], NOW);
    expect(series.every((p) => p.orders === 0)).toBe(true);
  });

  it('honours a custom number of weeks', () => {
    expect(weeklyActive([], NOW, 4)).toHaveLength(4);
  });

  it('is independent of the time of day `now` falls on (Mon 00:00 IST still excludes that week)', () => {
    const mondayEarly = new Date('2026-09-27T18:31:00Z'); // Mon 28 Sep 00:01 IST
    const series = weeklyActive([at('2026-09-22T05:00:00Z', { user_id: 'a' })], mondayEarly);
    expect(series[8].week_start).toBe('2026-09-21');
    expect(series[8].customers).toBe(1);
  });
});

describe('customerKey', () => {
  it('prefers accounts over phones and is null for nobody', () => {
    expect(customerKey({ user_id: 'u', customer_phone: '9876543210' })).toBe('u:u');
    expect(customerKey({ customer_user_id: 'c' })).toBe('u:c');
    expect(customerKey({ customer_phone: '+919876543210' })).toBe('p:9876543210');
    expect(customerKey({})).toBeNull();
  });
});

describe('detectDrop (spec §1.9)', () => {
  const series = (customers: number[]): WeeklyPoint[] =>
    customers.map((c, i) => ({ week_start: addDaysToIstDate('2026-07-27', i * 7), customers: c, orders: c * 2 }));

  it('fires when last week is below (1 − pct/100) × the mean of the 4 weeks before', () => {
    // previous 4 = 100 each; last = 80; 15% threshold → 85
    const alert = detectDrop(series([50, 50, 50, 50, 100, 100, 100, 100, 80]), 15);
    expect(alert).toEqual({
      week_start: addDaysToIstDate('2026-07-27', 56),
      last_week_customers: 80,
      baseline_customers: 100,
      drop_pct: 20,
      drop_customers: 20,
    });
  });

  it('a week exactly on the threshold is not an alert (strictly below)', () => {
    expect(detectDrop(series([0, 0, 0, 0, 100, 100, 100, 100, 85]), 15)).toBeNull();
    expect(detectDrop(series([0, 0, 0, 0, 100, 100, 100, 100, 84]), 15)).not.toBeNull();
  });

  it('a fractional baseline is exact (mean of 100, 100, 100, 101 = 100.25)', () => {
    const a = detectDrop(series([0, 0, 0, 0, 100, 100, 100, 101, 60]), 15);
    expect(a?.baseline_customers).toBe(100.3); // 100.25 → 1 decimal
    expect(a?.drop_pct).toBe(40); // 1 − 60/100.25 = 40.1%
    expect(a?.drop_customers).toBe(40);
  });

  it('no alert when customers are up, flat or only slightly down', () => {
    expect(detectDrop(series([0, 0, 0, 0, 100, 100, 100, 100, 120]), 15)).toBeNull();
    expect(detectDrop(series([0, 0, 0, 0, 100, 100, 100, 100, 100]), 15)).toBeNull();
    expect(detectDrop(series([0, 0, 0, 0, 100, 100, 100, 100, 90]), 15)).toBeNull();
  });

  it('no alert without a baseline (nothing to drop from) or too few weeks', () => {
    expect(detectDrop(series([0, 0, 0, 0, 0, 0, 0, 0, 0]), 15)).toBeNull();
    expect(detectDrop(series([100, 100, 100, 0]), 15)).toBeNull(); // only 4 points
    expect(detectDrop([], 15)).toBeNull();
  });

  it('a wipe-out is a 100% drop', () => {
    const a = detectDrop(series([0, 0, 0, 0, 40, 40, 40, 40, 0]), 15);
    expect(a).toMatchObject({ last_week_customers: 0, drop_pct: 100, drop_customers: 40 });
  });

  it('only the 4 weeks before the last one form the baseline', () => {
    // An old huge week (500) must not lift the baseline.
    expect(detectDrop(series([500, 10, 10, 10, 10, 10]), 15)).toBeNull();
  });

  it('honours the configured threshold', () => {
    expect(detectDrop(series([0, 0, 0, 0, 100, 100, 100, 100, 70]), 40)).toBeNull(); // 30% down, needs 40
    expect(detectDrop(series([0, 0, 0, 0, 100, 100, 100, 100, 70]), 25)).not.toBeNull();
  });
});
