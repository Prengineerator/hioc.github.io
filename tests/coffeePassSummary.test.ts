import { describe, expect, it } from 'vitest';
import {
  buildPassSummary,
  maskPhone,
  parseSummaryRange,
  summaryRangeBounds,
  toSummaryPassRow,
  SUMMARY_MAX_DAYS,
  SUMMARY_RECENT_LIMIT,
  type SummaryPassRow,
  type SummaryRedemptionRow,
} from '@/lib/passes/summary';

// lib/passes/summary.ts: the owner's HIOC Ritual numbers, as pure math. The route
// (tests/coffeePassOwnerRoutes.test.ts) only fetches; every rule is pinned here.

// "Now" is 2026-10-15 10:00 IST. The range under test is 2026-10-01 .. 2026-10-14
// (IST days, both inclusive): [2026-09-30T18:30Z, 2026-10-14T18:30Z).
const NOW = new Date('2026-10-15T04:30:00Z');
const FROM = '2026-10-01';
const TO = '2026-10-14';

let n = 0;
function pass(over: Partial<SummaryPassRow> = {}): SummaryPassRow {
  n += 1;
  return {
    id: `pass-${n}`,
    user_id: `user-${n}`,
    plan_name: 'Weekly Ritual',
    drinks_total: 7,
    drinks_remaining: 7,
    price_inr: 750,
    status: 'active',
    // Sold at 12:00 IST on 5 Oct, expires 00:00 IST on 12 Oct: all inside the range.
    created_at: '2026-10-05T06:30:00.000Z',
    expires_at: '2026-10-11T18:30:00.000Z',
    ...over,
  };
}

function redemption(over: Partial<SummaryRedemptionRow> = {}): SummaryRedemptionRow {
  return { drinks: 1, covered_inr: 120, created_at: '2026-10-06T06:30:00.000Z', reversed_at: null, ...over };
}

function summarise(input: Partial<Parameters<typeof buildPassSummary>[0]> = {}) {
  return buildPassSummary({
    passes: [],
    redemptions: [],
    recent: [],
    holders: {},
    from: FROM,
    to: TO,
    now: NOW,
    ...input,
  });
}

describe('parseSummaryRange', () => {
  // 2026-10-15 10:00 IST
  it('defaults to the last 30 days including today', () => {
    expect(parseSummaryRange(null, null, NOW)).toEqual({ ok: true, from: '2026-09-16', to: '2026-10-15' });
    expect(parseSummaryRange('', undefined, NOW)).toEqual({ ok: true, from: '2026-09-16', to: '2026-10-15' });
  });

  it('takes today from the IST calendar, not UTC (00:30 IST on the 16th is still the 15th in UTC)', () => {
    const justAfterIstMidnight = new Date('2026-10-15T19:00:00Z'); // 00:30 IST on 16 Oct
    expect(parseSummaryRange(null, null, justAfterIstMidnight)).toMatchObject({ to: '2026-10-16' });
  });

  it('with only `to`, gives the 30 days ending there; with only `from`, runs to today', () => {
    expect(parseSummaryRange(null, '2026-10-10', NOW)).toEqual({ ok: true, from: '2026-09-11', to: '2026-10-10' });
    expect(parseSummaryRange('2026-10-01', null, NOW)).toEqual({ ok: true, from: '2026-10-01', to: '2026-10-15' });
  });

  it('accepts one day and a range as given', () => {
    expect(parseSummaryRange('2026-10-05', '2026-10-05', NOW)).toEqual({ ok: true, from: '2026-10-05', to: '2026-10-05' });
    expect(parseSummaryRange(FROM, TO, NOW)).toEqual({ ok: true, from: FROM, to: TO });
  });

  it('refuses dates that are not real, malformed or not text', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '10/05/2026', 'yesterday', '2026-1-1']) {
      expect(parseSummaryRange(bad, null, NOW)).toMatchObject({ ok: false });
      expect(parseSummaryRange(null, bad, NOW)).toMatchObject({ ok: false });
    }
    expect(parseSummaryRange(20261001, null, NOW)).toMatchObject({ ok: false });
  });

  it('refuses a start after the end, an end in the future and a window over a year', () => {
    expect(parseSummaryRange('2026-10-10', '2026-10-05', NOW)).toMatchObject({ ok: false });
    expect(parseSummaryRange('2026-10-01', '2026-10-16', NOW)).toMatchObject({ ok: false });
    expect(SUMMARY_MAX_DAYS).toBe(366);
  });

  it('allows exactly the maximum window', () => {
    // 2025-10-16 .. 2026-10-15 is 365 days; 2025-10-15 .. 2026-10-15 is 366 days.
    expect(parseSummaryRange('2025-10-15', '2026-10-15', NOW).ok).toBe(true);
    expect(parseSummaryRange('2025-10-14', '2026-10-15', NOW)).toMatchObject({ ok: false });
  });
});

describe('summaryRangeBounds', () => {
  it('runs from 00:00 IST of `from` to 00:00 IST of the day after `to`', () => {
    expect(summaryRangeBounds(FROM, TO)).toEqual({
      startIso: '2026-09-30T18:30:00.000Z',
      endIso: '2026-10-14T18:30:00.000Z',
    });
  });
});

describe('maskPhone', () => {
  it('keeps the last four digits and nothing else', () => {
    expect(maskPhone('+919876543210')).toBe('••••••3210');
    expect(maskPhone('9876543210')).toBe('••••••3210');
  });
  it('is empty for no number', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
    expect(maskPhone('12')).toBe('');
  });
  it('never contains any other digit of the number', () => {
    const masked = maskPhone('+919876543210');
    expect(masked.replace(/\D/g, '')).toBe('3210');
  });
});

describe('toSummaryPassRow', () => {
  it('coerces numbers and reads an unknown status as active', () => {
    expect(
      toSummaryPassRow({
        id: 'p', user_id: 'u', plan_name: 'W', drinks_total: '7', drinks_remaining: '3', price_inr: '750',
        status: 'weird', expires_at: 'E', created_at: 'C',
      }),
    ).toEqual({
      id: 'p', user_id: 'u', plan_name: 'W', drinks_total: 7, drinks_remaining: 3, price_inr: 750,
      status: 'active', expires_at: 'E', created_at: 'C',
    });
    expect(toSummaryPassRow({ id: 'p', user_id: 'u', status: 'refunded' }).status).toBe('refunded');
  });
});

describe('buildPassSummary: sold and refunded', () => {
  it('counts passes created in the range by plan, excluding refunded and void ones', () => {
    const s = summarise({
      passes: [
        pass(),
        pass(),
        pass({ plan_name: 'Monthly Ritual', price_inr: 900, expires_at: '2026-11-03T18:30:00.000Z' }),
        pass({ status: 'refunded' }),
        pass({ status: 'void' }),
      ],
    });
    expect(s.sold).toEqual({ count: 3, inr: 750 + 750 + 900 });
    expect(s.sold_by_plan).toEqual([
      { plan_name: 'Weekly Ritual', count: 2, inr: 1500 },
      { plan_name: 'Monthly Ritual', count: 1, inr: 900 },
    ]);
    expect(s.refunded).toEqual({ count: 1, inr: 750 });
  });

  it('uses the price the customer paid (a snapshot), not the plan list price', () => {
    expect(summarise({ passes: [pass({ price_inr: 600 })] }).sold_by_plan).toEqual([
      { plan_name: 'Weekly Ritual', count: 1, inr: 600 },
    ]);
  });

  it('leaves out passes created before or after the range, and the range edges are IST midnights', () => {
    const s = summarise({
      passes: [
        pass({ created_at: '2026-09-30T18:29:59.000Z' }), // 23:59:59 IST on 30 Sep: before
        pass({ created_at: '2026-09-30T18:30:00.000Z' }), // 00:00 IST on 1 Oct: the first instant in
        pass({ created_at: '2026-10-14T18:29:59.000Z' }), // 23:59:59 IST on 14 Oct: the last instant in
        pass({ created_at: '2026-10-14T18:30:00.000Z' }), // 00:00 IST on 15 Oct: after
      ],
    });
    expect(s.sold.count).toBe(2);
  });

  it('counts a pass once when the same row arrives from two queries', () => {
    const p = pass();
    expect(summarise({ passes: [p, { ...p }, p] }).sold.count).toBe(1);
  });

  it('breaks a tie in revenue by plan name, biggest revenue first', () => {
    const s = summarise({
      passes: [pass({ plan_name: 'B', price_inr: 100 }), pass({ plan_name: 'A', price_inr: 100 }), pass({ plan_name: 'C', price_inr: 500 })],
    });
    expect(s.sold_by_plan.map((l) => l.plan_name)).toEqual(['C', 'A', 'B']);
  });

  it('is all zeros for no passes', () => {
    const s = summarise();
    expect(s.sold).toEqual({ count: 0, inr: 0 });
    expect(s.sold_by_plan).toEqual([]);
    expect(s.refunded).toEqual({ count: 0, inr: 0 });
    expect(s.active).toEqual({ passes: 0, cups_outstanding: 0, liability_inr: 0 });
    expect(s.redeemed).toEqual({ cups: 0, covered_inr: 0 });
    expect(s.expired_unused).toEqual({ cups: 0, inr: 0 });
    expect(s.recent).toEqual([]);
  });
});

describe('buildPassSummary: active and liability', () => {
  const live = { expires_at: '2026-10-20T18:30:00.000Z' };

  it('counts passes still usable as of now, with their cups', () => {
    const s = summarise({
      passes: [
        pass({ ...live, drinks_remaining: 5 }),
        pass({ ...live, drinks_remaining: 2 }),
        pass({ ...live, drinks_remaining: 0 }), // used up
        pass({ ...live, status: 'refunded' }),
        pass({ ...live, status: 'void' }),
        pass({ expires_at: '2026-10-11T18:30:00.000Z' }), // expired on the 12th
      ],
    });
    expect(s.active.passes).toBe(2);
    expect(s.active.cups_outstanding).toBe(7);
  });

  it('is judged at `now`: a pass is active until its expiry instant, expired from it', () => {
    const expiresAtNow = pass({ expires_at: NOW.toISOString() });
    expect(summarise({ passes: [expiresAtNow] }).active.passes).toBe(0);
    const later = pass({ expires_at: new Date(NOW.getTime() + 1000).toISOString() });
    expect(summarise({ passes: [later] }).active.passes).toBe(1);
  });

  it('values the cups left at what the customer paid per cup: remaining x price / cups, rounded', () => {
    // 7 cups for ₹750 = ₹107.14 a cup. 5 left = ₹535.71 -> 536.
    expect(summarise({ passes: [pass({ ...live, drinks_remaining: 5 })] }).active.liability_inr).toBe(536);
    // A full pass is worth exactly its price.
    expect(summarise({ passes: [pass({ ...live })] }).active.liability_inr).toBe(750);
  });

  it('rounds the TOTAL once, not each pass (three passes with 1 cup left: 3 x 107.14 = 321.43, not 3 x 107)', () => {
    const passes = [1, 2, 3].map(() => pass({ ...live, drinks_remaining: 1 }));
    expect(summarise({ passes }).active.liability_inr).toBe(321);
  });

  it('mixes plans: each pass at its own price per cup', () => {
    const s = summarise({
      passes: [
        pass({ ...live, drinks_remaining: 7, price_inr: 750 }), // 750
        pass({ ...live, drinks_remaining: 3, price_inr: 800, drinks_total: 7, plan_name: 'Monthly Ritual' }), // 342.86
      ],
    });
    expect(s.active.liability_inr).toBe(1093); // 1092.857
    expect(s.active.cups_outstanding).toBe(10);
  });

  it('does not count refunded cups as owed: the money went back', () => {
    expect(summarise({ passes: [pass({ ...live, status: 'refunded' })] }).active.liability_inr).toBe(0);
  });

  it('is measured as of now whatever the range: an old range still shows today’s liability', () => {
    const s = summarise({ from: '2026-01-01', to: '2026-01-31', passes: [pass({ ...live })] });
    expect(s.active.passes).toBe(1);
    expect(s.sold.count).toBe(0);
  });
});

describe('buildPassSummary: redeemed', () => {
  it('sums the cups and the menu value they covered, in the range only', () => {
    const s = summarise({
      redemptions: [
        redemption({ drinks: 2, covered_inr: 270 }),
        redemption({ drinks: 1, covered_inr: 150 }),
        redemption({ created_at: '2026-09-30T18:29:00.000Z' }), // before
        redemption({ created_at: '2026-10-14T18:30:00.000Z' }), // after
      ],
    });
    expect(s.redeemed).toEqual({ cups: 3, covered_inr: 420 });
  });

  it('ignores cups that came back (a reversed redemption)', () => {
    const s = summarise({
      redemptions: [redemption({ drinks: 1, covered_inr: 120 }), redemption({ drinks: 2, covered_inr: 240, reversed_at: '2026-10-07T05:00:00Z' })],
    });
    expect(s.redeemed).toEqual({ cups: 1, covered_inr: 120 });
  });
});

describe('buildPassSummary: expired unused', () => {
  it('counts the cups left on active passes whose expiry fell in the range, at price per cup', () => {
    const s = summarise({
      passes: [
        pass({ drinks_remaining: 3 }), // expired 12 Oct 00:00 IST, 3 cups left: 3 x 107.14 = 321.43
        pass({ drinks_remaining: 7, price_inr: 900, drinks_total: 7 }), // 7 x 128.57 = 900
      ],
    });
    expect(s.expired_unused).toEqual({ cups: 10, inr: 1221 }); // 321.43 + 900
  });

  it('leaves out a pass that was used up, refunded or void, or that expired outside the range', () => {
    const s = summarise({
      passes: [
        pass({ drinks_remaining: 0 }),
        pass({ drinks_remaining: 4, status: 'refunded' }),
        pass({ drinks_remaining: 4, status: 'void' }),
        pass({ drinks_remaining: 4, expires_at: '2026-09-30T18:29:00.000Z' }), // expired before the range
        pass({ drinks_remaining: 4, expires_at: '2026-10-14T18:30:00.000Z' }), // expires after the range
      ],
    });
    expect(s.expired_unused).toEqual({ cups: 0, inr: 0 });
  });

  it('does not count a pass whose expiry is in the range but still in the future', () => {
    // An expiry inside the range that `now` has not reached yet (expiries are IST midnights
    // in practice, so this only happens with a clock a little behind the database's).
    const early = new Date('2026-10-14T20:00:00Z'); // 01:30 IST on 15 Oct
    const s = buildPassSummary({
      passes: [pass({ drinks_remaining: 2, expires_at: '2026-10-14T21:00:00.000Z' })],
      redemptions: [],
      recent: [],
      holders: {},
      from: '2026-10-15',
      to: '2026-10-15',
      now: early,
    });
    expect(s.expired_unused).toEqual({ cups: 0, inr: 0 });
    expect(s.active.passes).toBe(1);
  });

  it('counts a pass that expired in the range as expired unused, not as active', () => {
    const s = summarise({ passes: [pass({ drinks_remaining: 2 })] });
    expect(s.expired_unused.cups).toBe(2);
    expect(s.active.passes).toBe(0);
  });
});

describe('buildPassSummary: recent', () => {
  const holders = {
    'user-a': { name: 'Asha K', phone: '+919876543210' },
    'user-b': { name: '  ', phone: '' },
  };

  it('lists the newest first with the holder’s name and only the last four digits of the number', () => {
    const older = pass({ user_id: 'user-b', created_at: '2026-10-02T06:30:00.000Z' });
    const newer = pass({ user_id: 'user-a', created_at: '2026-10-09T06:30:00.000Z', drinks_remaining: 4, expires_at: '2026-10-20T18:30:00.000Z' });
    const s = summarise({ recent: [older, newer], holders });
    expect(s.recent).toEqual([
      {
        id: newer.id,
        holder_name: 'Asha K',
        holder_phone_masked: '••••••3210',
        plan_name: 'Weekly Ritual',
        created_at: '2026-10-09T06:30:00.000Z',
        drinks_total: 7,
        drinks_remaining: 4,
        expires_at: '2026-10-20T18:30:00.000Z',
        state: 'active',
      },
      expect.objectContaining({ id: older.id, holder_name: 'Customer', holder_phone_masked: '', state: 'expired' }),
    ]);
  });

  it('never carries a full phone number or a user id', () => {
    const s = summarise({ recent: [pass({ user_id: 'user-a' })], holders });
    const text = JSON.stringify(s);
    expect(text).not.toContain('9876543210');
    expect(text).not.toContain('user-a');
    expect(text).not.toContain('user_id');
  });

  it('shows each pass in the state it is in now: used up, refunded, void, expired', () => {
    const live = { expires_at: '2026-10-20T18:30:00.000Z' };
    const s = summarise({
      recent: [
        pass({ ...live, drinks_remaining: 0, created_at: '2026-10-09T01:00:00Z' }),
        pass({ ...live, status: 'refunded', created_at: '2026-10-08T01:00:00Z' }),
        pass({ ...live, status: 'void', created_at: '2026-10-07T01:00:00Z' }),
        pass({ created_at: '2026-10-06T01:00:00Z' }), // expired
      ],
    });
    expect(s.recent.map((r) => r.state)).toEqual(['used_up', 'refunded', 'void', 'expired']);
  });

  it('caps the list at 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => pass({ created_at: `2026-10-05T06:${String(i).padStart(2, '0')}:00.000Z` }));
    expect(summarise({ recent: many }).recent).toHaveLength(SUMMARY_RECENT_LIMIT);
  });

  it('is independent of the range (a log of the newest passes, whatever period is being read)', () => {
    const s = summarise({ from: '2026-01-01', to: '2026-01-02', recent: [pass()] });
    expect(s.recent).toHaveLength(1);
  });
});
