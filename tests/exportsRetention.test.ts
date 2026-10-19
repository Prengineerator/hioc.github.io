import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CsvTable, CsvValue } from '@/lib/reports/csv';
import { defaultPlaybook, type WinbackParamsBundle } from '@/lib/marketing/types';
import {
  addMonthsToDate,
  appPhonesSince,
  buildCustomerBook,
  createIdentityResolver,
  lookbackFrom,
  toCustomerPhone,
  type AppOrderRow,
  type LegacyBillRow,
  type LegacyCustomerRow,
  type ProfileRow,
} from '@/lib/reports/exports/customerIdentity';
import {
  analyseCoupons,
  analyseRetention,
  cohortRetention,
  couponInsights,
  couponPerformance,
  couponRedemptions,
  customerVisits,
  retentionHighlights,
  retentionSummary,
  type CouponInput,
  type RetentionHighlightInput,
  type RetentionInput,
  type RetentionKpis,
} from '@/lib/reports/exports/retentionReports';
import {
  loadRetentionInsights,
  RETENTION_REPORTS,
} from '@/lib/reports/exports/retentionReportsServer';

// The retention and coupon sheets (lib/reports/exports/retentionReports.ts) and the
// identity rules under them (customerIdentity.ts), on hand-built rows; then the
// registry's loaders against a small in-memory database (at the end of the file).
// Times are IST: 12:00 IST on a date is 06:30Z.

/** The UTC ISO of an IST wall-clock time on an IST date. */
function at(date: string, hm = '12:00'): string {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) - (5 * 60 + 30) * 60_000).toISOString();
}

function cell(t: CsvTable, row: number, header: string): CsvValue {
  const i = t.columns.indexOf(header);
  if (i < 0) throw new Error(`no column ${header}`);
  return t.rows[row][i];
}

/** The index of the row whose first cell is `first`. */
function rowNamed(t: CsvTable, first: string): number {
  return t.rows.findIndex((r) => r[0] === first);
}

/** The Value of a summary metric. */
function metric(t: CsvTable, name: string): CsvValue {
  const i = rowNamed(t, name);
  if (i < 0) throw new Error(`no metric ${name}`);
  return t.rows[i][1];
}

const WINBACK: WinbackParamsBundle = {
  winback_1: defaultPlaybook('winback_1').params,
  winback_2: defaultPlaybook('winback_2').params,
  winback_3: defaultPlaybook('winback_3').params,
};

let seq = 1000;
function order(over: Partial<AppOrderRow> & { id: string; created_at: string }): AppOrderRow {
  return {
    order_number: ++seq,
    status: 'completed',
    channel: 'customer_web',
    user_id: null,
    customer_user_id: null,
    customer_phone: '',
    customer_name: '',
    total_inr: 100,
    discount_inr: 0,
    ...over,
  };
}

function profile(over: Partial<ProfileRow> & { id: string }): ProfileRow {
  return { name: null, phone: null, phone_verified: false, role: 'customer', ...over };
}

const ASHA = profile({ id: 'acct-asha', name: 'Asha Rao', phone: '+919811111111', phone_verified: true });
const DEV = profile({ id: 'acct-dev', name: 'Dev Mehta', phone: '+919822222221', phone_verified: true });
const UMA = profile({ id: 'acct-uma', name: 'Uma', phone: '+919833333333', phone_verified: false });
const STAFF = profile({ id: 'staff-1', name: 'Staff One', phone: '+919899999999', phone_verified: true, role: 'staff' });
const OWNER = profile({ id: 'owner-1', name: 'The Owner', phone: '+919877700000', phone_verified: false, role: 'owner' });

// ── The phone and its spellings ──────────────────────────────────────────────

describe('toCustomerPhone', () => {
  it('reads every spelling of one Indian mobile as the same E.164', () => {
    for (const raw of ['+919844444444', '9844444444', '98444 44444', '09844444444', '919844444444', '+91 98444-44444']) {
      expect(toCustomerPhone(raw)).toBe('+919844444444');
    }
  });

  it('refuses what is not an Indian mobile instead of guessing', () => {
    for (const raw of ['', null, undefined, '12345', '+6581234567', '5844444444', 'abc']) {
      expect(toCustomerPhone(raw)).toBeNull();
    }
  });
});

describe('addMonthsToDate / lookbackFrom', () => {
  it('moves by whole months, cutting the day to the month length', () => {
    expect(addMonthsToDate('2026-10-01', -12)).toBe('2025-10-01');
    expect(addMonthsToDate('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonthsToDate('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonthsToDate('2026-01-15', -1)).toBe('2025-12-15');
    expect(lookbackFrom('2026-10-19')).toBe('2025-10-19');
  });
});

// ── Whose order is it ────────────────────────────────────────────────────────

describe('createIdentityResolver', () => {
  const resolver = createIdentityResolver([ASHA, DEV, UMA, STAFF, OWNER]);

  it('files an order under its account: the linked customer before the session that placed it', () => {
    expect(resolver.keyForOrder({ user_id: 'acct-asha' })).toBe('acct-asha');
    expect(resolver.keyForOrder({ customer_user_id: 'acct-asha' })).toBe('acct-asha');
    expect(resolver.keyForOrder({ user_id: 'acct-dev', customer_user_id: 'acct-asha' })).toBe('acct-asha');
  });

  it('puts a counter order linked to an account and that account’s own web order under one person', () => {
    const web = resolver.keyForOrder({ user_id: 'acct-asha', customer_phone: '+919811111111' });
    const counter = resolver.keyForOrder({ user_id: null, customer_user_id: 'acct-asha', customer_phone: '9811111111' });
    expect(web).toBe('acct-asha');
    expect(counter).toBe('acct-asha');
  });

  it('keys an order with only a phone by that phone, whichever spelling it is stored in', () => {
    expect(resolver.keyForOrder({ customer_phone: '+919844444444' })).toBe('p:+919844444444');
    expect(resolver.keyForOrder({ customer_phone: '9844444444' })).toBe('p:+919844444444');
    expect(resolver.keyForOrder({ customer_phone: ' 98444 44444 ' })).toBe('p:+919844444444');
  });

  it('lets a phone-only order join the account that has verified that number', () => {
    expect(resolver.keyForOrder({ customer_phone: '+919811111111' })).toBe('acct-asha');
    expect(resolver.keyForOrder({ customer_phone: '9811111111' })).toBe('acct-asha');
    expect(resolver.keyForPhone('+919822222221')).toBe('acct-dev');
  });

  it('does not join an account on a phone it has not verified', () => {
    expect(resolver.keyForOrder({ customer_phone: '+919833333333' })).toBe('p:+919833333333');
  });

  it('joins neither of two accounts that both claim a verified number', () => {
    const twice = createIdentityResolver([
      profile({ id: 'a1', phone: '+919800000001', phone_verified: true }),
      profile({ id: 'a2', phone: '9800000001', phone_verified: true }),
    ]);
    expect(twice.keyForOrder({ customer_phone: '+919800000001' })).toBe('p:+919800000001');
    // …but each account still owns its own orders.
    expect(twice.keyForOrder({ user_id: 'a1' })).toBe('a1');
  });

  it('counts a walk-in as nobody: no account, no usable phone', () => {
    expect(resolver.keyForOrder({})).toBeNull();
    expect(resolver.keyForOrder({ user_id: null, customer_user_id: null, customer_phone: '' })).toBeNull();
    expect(resolver.keyForOrder({ user_id: '', customer_user_id: '  ', customer_phone: '   ' })).toBeNull();
    expect(resolver.keyForOrder({ customer_phone: '12345' })).toBeNull();
    expect(resolver.keyForOrder({ customer_phone: '+6581234567' })).toBeNull();
  });

  it('does not count staff, manager or owner accounts as customers', () => {
    expect(resolver.keyForOrder({ user_id: 'staff-1' })).toBeNull();
    expect(resolver.keyForOrder({ customer_user_id: 'owner-1' })).toBeNull();
    expect(resolver.isStaffAccount('staff-1')).toBe(true);
    expect(resolver.isStaffAccount('acct-asha')).toBe(false);
    const manager = createIdentityResolver([profile({ id: 'm1', role: 'manager' })]);
    expect(manager.keyForOrder({ user_id: 'm1' })).toBeNull();
  });

  it('files a staff session’s order under the customer phone it carries, and under nobody for the staff’s own number', () => {
    expect(resolver.keyForOrder({ user_id: 'staff-1', customer_phone: '9844444444' })).toBe('p:+919844444444');
    expect(resolver.keyForOrder({ user_id: 'staff-1', customer_phone: '+919899999999' })).toBeNull();
    // A staff number is nobody even without the staff session on the order — verified or not.
    expect(resolver.keyForOrder({ customer_phone: '9899999999' })).toBeNull();
    expect(resolver.keyForOrder({ customer_phone: '9877700000' })).toBeNull();
    expect(resolver.keyForPhone('+919899999999')).toBeNull();
  });

  it('treats an account with no profile row as a customer', () => {
    expect(resolver.keyForOrder({ user_id: 'unknown-acct' })).toBe('unknown-acct');
  });

  it('knows only the verified phone of a customer account', () => {
    expect(resolver.verifiedPhone('acct-asha')).toBe('+919811111111');
    expect(resolver.verifiedPhone('acct-uma')).toBeNull();
    expect(resolver.verifiedPhone('staff-1')).toBeNull();
  });
});

// ── People, first visits ─────────────────────────────────────────────────────

describe('buildCustomerBook', () => {
  const BEN_LEGACY: LegacyCustomerRow = {
    phone: '+919844444444',
    name: 'Ben Petpooja',
    first_order_at: at('2025-03-04'),
    last_order_at: at('2026-09-20'),
    order_count: 12,
    total_spend_inr: 4000,
  };

  it('makes an app "first order" a returning visit when Petpooja saw the customer first', () => {
    const book = buildCustomerBook({
      profiles: [],
      orders: [order({ id: 'o1', created_at: at('2026-10-05'), customer_phone: '9844444444', channel: 'staff_pos' })],
      legacyBills: [],
      legacyCustomers: [BEN_LEGACY],
    });
    const ben = book.people.get('p:+919844444444')!;
    expect(ben.visits).toHaveLength(1);
    expect(ben.firstVisitDate).toBe('2025-03-04');
    expect(ben.legacy?.orderCount).toBe(12);
  });

  it('dates a customer’s first visit by their first app order when Petpooja never knew them', () => {
    const book = buildCustomerBook({
      profiles: [],
      orders: [
        order({ id: 'o2', created_at: at('2026-10-09'), customer_phone: '+919855555555' }),
        order({ id: 'o1', created_at: at('2026-10-05'), customer_phone: '9855555555' }),
      ],
      legacyBills: [],
      legacyCustomers: [BEN_LEGACY],
    });
    const cara = book.people.get('p:+919855555555')!;
    expect(cara.firstVisitDate).toBe('2026-10-05');
    expect(cara.visits.map((v) => v.orderId)).toEqual(['o1', 'o2']);
    expect(cara.legacy).toBeNull();
  });

  it('takes the earlier of the two when the app order came first', () => {
    const book = buildCustomerBook({
      profiles: [],
      orders: [order({ id: 'o1', created_at: at('2026-10-05'), customer_phone: '9844444444' })],
      legacyBills: [],
      legacyCustomers: [{ ...BEN_LEGACY, first_order_at: at('2026-10-20') }],
    });
    expect(book.people.get('p:+919844444444')!.firstVisitDate).toBe('2026-10-05');
  });

  it('matches an account to Petpooja history through its verified phone only', () => {
    const legacy: LegacyCustomerRow = { ...BEN_LEGACY, phone: '+919811111111', first_order_at: at('2024-01-10') };
    const verified = buildCustomerBook({
      profiles: [ASHA],
      orders: [order({ id: 'o1', created_at: at('2026-10-05'), user_id: 'acct-asha' })],
      legacyBills: [],
      legacyCustomers: [legacy],
    });
    expect(verified.people.get('acct-asha')!.firstVisitDate).toBe('2024-01-10');
    expect(verified.people.get('acct-asha')!.phones).toEqual(['+919811111111']);

    const unverified = buildCustomerBook({
      profiles: [{ ...ASHA, phone_verified: false }],
      orders: [order({ id: 'o1', created_at: at('2026-10-05'), user_id: 'acct-asha' })],
      legacyBills: [],
      legacyCustomers: [legacy],
    });
    expect(unverified.people.get('acct-asha')!.firstVisitDate).toBe('2026-10-05');
  });

  it('folds a phone-only order and a Petpooja bill of an account holder into one person', () => {
    const book = buildCustomerBook({
      profiles: [ASHA],
      orders: [
        order({ id: 'o1', created_at: at('2026-10-05'), user_id: 'acct-asha' }),
        order({ id: 'o2', created_at: at('2026-10-06'), customer_phone: '9811111111', channel: 'staff_pos' }),
      ],
      legacyBills: [{ customer_phone: '+919811111111', ordered_at: at('2026-09-01'), total_inr: 80 }],
      legacyCustomers: [],
    });
    expect([...book.people.keys()]).toEqual(['acct-asha']);
    const asha = book.people.get('acct-asha')!;
    expect(asha.visits.map((v) => v.source)).toEqual(['petpooja', 'app', 'app']);
    expect(asha.firstVisitDate).toBe('2026-09-01');
    expect(asha.legacyBillsRead).toBe(1);
  });

  it('makes a person of a Petpooja-only customer, and leaves staff numbers and phone-less bills out', () => {
    const bills: LegacyBillRow[] = [
      { customer_phone: '+919866666666', ordered_at: at('2026-08-01'), total_inr: 250 },
      { customer_phone: '+919899999999', ordered_at: at('2026-08-02'), total_inr: 90 },
      { customer_phone: null, ordered_at: at('2026-08-03'), total_inr: 40 },
    ];
    const book = buildCustomerBook({ profiles: [STAFF], orders: [], legacyBills: bills, legacyCustomers: [] });
    expect([...book.people.keys()]).toEqual(['p:+919866666666']);
    expect(book.people.get('p:+919866666666')!.visits[0]).toMatchObject({ source: 'petpooja', date: '2026-08-01', totalInr: 250 });
  });

  it('does not make a visit — or a person — of a cancelled or rejected order', () => {
    const book = buildCustomerBook({
      profiles: [],
      orders: [
        order({ id: 'o1', created_at: at('2026-10-05'), customer_phone: '9855555555', status: 'cancelled' }),
        order({ id: 'o2', created_at: at('2026-10-06'), customer_phone: '9866666666', status: 'rejected' }),
        order({ id: 'o3', created_at: at('2026-10-07'), customer_phone: '9866666666' }),
      ],
      legacyBills: [],
      legacyCustomers: [],
    });
    expect([...book.people.keys()]).toEqual(['p:+919866666666']);
    expect(book.people.get('p:+919866666666')!.visits).toHaveLength(1);
    // The order-to-person map still covers the cancelled one, for the coupon sheets.
    expect(book.keyByOrderId.get('o1')).toBe('p:+919855555555');
  });

  it('names a person by profile, else the name typed on their latest order, else Petpooja, else nothing', () => {
    const book = buildCustomerBook({
      profiles: [ASHA],
      orders: [
        order({ id: 'o1', created_at: at('2026-10-05'), user_id: 'acct-asha', customer_name: 'Typed Name' }),
        order({ id: 'o2', created_at: at('2026-10-05'), customer_phone: '9855555555', customer_name: 'Cara' }),
        order({ id: 'o3', created_at: at('2026-10-07'), customer_phone: '9855555555', customer_name: 'Cara R' }),
        order({ id: 'o4', created_at: at('2026-10-08'), customer_phone: '9844444444', customer_name: '' }),
        order({ id: 'o5', created_at: at('2026-10-08'), customer_phone: '9833333333', customer_name: '' }),
      ],
      legacyBills: [],
      legacyCustomers: [BEN_LEGACY],
    });
    expect(book.people.get('acct-asha')!.name).toBe('Asha Rao');
    expect(book.people.get('p:+919855555555')!.name).toBe('Cara R');
    expect(book.people.get('p:+919844444444')!.name).toBe('Ben Petpooja');
    expect(book.people.get('p:+919833333333')!.name).toBe('');
  });
});

describe('appPhonesSince', () => {
  it('collects the numbers typed on recent valid app orders and their accounts’ verified phones', () => {
    const resolver = createIdentityResolver([ASHA, STAFF]);
    const orders = [
      order({ id: 'o1', created_at: at('2026-10-20'), customer_phone: '9844444444' }),
      order({ id: 'o2', created_at: at('2026-10-21'), user_id: 'acct-asha' }),
      order({ id: 'o3', created_at: at('2026-10-22'), customer_phone: '9855555555', status: 'cancelled' }),
      order({ id: 'o4', created_at: at('2026-08-01'), customer_phone: '9866666666' }),
      order({ id: 'o5', created_at: at('2026-10-23'), user_id: 'staff-1' }),
    ];
    expect([...appPhonesSince(orders, resolver, at('2026-09-01')).values()].sort()).toEqual(['+919811111111', '+919844444444']);
  });
});

// ── The scenario: October 2026 ───────────────────────────────────────────────
//
//   Asha   account; 4 bills on 3 days (Oct 2, 9, 9, 16), new                         spend 850
//   Ben    phone-only, a Petpooja regular since Mar 2025; Oct 5 and Oct 12          spend 270, returning
//   Cara   phone-only, new on Oct 20 (a cancelled bill on Oct 25 does not count)    spend 180
//   Dev    account, first bill Sep 5, one more Oct 10                               spend 110, returning
//   Uma    phone-only on her UNverified account's number, Oct 7                     spend  80, new
//   walk-ins ×2, one order from a staff session: bills, but nobody to follow
//   Eli    3 bills in early Aug (lapsed), Fay one bill in March (lost): not seen in October

const SCENARIO_LEGACY: LegacyCustomerRow[] = [
  {
    phone: '+919844444444',
    name: 'Ben',
    first_order_at: at('2025-03-04'),
    last_order_at: at('2026-09-20'),
    order_count: 12,
    total_spend_inr: 4000,
  },
];

const SCENARIO_ORDERS: AppOrderRow[] = [
  order({ id: 'o1', order_number: 2001, created_at: at('2026-10-02'), user_id: 'acct-asha', total_inr: 200 }),
  order({ id: 'o2', order_number: 2002, created_at: at('2026-10-09'), user_id: 'acct-asha', total_inr: 300 }),
  order({ id: 'o3', order_number: 2003, created_at: at('2026-10-09', '18:00'), channel: 'staff_pos', customer_user_id: 'acct-asha', total_inr: 100 }),
  order({ id: 'o4', order_number: 2004, created_at: at('2026-10-16'), user_id: 'acct-asha', total_inr: 250 }),
  order({ id: 'o5', order_number: 2005, created_at: at('2026-10-05'), channel: 'staff_pos', customer_phone: '9844444444', customer_name: 'Ben', total_inr: 150 }),
  order({ id: 'o6', order_number: 2006, created_at: at('2026-10-12'), channel: 'staff_pos', customer_phone: '+919844444444', total_inr: 120 }),
  order({ id: 'o7', order_number: 2007, created_at: at('2026-10-20'), channel: 'staff_pos', customer_phone: '+919855555555', customer_name: 'Cara', total_inr: 180 }),
  order({ id: 'o7b', order_number: 2008, created_at: at('2026-10-25'), channel: 'staff_pos', customer_phone: '+919855555555', total_inr: 999, status: 'cancelled' }),
  order({ id: 'o8', order_number: 2009, created_at: at('2026-09-05'), user_id: 'acct-dev', total_inr: 90 }),
  order({ id: 'o9', order_number: 2010, created_at: at('2026-10-10'), user_id: 'acct-dev', total_inr: 110 }),
  order({ id: 'o10', order_number: 2011, created_at: at('2026-10-03'), channel: 'staff_pos', total_inr: 50 }),
  order({ id: 'o11', order_number: 2012, created_at: at('2026-10-04'), channel: 'staff_pos', total_inr: 60 }),
  order({ id: 'o12', order_number: 2013, created_at: at('2026-10-06'), user_id: 'staff-1', total_inr: 70 }),
  order({ id: 'o13', order_number: 2014, created_at: at('2026-10-07'), channel: 'staff_pos', customer_phone: '+919833333333', customer_name: 'Uma', total_inr: 80 }),
  // Eli (lapsed): three bills three days apart in early August.
  order({ id: 'e1', created_at: at('2026-08-01'), customer_phone: '9866666666' }),
  order({ id: 'e2', created_at: at('2026-08-04'), customer_phone: '9866666666' }),
  order({ id: 'e3', created_at: at('2026-08-07'), customer_phone: '9866666666' }),
  // Fay (lost): one bill in March.
  order({ id: 'f1', created_at: at('2026-03-15'), customer_phone: '9877777777' }),
];

function scenario(over: Partial<RetentionInput> = {}): RetentionInput {
  return {
    from: '2026-10-01',
    to: '2026-10-31',
    profiles: [ASHA, DEV, UMA, STAFF],
    orders: SCENARIO_ORDERS,
    legacyBills: [],
    legacyCustomers: SCENARIO_LEGACY,
    winback: WINBACK,
    petpoojaLapsedRegulars: 3,
    ...over,
  };
}

describe('retentionSummary', () => {
  const t = retentionSummary(analyseRetention(scenario()));

  it('has Metric / Value / Note columns', () => {
    expect(t.columns).toEqual(['Metric', 'Value', 'Note']);
    expect(t.rows.every((r) => r.length === 3 && String(r[2]).length > 0)).toBe(true);
  });

  it('counts customers, with Petpooja history making Ben a returning customer', () => {
    expect(metric(t, 'Customers who visited')).toBe(5);
    expect(metric(t, 'New customers')).toBe(3);
    expect(metric(t, 'Returning customers')).toBe(2);
  });

  it('splits the revenue and the average bill between new and returning', () => {
    expect(metric(t, 'Revenue from new customers (INR)')).toBe(1110);
    expect(metric(t, 'Revenue from returning customers (INR)')).toBe(380);
    expect(metric(t, 'Average bill, new customers (INR)')).toBe(185);
    expect(metric(t, 'Average bill, returning customers (INR)')).toBe(126.67);
  });

  it('counts a visit as a day: Asha’s two bills on Oct 9 are one visit; repeat rate counts days', () => {
    expect(metric(t, 'Repeat rate (%)')).toBe(40);
    expect(metric(t, 'Average visits per customer')).toBe(1.6);
  });

  it('averages the customers’ own typical gaps, only for those with 3+ bills', () => {
    expect(metric(t, 'Average days between visits')).toBe(7);
  });

  it('splits the period’s bills by who they came from (classifyOrderKind) and how many can be followed', () => {
    expect(metric(t, 'Bills in the period')).toBe(12);
    expect(metric(t, 'Bills from walk-ins')).toBe(2);
    expect(metric(t, 'Bills from counter customers')).toBe(5);
    expect(metric(t, 'Bills from online and table QR orders')).toBe(5);
    expect(metric(t, 'Bills linked to a customer')).toBe(9);
  });

  it('counts lifecycle at the period end with the marketing agent’s staging', () => {
    expect(metric(t, 'At period end: new customers (one bill so far)')).toBe(2);
    expect(metric(t, 'At period end: active customers')).toBe(2);
    expect(metric(t, 'At period end: customers at risk')).toBe(1);
    expect(metric(t, 'At period end: lapsed customers')).toBe(1);
    expect(metric(t, 'At period end: lost customers')).toBe(1);
  });

  it('reports the Petpooja lapsed regulars it was given, and blank when it could not be read', () => {
    expect(metric(t, 'Petpooja regulars who have lapsed')).toBe(3);
    const unknown = retentionSummary(analyseRetention(scenario({ petpoojaLapsedRegulars: null })));
    expect(metric(unknown, 'Petpooja regulars who have lapsed')).toBe('');
  });

  it('reports last month’s new customers who came back within 30 days', () => {
    const name = "30-day return rate of September 2026's new customers (%)";
    // Only Dev was new in September; his next visit (Oct 10) is after his 30 days (Oct 5).
    expect(metric(t, name)).toBe(0);
    expect(t.rows[rowNamed(t, name)][2]).toContain('0 of 1');
  });

  it('is all zeros and blanks, not an error, with nothing to report', () => {
    const empty = retentionSummary(analyseRetention(scenario({ orders: [], profiles: [], legacyCustomers: [], petpoojaLapsedRegulars: 0 })));
    expect(metric(empty, 'Customers who visited')).toBe(0);
    expect(metric(empty, 'New customers')).toBe(0);
    expect(metric(empty, 'Revenue from new customers (INR)')).toBe(0);
    expect(metric(empty, 'Repeat rate (%)')).toBe('');
    expect(metric(empty, 'Average visits per customer')).toBe('');
    expect(metric(empty, 'Average days between visits')).toBe('');
    expect(metric(empty, 'Average bill, new customers (INR)')).toBe('');
    expect(metric(empty, 'Bills in the period')).toBe(0);
    expect(metric(empty, 'At period end: lost customers')).toBe(0);
    expect(metric(empty, "30-day return rate of September 2026's new customers (%)")).toBe('');
  });
});

describe('retention with Petpooja bills in the window', () => {
  it('counts a Petpooja visit in a period that covers it, with no app orders at all', () => {
    const a = analyseRetention({
      from: '2026-08-01',
      to: '2026-08-31',
      profiles: [],
      orders: [],
      legacyBills: [
        { customer_phone: '+919866666666', ordered_at: at('2026-08-03'), total_inr: 200 },
        { customer_phone: '+919866666666', ordered_at: at('2026-08-20'), total_inr: 150 },
        { customer_phone: '+919877777777', ordered_at: at('2026-08-05'), total_inr: 90 },
      ],
      legacyCustomers: [
        { phone: '+919866666666', first_order_at: at('2023-09-01'), last_order_at: at('2026-08-20'), order_count: 40 },
        { phone: '+919877777777', first_order_at: at('2026-08-05'), last_order_at: at('2026-08-05'), order_count: 1 },
      ],
      winback: WINBACK,
      petpoojaLapsedRegulars: null,
    });
    expect(a.kpis.customers).toBe(2);
    expect(a.kpis.newCustomers).toBe(1); // only the second number is new in August 2026
    expect(a.kpis.repeatCustomers).toBe(1);
    expect(a.kpis.bills).toBe(0); // order counts are the app's
    const visits = customerVisits(a);
    expect(cell(visits, 0, 'Visits all time (app + Petpooja)')).toBe(40);
  });
});

describe('customerVisits', () => {
  const t = customerVisits(analyseRetention(scenario()));

  it('lists the customers who visited in the period, most visits first, then a TOTAL row', () => {
    expect(t.rows).toHaveLength(6);
    // Visits first, then spend: Cara (₹180), Dev (₹110) and Uma (₹80) each came once.
    expect(t.rows.slice(0, 5).map((r) => r[0])).toEqual(['Asha Rao', 'Ben', 'Cara', 'Dev Mehta', 'Uma']);
    expect(t.rows[5][0]).toBe('TOTAL');
  });

  it('masks the phone to its last four digits', () => {
    expect(cell(t, 0, 'Phone')).toBe('••••••1111');
    expect(cell(t, 1, 'Phone')).toBe('••••••4444');
    for (const r of t.rows) expect(String(r[1])).not.toMatch(/\d{5,}/);
  });

  it('gives each customer’s first visit ever, new/returning flag and Petpooja-inclusive history', () => {
    expect(cell(t, 0, 'First visit ever')).toBe('2026-10-02');
    expect(cell(t, 0, 'New this period')).toBe('Yes');
    expect(cell(t, 1, 'First visit ever')).toBe('2025-03-04');
    expect(cell(t, 1, 'New this period')).toBe('No');
    expect(cell(t, 1, 'Visits all time (app + Petpooja)')).toBe(14); // 2 app days + 12 Petpooja bills
    expect(cell(t, 2, 'New this period')).toBe('Yes'); // Cara
    expect(cell(t, 3, 'First visit ever')).toBe('2026-09-05'); // Dev
    expect(cell(t, 3, 'New this period')).toBe('No');
  });

  it('gives visits, spend, average bill and recency at the period end', () => {
    expect(cell(t, 0, 'Visits in period')).toBe(3);
    expect(cell(t, 0, 'Spend in period (INR)')).toBe(850);
    expect(cell(t, 0, 'Avg bill (INR)')).toBe(212.5);
    expect(cell(t, 0, 'Last visit')).toBe('2026-10-16');
    expect(cell(t, 0, 'Days since last visit (at period end)')).toBe(15);
    expect(cell(t, 0, 'Typical gap (days)')).toBe(7);
    expect(cell(t, 0, 'Lifecycle stage')).toBe('At risk');
  });

  it('leaves the typical gap blank for a customer with fewer than 3 bills', () => {
    expect(cell(t, 2, 'Typical gap (days)')).toBe(''); // Cara, one bill
    expect(cell(t, 2, 'Lifecycle stage')).toBe('New');
    expect(cell(t, 3, 'Typical gap (days)')).toBe(''); // Dev, two bills
    expect(cell(t, 3, 'Lifecycle stage')).toBe('Active');
  });

  it('totals visits, spend and the bill-weighted average', () => {
    expect(cell(t, 5, 'Visits in period')).toBe(8);
    expect(cell(t, 5, 'Spend in period (INR)')).toBe(1490);
    expect(cell(t, 5, 'Avg bill (INR)')).toBe(165.56);
  });

  it('is just the header and a TOTAL of zeros when nobody visited', () => {
    const empty = customerVisits(analyseRetention(scenario({ orders: [], legacyCustomers: [] })));
    expect(empty.rows).toHaveLength(1);
    expect(empty.rows[0][0]).toBe('TOTAL');
    expect(cell(empty, 0, 'Visits in period')).toBe(0);
    expect(cell(empty, 0, 'Avg bill (INR)')).toBe(0);
  });
});

describe('cohortRetention', () => {
  const t = cohortRetention(analyseRetention(scenario()));

  it('has a row for each of the 12 months ending with the period’s last month', () => {
    expect(t.columns).toEqual([
      'Cohort month',
      'New customers',
      'Month 1 (%)',
      'Month 2 (%)',
      'Month 3 (%)',
      'Month 4 (%)',
      'Month 5 (%)',
      'Month 6 (%)',
    ]);
    expect(t.rows.map((r) => r[0])).toEqual([
      'Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026',
      'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026',
    ]);
  });

  it('counts a cohort by first visit ever, so a Petpooja regular is in no recent cohort', () => {
    expect(cell(t, rowNamed(t, 'Oct 2026'), 'New customers')).toBe(3); // Asha, Cara, Uma
    expect(cell(t, rowNamed(t, 'Sep 2026'), 'New customers')).toBe(1); // Dev
    expect(cell(t, rowNamed(t, 'Aug 2026'), 'New customers')).toBe(1); // Eli
    expect(cell(t, rowNamed(t, 'Mar 2026'), 'New customers')).toBe(1); // Fay
    expect(t.rows.reduce((s, r) => s + (r[1] as number), 0)).toBe(6); // not Ben
  });

  it('shows the share of the cohort that came back in each later month', () => {
    // Dev (Sep cohort) came back in October.
    expect(cell(t, rowNamed(t, 'Sep 2026'), 'Month 1 (%)')).toBe(100);
    // Eli (Aug cohort) did not return in September or October.
    expect(cell(t, rowNamed(t, 'Aug 2026'), 'Month 1 (%)')).toBe(0);
    expect(cell(t, rowNamed(t, 'Aug 2026'), 'Month 2 (%)')).toBe(0);
    // Fay (Mar cohort): April to September are all over.
    for (let k = 1; k <= 6; k++) expect(cell(t, rowNamed(t, 'Mar 2026'), `Month ${k} (%)`)).toBe(0);
  });

  it('leaves months that have not happened yet blank, and cohorts with nobody in them blank', () => {
    expect(cell(t, rowNamed(t, 'Sep 2026'), 'Month 2 (%)')).toBe('');
    expect(cell(t, rowNamed(t, 'Aug 2026'), 'Month 3 (%)')).toBe('');
    for (let k = 1; k <= 6; k++) expect(cell(t, rowNamed(t, 'Oct 2026'), `Month ${k} (%)`)).toBe('');
    for (let k = 1; k <= 6; k++) expect(cell(t, rowNamed(t, 'Nov 2025'), `Month ${k} (%)`)).toBe('');
  });

  it('does not count the month the data ends in as over until its last day is in the range', () => {
    const early = cohortRetention(analyseRetention(scenario({ to: '2026-10-19' })));
    // Dev came back on Oct 10, but October is not over on Oct 19.
    expect(cell(early, rowNamed(early, 'Sep 2026'), 'Month 1 (%)')).toBe('');
    expect(cell(early, rowNamed(early, 'Aug 2026'), 'Month 1 (%)')).toBe(0);
  });

  it('is twelve empty rows with no data', () => {
    const empty = cohortRetention(analyseRetention(scenario({ orders: [], legacyCustomers: [] })));
    expect(empty.rows).toHaveLength(12);
    expect(empty.rows.every((r) => r[1] === 0 && r.slice(2).every((c) => c === ''))).toBe(true);
  });
});

describe('the 30-day return of last month’s new customers', () => {
  // September's first-timers: g1 returns on day 19, g2 never, g3 on Oct 3 (day 8).
  // g4 is a Petpooja regular, so September is not their first month.
  const ORDERS: AppOrderRow[] = [
    order({ id: 'g1a', created_at: at('2026-09-01'), customer_phone: '9800000001' }),
    order({ id: 'g1b', created_at: at('2026-09-20'), customer_phone: '9800000001' }),
    order({ id: 'g2a', created_at: at('2026-09-05'), customer_phone: '9800000002' }),
    order({ id: 'g3a', created_at: at('2026-09-25'), customer_phone: '9800000003' }),
    order({ id: 'g3b', created_at: at('2026-10-03'), customer_phone: '9800000003' }),
    order({ id: 'g4a', created_at: at('2026-09-12'), customer_phone: '9800000004' }),
    order({ id: 'g4b', created_at: at('2026-10-02'), customer_phone: '9800000004' }),
  ];
  const LEGACY: LegacyCustomerRow[] = [
    { phone: '+919800000004', first_order_at: at('2025-08-01'), last_order_at: at('2026-08-01'), order_count: 9 },
  ];

  it('judges only the customers whose 30 days are over by the end of the period', () => {
    const k = analyseRetention(scenario({ to: '2026-10-19', orders: ORDERS, legacyCustomers: LEGACY, profiles: [] })).kpis;
    expect(k.newCustomerReturn).toMatchObject({ month: '2026-09', customers: 3, eligible: 2, returned: 1, pending: 1 });
    const t = retentionSummary(analyseRetention(scenario({ to: '2026-10-19', orders: ORDERS, legacyCustomers: LEGACY, profiles: [] })));
    const name = "30-day return rate of September 2026's new customers (%)";
    expect(metric(t, name)).toBe(50);
    expect(t.rows[rowNamed(t, name)][2]).toContain('1 more');
  });

  it('counts the late arrival once the period runs long enough', () => {
    const k = analyseRetention(scenario({ orders: ORDERS, legacyCustomers: LEGACY, profiles: [] })).kpis;
    expect(k.newCustomerReturn).toMatchObject({ customers: 3, eligible: 3, returned: 2, pending: 0 });
  });
});

describe('lifecycle stages follow the marketing agent’s settings', () => {
  it('uses the win-back thresholds it is given', () => {
    const orders = [order({ id: 'x1', created_at: at('2026-10-19'), customer_phone: '9800000009' })];
    const base = { orders, profiles: [], legacyCustomers: [] };
    // One bill 12 days before the end: not yet lapsed at the 30-day default…
    expect(analyseRetention(scenario(base)).lifecycle).toMatchObject({ new: 1, lapsed: 0 });
    // …but lapsed if the owner has made the no-pattern threshold 10 days.
    const strict: WinbackParamsBundle = { ...WINBACK, winback_1: { ...WINBACK.winback_1, default_days: 10 } };
    expect(analyseRetention(scenario({ ...base, winback: strict })).lifecycle).toMatchObject({ new: 0, lapsed: 1 });
  });

  it('summarises the at-risk regulars who have a rhythm', () => {
    const a = analyseRetention(scenario());
    expect(a.atRisk).toEqual({ count: 1, typicalGapDays: 7, minDaysAway: 15 });
    expect(analyseRetention(scenario({ orders: [], legacyCustomers: [] })).atRisk).toBeNull();
  });
});

// ── Coupons ──────────────────────────────────────────────────────────────────

const COUPONS: CouponInput = {
  coupons: [
    { id: 'c-welcome', code: 'WELCOME10', discount_type: 'percent', discount_value: 10, campaign_id: null },
    { id: 'c-flat', code: 'FLAT50', discount_type: 'flat', discount_value: 50, campaign_id: null },
    { id: 'c-wb1', code: 'WB-AAA', discount_type: 'percent', discount_value: 20, campaign_id: 'camp-1' },
    { id: 'c-wb2', code: 'WB-BBB', discount_type: 'percent', discount_value: 20, campaign_id: 'camp-1' },
  ],
  campaigns: [{ id: 'camp-1', name: 'Win-back Oct' }],
  redemptions: [
    { coupon_id: 'c-welcome', order_id: 'o7', discount_inr: 20 }, // Cara's first visit
    { coupon_id: 'c-welcome', order_id: 'o9', discount_inr: 15 }, // Dev, returning (refunded below)
    { coupon_id: 'c-welcome', order_id: 'o7b', discount_inr: 40 }, // on a cancelled bill
    { coupon_id: 'c-welcome', order_id: 'o8', discount_inr: 9 }, // September: outside the period
    { coupon_id: 'c-wb1', order_id: 'o5', discount_inr: 30 }, // Ben
    { coupon_id: 'c-wb2', order_id: 'o6', discount_inr: 24 }, // Ben
    { coupon_id: 'c-flat', order_id: 'o1', discount_inr: 50 }, // Asha's first visit
  ],
  refundedOrderIds: ['o9'],
};

describe('couponPerformance', () => {
  const t = couponPerformance(analyseRetention(scenario()), COUPONS);

  it('has the sheet’s columns, with money headers ending (INR)', () => {
    expect(t.columns).toEqual([
      'Coupon / campaign',
      'Type',
      'Value',
      'Redemptions',
      'Unique customers',
      'New customers',
      'Returning customers',
      'Discount given (INR)',
      'Bill total (INR)',
      'Avg bill (INR)',
      'Discount % of sales',
      'Redemptions on cancelled/rejected bills (excluded)',
      'Refunded bills',
    ]);
  });

  it('rolls a campaign’s machine-made codes into one row named for the campaign', () => {
    const labels = t.rows.map((r) => r[0]);
    expect(labels).toEqual(['Campaign: Win-back Oct', 'WELCOME10', 'FLAT50', 'TOTAL']);
    const i = rowNamed(t, 'Campaign: Win-back Oct');
    expect(cell(t, i, 'Type')).toBe('Percent off');
    expect(cell(t, i, 'Value')).toBe('20%');
    expect(cell(t, i, 'Redemptions')).toBe(2);
    expect(cell(t, i, 'Unique customers')).toBe(1);
    expect(cell(t, i, 'Discount given (INR)')).toBe(54);
    expect(cell(t, i, 'Bill total (INR)')).toBe(270);
    expect(cell(t, i, 'Avg bill (INR)')).toBe(135);
    expect(cell(t, i, 'Discount % of sales')).toBe(20);
  });

  it('leaves a cancelled bill’s redemption out of every figure but its own column, and ignores other months', () => {
    const i = rowNamed(t, 'WELCOME10');
    expect(cell(t, i, 'Redemptions')).toBe(2);
    expect(cell(t, i, 'Discount given (INR)')).toBe(35); // not 20 + 15 + 40 + 9
    expect(cell(t, i, 'Bill total (INR)')).toBe(290);
    expect(cell(t, i, 'Avg bill (INR)')).toBe(145);
    expect(cell(t, i, 'Discount % of sales')).toBe(12.1);
    expect(cell(t, i, 'Redemptions on cancelled/rejected bills (excluded)')).toBe(1);
    expect(cell(t, i, 'Refunded bills')).toBe(1);
    expect(cell(t, i, 'Type')).toBe('Percent off');
    expect(cell(t, i, 'Value')).toBe('10%');
  });

  it('counts a customer new when the coupon came on their first visit ever, and returning otherwise', () => {
    const welcome = rowNamed(t, 'WELCOME10');
    expect(cell(t, welcome, 'New customers')).toBe(1); // Cara
    expect(cell(t, welcome, 'Returning customers')).toBe(1); // Dev
    const campaign = rowNamed(t, 'Campaign: Win-back Oct');
    expect(cell(t, campaign, 'New customers')).toBe(0); // Ben: a Petpooja regular
    expect(cell(t, campaign, 'Returning customers')).toBe(1);
    const flat = rowNamed(t, 'FLAT50');
    expect(cell(t, flat, 'New customers')).toBe(1); // Asha
    expect(cell(t, flat, 'Value')).toBe('₹50');
    expect(cell(t, flat, 'Type')).toBe('Flat off');
  });

  it('totals the columns, counting each customer once however many coupons they used', () => {
    const i = rowNamed(t, 'TOTAL');
    expect(cell(t, i, 'Redemptions')).toBe(5);
    expect(cell(t, i, 'Unique customers')).toBe(4); // Cara, Dev, Ben, Asha
    expect(cell(t, i, 'New customers')).toBe(2);
    expect(cell(t, i, 'Returning customers')).toBe(2);
    expect(cell(t, i, 'Discount given (INR)')).toBe(139);
    expect(cell(t, i, 'Bill total (INR)')).toBe(760);
    expect(cell(t, i, 'Avg bill (INR)')).toBe(152);
    expect(cell(t, i, 'Discount % of sales')).toBe(18.3);
    expect(cell(t, i, 'Redemptions on cancelled/rejected bills (excluded)')).toBe(1);
    expect(cell(t, i, 'Refunded bills')).toBe(1);
  });

  it('shows a mixed campaign honestly rather than inventing one type or value', () => {
    const mixed: CouponInput = {
      ...COUPONS,
      coupons: COUPONS.coupons.map((c) => (c.id === 'c-wb2' ? { ...c, discount_type: 'flat', discount_value: 25 } : c)),
    };
    const m = couponPerformance(analyseRetention(scenario()), mixed);
    const i = rowNamed(m, 'Campaign: Win-back Oct');
    expect(cell(m, i, 'Type')).toBe('Mixed');
    expect(cell(m, i, 'Value')).toBe('Various');
  });

  it('names a campaign whose row is gone, and an unknown coupon, rather than dropping them', () => {
    const odd = couponPerformance(analyseRetention(scenario()), {
      coupons: [{ id: 'c-wb1', code: 'WB-AAA', discount_type: 'percent', discount_value: 20, campaign_id: 'camp-gone' }],
      campaigns: [],
      redemptions: [
        { coupon_id: 'c-wb1', order_id: 'o5', discount_inr: 30 },
        { coupon_id: 'c-missing', order_id: 'o6', discount_inr: 24 },
      ],
      refundedOrderIds: [],
    });
    expect(odd.rows.map((r) => r[0])).toEqual(['Campaign: Unnamed campaign', 'Unknown coupon', 'TOTAL']);
  });

  it('is only a TOTAL row of zeros when nothing was redeemed', () => {
    const none = couponPerformance(analyseRetention(scenario()), { coupons: [], campaigns: [], redemptions: [], refundedOrderIds: [] });
    expect(none.rows).toHaveLength(1);
    expect(none.rows[0][0]).toBe('TOTAL');
    expect(cell(none, 0, 'Redemptions')).toBe(0);
    expect(cell(none, 0, 'Discount % of sales')).toBe('');
  });

  it('lists no coupon that was redeemed only on cancelled bills', () => {
    const onlyCancelled = couponPerformance(analyseRetention(scenario()), {
      ...COUPONS,
      redemptions: [{ coupon_id: 'c-welcome', order_id: 'o7b', discount_inr: 40 }],
    });
    expect(onlyCancelled.rows.map((r) => r[0])).toEqual(['TOTAL']);
    expect(cell(onlyCancelled, 0, 'Redemptions on cancelled/rejected bills (excluded)')).toBe(1);
    expect(cell(onlyCancelled, 0, 'Discount given (INR)')).toBe(0);
  });
});

describe('couponRedemptions', () => {
  const t = couponRedemptions(analyseRetention(scenario()), COUPONS);

  it('lists each redemption in the period in time order, the cancelled bill flagged by its status', () => {
    expect(t.rows).toHaveLength(7); // six in the period + TOTAL (the September one is out)
    expect(t.rows.slice(0, 6).map((r) => r[1])).toEqual([
      'HIOC-002001', 'HIOC-002005', 'HIOC-002010', 'HIOC-002006', 'HIOC-002007', 'HIOC-002008',
    ]);
    const cancelled = t.rows.findIndex((r) => r[1] === 'HIOC-002008');
    expect(cell(t, cancelled, 'Order status')).toBe('cancelled');
    expect(cell(t, cancelled, 'New/Returning')).toBe('');
  });

  it('carries the campaign, the masked customer and new/returning', () => {
    const ben = t.rows.findIndex((r) => r[1] === 'HIOC-002005');
    expect(cell(t, ben, 'Code')).toBe('WB-AAA');
    expect(cell(t, ben, 'Campaign')).toBe('Win-back Oct');
    expect(cell(t, ben, 'Customer')).toBe('Ben');
    expect(cell(t, ben, 'Phone')).toBe('••••••4444');
    expect(cell(t, ben, 'New/Returning')).toBe('Returning');
    expect(cell(t, ben, 'Discount (INR)')).toBe(30);
    expect(cell(t, ben, 'Bill total (INR)')).toBe(150);
    const asha = t.rows.findIndex((r) => r[1] === 'HIOC-002001');
    expect(cell(t, asha, 'New/Returning')).toBe('New');
    expect(cell(t, asha, 'Campaign')).toBe('');
    expect(cell(t, asha, 'Date')).toBe('2026-10-02');
  });

  it('totals the valid redemptions only', () => {
    const total = t.rows[rowNamed(t, 'TOTAL')];
    expect(total[7]).toBe(139);
    expect(total[8]).toBe(760);
    expect(total[9]).toBe('valid orders only');
  });

  it('is only a TOTAL row with none', () => {
    const none = couponRedemptions(analyseRetention(scenario()), { coupons: [], campaigns: [], redemptions: [], refundedOrderIds: [] });
    expect(none.rows).toHaveLength(1);
  });
});

// ── Highlights ───────────────────────────────────────────────────────────────

describe('retentionHighlights', () => {
  const analysis = analyseRetention(scenario());
  const coupons = couponInsights(analyseCoupons(analysis, COUPONS));
  const full: RetentionHighlightInput = { kpis: analysis.kpis, lifecycle: analysis.lifecycle, atRisk: analysis.atRisk, coupons };

  it('says what the numbers support, at most six sentences, the most useful first', () => {
    const h = retentionHighlights(full);
    expect(h).toHaveLength(6);
    expect(h[0]).toBe('2 of the 5 customers who visited (40%) came back on more than one day.');
    expect(h[1]).toBe("0 of September 2026's 1 new customer returned within 30 days.");
    expect(h[2]).toBe("1 regular is at risk: they usually visit every 7 days but haven't been in for 15+ days.");
    expect(h[3]).toBe('Coupon WELCOME10 brought 1 new customer at ₹35 of discount each.');
    expect(h[4]).toContain('3 Petpooja regulars');
    expect(h[5]).toBe(
      'Returning customers brought 26% of the revenue from customers the café can follow (₹380 against ₹1,110 from new ones).',
    );
  });

  it('says nothing for a figure whose denominator is zero', () => {
    const empty = analyseRetention(scenario({ orders: [], legacyCustomers: [], petpoojaLapsedRegulars: 0 }));
    expect(retentionHighlights({ kpis: empty.kpis, lifecycle: empty.lifecycle, atRisk: empty.atRisk, coupons: [] })).toEqual([]);
  });

  it('drops each sentence on its own when its own denominator is zero', () => {
    const k: RetentionKpis = {
      ...full.kpis,
      newCustomerReturn: { month: '2026-09', label: 'September 2026', customers: 2, eligible: 0, returned: 0, pending: 2 },
      petpoojaLapsedRegulars: 0,
    };
    const h = retentionHighlights({ kpis: k, lifecycle: full.lifecycle, atRisk: null, coupons: [] });
    expect(h.some((s) => s.includes('within 30 days'))).toBe(false);
    expect(h.some((s) => s.includes('at risk'))).toBe(false);
    expect(h.some((s) => s.includes('Petpooja'))).toBe(false);
    expect(h.some((s) => s.includes('Coupon'))).toBe(false);
    expect(h[0]).toContain('came back on more than one day');
  });

  it('mentions the pending first-30-days customers, singular and plural correctly', () => {
    const k: RetentionKpis = {
      ...full.kpis,
      newCustomerReturn: { month: '2026-09', label: 'September 2026', customers: 3, eligible: 2, returned: 1, pending: 1 },
    };
    expect(retentionHighlights({ ...full, kpis: k })[1]).toBe(
      "1 of September 2026's 2 new customers returned within 30 days (1 more are still inside their first 30 days).",
    );
  });

  it('flags walk-ins only when they are a real share of the bills', () => {
    const base: RetentionKpis = { ...full.kpis, customers: 0, repeatRatePct: null, newCustomerReturn: { ...full.kpis.newCustomerReturn, eligible: 0 }, petpoojaLapsedRegulars: null, newRevenueInr: 0, returningRevenueInr: 0, returningCustomers: 0 };
    const quiet = retentionHighlights({ kpis: { ...base, bills: 10, walkInBills: 2 }, lifecycle: full.lifecycle, atRisk: null, coupons: [] });
    expect(quiet).toEqual([]);
    const loud = retentionHighlights({ kpis: { ...base, bills: 10, walkInBills: 4 }, lifecycle: full.lifecycle, atRisk: null, coupons: [] });
    expect(loud).toHaveLength(1);
    expect(loud[0]).toContain('40% of bills (4) had no name, phone or account');
    expect(retentionHighlights({ kpis: { ...base, bills: 0, walkInBills: 0 }, lifecycle: full.lifecycle, atRisk: null, coupons: [] })).toEqual([]);
  });

  it('names a campaign as a campaign, and picks the coupon that brought the most new customers', () => {
    const h = retentionHighlights({
      ...full,
      coupons: [
        { label: 'A', kind: 'coupon', name: 'A', redemptions: 9, uniqueCustomers: 9, newCustomers: 1, discountInr: 90, billTotalInr: 900, discountPct: 10, costPerNewCustomerInr: 90 },
        { label: 'Campaign: Big', kind: 'campaign', name: 'Big', redemptions: 5, uniqueCustomers: 5, newCustomers: 4, discountInr: 400, billTotalInr: 1500, discountPct: 26.7, costPerNewCustomerInr: 100 },
        { label: 'Z', kind: 'coupon', name: 'Z', redemptions: 2, uniqueCustomers: 2, newCustomers: 0, discountInr: 10, billTotalInr: 200, discountPct: 5, costPerNewCustomerInr: null },
      ],
    });
    expect(h).toContain('Campaign Big brought 4 new customers at ₹100 of discount each.');
  });

  it('formats rupees with Indian grouping', () => {
    const h = retentionHighlights({
      ...full,
      coupons: [
        { label: 'BIG', kind: 'coupon', name: 'BIG', redemptions: 1, uniqueCustomers: 1, newCustomers: 1, discountInr: 123456, billTotalInr: 900000, discountPct: 13.7, costPerNewCustomerInr: 123456 },
      ],
    });
    expect(h.some((s) => s.includes('₹1,23,456'))).toBe(true);
  });
});

describe('couponInsights', () => {
  it('works out the discount per new customer, and none when a coupon brought nobody new', () => {
    const insights = couponInsights(analyseCoupons(analyseRetention(scenario()), COUPONS));
    expect(insights.find((c) => c.name === 'WELCOME10')).toMatchObject({ newCustomers: 1, costPerNewCustomerInr: 35, kind: 'coupon' });
    expect(insights.find((c) => c.name === 'Win-back Oct')).toMatchObject({ newCustomers: 0, costPerNewCustomerInr: null, kind: 'campaign' });
  });
});

// ── The registry's loaders, over an in-memory database ───────────────────────

type Row = Record<string, unknown>;
type QueryError = { code: string; message: string };

const PROFILES_COLUMNS = ['id', 'name', 'phone', 'phone_verified', 'role'];
const ORDERS_COLUMNS = [
  'id', 'order_number', 'created_at', 'status', 'channel', 'user_id', 'customer_user_id', 'customer_phone',
  'customer_name', 'total_inr', 'discount_inr', 'subtotal_inr', 'tax_inr',
];

/** The columns each table has. A table not named here is missing (42P01); a column not named is missing (42703). */
const FULL_SCHEMA: Record<string, string[]> = {
  orders: ORDERS_COLUMNS,
  profiles: PROFILES_COLUMNS,
  legacy_orders: ['id', 'customer_phone', 'ordered_at', 'total_inr', 'status'],
  legacy_customers: ['phone', 'name', 'first_order_at', 'last_order_at', 'order_count', 'total_spend_inr'],
  coupons: ['id', 'code', 'discount_type', 'discount_value', 'campaign_id'],
  coupon_redemptions: ['id', 'coupon_id', 'order_id', 'discount_inr', 'created_at'],
  marketing_campaigns: ['id', 'name'],
  marketing_playbooks: ['key', 'mode', 'params'],
  refunds: ['id', 'order_id', 'status'],
};

interface Call {
  table: string;
  select: string;
  inSizes: number[];
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: QueryError | null }> {
  private preds: ((r: Row) => boolean)[] = [];
  private cols: string[] = [];
  private error: QueryError | null = null;
  private orders: string[] = [];
  private span: [number, number] | null = null;
  private call: Call;

  constructor(
    private readonly table: string,
    private readonly rows: Row[],
    private readonly schema: string[] | undefined,
    calls: Call[],
  ) {
    this.call = { table, select: '', inSizes: [] };
    calls.push(this.call);
    if (!schema) this.error = { code: '42P01', message: `relation "public.${table}" does not exist` };
  }

  select(list: string) {
    this.call.select = list;
    this.cols = list.split(',').map((c) => c.trim());
    if (this.schema && !this.cols.includes('*')) {
      const bad = this.cols.find((c) => !this.schema!.includes(c));
      if (bad) this.error = { code: '42703', message: `column ${this.table}.${bad} does not exist` };
    }
    return this;
  }
  private cmp(c: string, v: unknown, ok: (d: number) => boolean) {
    this.preds.push((r) => r[c] !== null && r[c] !== undefined && ok(compare(r[c], v)));
    return this;
  }
  eq(c: string, v: unknown) {
    this.preds.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.preds.push((r) => r[c] !== null && r[c] !== undefined && r[c] !== v);
    return this;
  }
  in(c: string, vals: unknown[]) {
    this.call.inSizes.push(vals.length);
    this.preds.push((r) => vals.includes(r[c]));
    return this;
  }
  gte(c: string, v: unknown) {
    return this.cmp(c, v, (d) => d >= 0);
  }
  gt(c: string, v: unknown) {
    return this.cmp(c, v, (d) => d > 0);
  }
  lte(c: string, v: unknown) {
    return this.cmp(c, v, (d) => d <= 0);
  }
  lt(c: string, v: unknown) {
    return this.cmp(c, v, (d) => d < 0);
  }
  not(c: string, op: string, v: unknown) {
    if (op !== 'is' || v !== null) throw new Error(`fake: unsupported not(${c}, ${op})`);
    this.preds.push((r) => r[c] !== null && r[c] !== undefined);
    return this;
  }
  order(c: string) {
    this.orders.push(c);
    return this;
  }
  range(from: number, to: number) {
    this.span = [from, to];
    return this;
  }

  private run(): { data: Row[] | null; error: QueryError | null } {
    if (this.error) return { data: null, error: this.error };
    let rows = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.orders.length) {
      rows = [...rows].sort((a, b) => {
        for (const c of this.orders) {
          const d = compare(a[c] ?? '', b[c] ?? '');
          if (d !== 0) return d;
        }
        return 0;
      });
    }
    if (this.span) rows = rows.slice(this.span[0], this.span[1] + 1);
    const star = this.cols.includes('*');
    return { data: rows.map((r) => (star ? { ...r } : Object.fromEntries(this.cols.map((c) => [c, r[c] ?? null])))), error: null };
  }

  then<T1 = { data: Row[] | null; error: QueryError | null }, T2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: QueryError | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

function fakeDb(tables: Record<string, Row[]>, schema: Record<string, string[]> = FULL_SCHEMA) {
  const calls: Call[] = [];
  const client = { from: (table: string) => new FakeQuery(table, tables[table] ?? [], schema[table], calls) };
  return { db: client as unknown as SupabaseClient, calls };
}

function key(k: string) {
  const def = RETENTION_REPORTS.find((r) => r.key === k);
  if (!def) throw new Error(`no report ${k}`);
  return def;
}

/** A small world: Asha (account), Ben (Petpooja regular, phone-only), Cara (new), a walk-in, a staff order. */
const WORLD: Record<string, Row[]> = {
  profiles: [
    { id: 'acct-asha', name: 'Asha Rao', phone: '+919811111111', phone_verified: true, role: 'customer' },
    { id: 'staff-1', name: 'Staff One', phone: '+919899999999', phone_verified: true, role: 'staff' },
  ],
  orders: [
    { id: 'a1', order_number: 3001, created_at: at('2026-09-20'), status: 'completed', channel: 'customer_web', user_id: 'acct-asha', customer_user_id: null, customer_phone: '', customer_name: '', total_inr: 150, discount_inr: 0 },
    { id: 'a2', order_number: 3002, created_at: at('2026-10-05'), status: 'completed', channel: 'customer_web', user_id: 'acct-asha', customer_user_id: null, customer_phone: '', customer_name: '', total_inr: 200, discount_inr: 20 },
    { id: 'b1', order_number: 3003, created_at: at('2026-10-06'), status: 'completed', channel: 'staff_pos', user_id: null, customer_user_id: null, customer_phone: '9844444444', customer_name: 'Ben', total_inr: 120, discount_inr: 0 },
    { id: 'c1', order_number: 3004, created_at: at('2026-10-07'), status: 'completed', channel: 'staff_pos', user_id: null, customer_user_id: null, customer_phone: '+919855555555', customer_name: 'Cara', total_inr: 90, discount_inr: 9 },
    { id: 'w1', order_number: 3005, created_at: at('2026-10-08'), status: 'completed', channel: 'staff_pos', user_id: null, customer_user_id: null, customer_phone: '', customer_name: '', total_inr: 60, discount_inr: 0 },
    { id: 's1', order_number: 3006, created_at: at('2026-10-09'), status: 'completed', channel: 'customer_web', user_id: 'staff-1', customer_user_id: null, customer_phone: '', customer_name: '', total_inr: 40, discount_inr: 0 },
    { id: 'x1', order_number: 3007, created_at: at('2026-10-10'), status: 'cancelled', channel: 'staff_pos', user_id: null, customer_user_id: null, customer_phone: '+919855555555', customer_name: 'Cara', total_inr: 70, discount_inr: 7 },
  ],
  legacy_customers: [
    { phone: '+919844444444', name: 'Ben P', first_order_at: at('2025-03-04'), last_order_at: at('2026-09-15'), order_count: 12, total_spend_inr: 4000 },
    // A regular who has not been back: lapsed as of Oct 31 (last bill 2026-08-20, 8 bills).
    { phone: '+919811100000', name: 'Gone Regular', first_order_at: at('2024-01-01'), last_order_at: at('2026-08-20'), order_count: 8, total_spend_inr: 2000 },
    // Another with the same history but who ordered in the app recently (on Asha's verified number).
    { phone: '+919811111111', name: 'Asha Old', first_order_at: at('2024-06-01'), last_order_at: at('2026-07-01'), order_count: 6, total_spend_inr: 1500 },
    // Too few bills to be a regular.
    { phone: '+919811100001', name: 'Rare', first_order_at: at('2024-01-01'), last_order_at: at('2026-07-01'), order_count: 2, total_spend_inr: 200 },
  ],
  legacy_orders: [
    { id: 'l1', customer_phone: '+919844444444', ordered_at: at('2026-09-15'), total_inr: 130, status: 'completed' },
    { id: 'l2', customer_phone: '+919844444444', ordered_at: at('2026-09-01'), total_inr: 110, status: 'cancelled' },
    { id: 'l3', customer_phone: null, ordered_at: at('2026-09-02'), total_inr: 80, status: 'completed' },
    { id: 'l4', customer_phone: '+919811100000', ordered_at: at('2026-08-20'), total_inr: 100, status: 'completed' },
  ],
  coupons: [
    { id: 'c-w', code: 'WELCOME10', discount_type: 'percent', discount_value: 10, campaign_id: null },
    { id: 'c-m', code: 'WB-X', discount_type: 'percent', discount_value: 20, campaign_id: 'camp-1' },
  ],
  coupon_redemptions: [
    { id: 'r1', coupon_id: 'c-w', order_id: 'c1', discount_inr: 9, created_at: at('2026-10-07') },
    { id: 'r2', coupon_id: 'c-w', order_id: 'x1', discount_inr: 7, created_at: at('2026-10-10') },
    { id: 'r3', coupon_id: 'c-m', order_id: 'a2', discount_inr: 20, created_at: at('2026-10-05') },
    { id: 'r4', coupon_id: 'c-w', order_id: 'a1', discount_inr: 5, created_at: at('2026-09-20') },
  ],
  marketing_campaigns: [{ id: 'camp-1', name: 'Win-back Oct' }],
  refunds: [{ id: 'f1', order_id: 'a2', status: 'processed' }, { id: 'f2', order_id: 'c1', status: 'pending' }],
};

describe('RETENTION_REPORTS', () => {
  it('registers exactly the five retention keys in the loyalty group, each with a title and description', () => {
    expect(RETENTION_REPORTS.map((r) => r.key)).toEqual([
      'retention-summary',
      'customer-visits',
      'cohort-retention',
      'coupon-performance',
      'coupon-redemptions',
    ]);
    for (const r of RETENTION_REPORTS) {
      expect(r.group).toBe('loyalty');
      expect(r.title.length).toBeGreaterThan(3);
      expect(r.description.length).toBeGreaterThan(20);
    }
  });
});

describe('RETENTION_REPORTS loaders over the in-memory database', () => {
  it('summarises the month with Petpooja history, staff left out and cancelled bills not counted', async () => {
    const { db } = fakeDb(WORLD);
    const t = await key('retention-summary').load(db, '2026-10-01', '2026-10-31');
    // Asha (account, and her Petpooja years), Ben and Cara; the walk-in and the staff order are nobody.
    expect(metric(t, 'Customers who visited')).toBe(3);
    expect(metric(t, 'New customers')).toBe(1); // Cara
    expect(metric(t, 'Returning customers')).toBe(2); // Asha, Ben (both with Petpooja history)
    expect(metric(t, 'Bills in the period')).toBe(5);
    expect(metric(t, 'Bills from walk-ins')).toBe(1);
    expect(metric(t, 'Bills linked to a customer')).toBe(3);
  });

  it('counts the Petpooja regulars gone quiet, leaving out those who have ordered in the app lately', async () => {
    const { db } = fakeDb(WORLD);
    const t = await key('retention-summary').load(db, '2026-10-01', '2026-10-31');
    // 'Gone Regular' (8 bills, last 2026-08-20) is lapsed; Asha's number has an app order; Rare has 2 bills; Ben was in Sep.
    expect(metric(t, 'Petpooja regulars who have lapsed')).toBe(1);
  });

  it('joins a phone-only app order to the Petpooja customer it belongs to', async () => {
    const { db } = fakeDb(WORLD);
    const t = await key('customer-visits').load(db, '2026-10-01', '2026-10-31');
    const ben = t.rows.findIndex((r) => r[0] === 'Ben');
    expect(ben).toBeGreaterThanOrEqual(0);
    expect(cell(t, ben, 'First visit ever')).toBe('2025-03-04');
    expect(cell(t, ben, 'New this period')).toBe('No');
    expect(cell(t, ben, 'Visits all time (app + Petpooja)')).toBe(13);
    expect(cell(t, ben, 'Phone')).toBe('••••••4444');
    const asha = t.rows.findIndex((r) => r[0] === 'Asha Rao');
    expect(cell(t, asha, 'First visit ever')).toBe('2024-06-01');
  });

  it('builds the cohort table from Petpooja and app visits together', async () => {
    const { db } = fakeDb(WORLD);
    const t = await key('cohort-retention').load(db, '2026-10-01', '2026-10-31');
    expect(t.rows).toHaveLength(12);
    // Cara is the only first-timer in October.
    expect(cell(t, rowNamed(t, 'Oct 2026'), 'New customers')).toBe(1);
  });

  it('rolls campaign codes up, drops the cancelled bill from the money and the September redemption entirely', async () => {
    const { db } = fakeDb(WORLD);
    const t = await key('coupon-performance').load(db, '2026-10-01', '2026-10-31');
    expect(t.rows.map((r) => r[0])).toEqual(['Campaign: Win-back Oct', 'WELCOME10', 'TOTAL']);
    expect(cell(t, 0, 'Refunded bills')).toBe(1); // a2 has a processed refund
    expect(cell(t, 1, 'Redemptions')).toBe(1);
    expect(cell(t, 1, 'Redemptions on cancelled/rejected bills (excluded)')).toBe(1);
    expect(cell(t, 1, 'New customers')).toBe(1); // Cara's first visit
    expect(cell(t, 2, 'Discount given (INR)')).toBe(29);
  });

  it('lists every redemption in the period, the cancelled one included', async () => {
    const { db } = fakeDb(WORLD);
    const t = await key('coupon-redemptions').load(db, '2026-10-01', '2026-10-31');
    expect(t.rows.map((r) => r[1])).toEqual(['HIOC-003002', 'HIOC-003004', 'HIOC-003007', '']);
  });

  it('reads the lookback year and nothing wider, and only identity columns of the orders', async () => {
    const { db, calls } = fakeDb(WORLD);
    await key('customer-visits').load(db, '2026-10-01', '2026-10-31');
    const orderCalls = calls.filter((c) => c.table === 'orders');
    expect(orderCalls.length).toBeGreaterThan(0);
    for (const c of orderCalls) {
      expect(c.select).not.toMatch(/subtotal|tax_inr|packaging|payment/);
      expect(c.select).toContain('customer_phone');
    }
  });

  it('degrades to what the database has: no Petpooja, marketing, coupon or refund tables, no customer_user_id column', async () => {
    const schema: Record<string, string[]> = {
      orders: ORDERS_COLUMNS.filter((c) => c !== 'customer_user_id'),
      profiles: PROFILES_COLUMNS,
    };
    const { db } = fakeDb({ orders: WORLD.orders, profiles: WORLD.profiles }, schema);
    const summary = await key('retention-summary').load(db, '2026-10-01', '2026-10-31');
    // Without Petpooja history Ben and Asha look new again; nothing throws.
    expect(metric(summary, 'Customers who visited')).toBe(3);
    expect(metric(summary, 'Returning customers')).toBe(1); // Asha: her own September order
    expect(metric(summary, 'Petpooja regulars who have lapsed')).toBe('');
    const coupons = await key('coupon-performance').load(db, '2026-10-01', '2026-10-31');
    expect(coupons.rows.map((r) => r[0])).toEqual(['TOTAL']);
    const redemptions = await key('coupon-redemptions').load(db, '2026-10-01', '2026-10-31');
    expect(redemptions.rows).toHaveLength(1);
    await expect(key('cohort-retention').load(db, '2026-10-01', '2026-10-31')).resolves.toBeDefined();
  });

  it('degrades without the campaign column or table: codes stay their own rows', async () => {
    const schema = { ...FULL_SCHEMA, coupons: ['id', 'code', 'discount_type', 'discount_value'] };
    delete (schema as Record<string, string[] | undefined>).marketing_campaigns;
    const { db } = fakeDb(WORLD, schema);
    const t = await key('coupon-performance').load(db, '2026-10-01', '2026-10-31');
    expect(t.rows.map((r) => r[0])).toEqual(['WB-X', 'WELCOME10', 'TOTAL']);
  });

  it('throws on a real database error instead of reporting a quiet month', async () => {
    const { db } = fakeDb(WORLD);
    const broken = {
      from: (table: string) => {
        if (table === 'orders') {
          const q = (db as unknown as { from: (t: string) => FakeQuery }).from(table);
          (q as unknown as { error: QueryError }).error = { code: '57014', message: 'canceling statement due to statement timeout' };
          return q;
        }
        return (db as unknown as { from: (t: string) => FakeQuery }).from(table);
      },
    } as unknown as SupabaseClient;
    await expect(key('customer-visits').load(broken, '2026-10-01', '2026-10-31')).rejects.toThrow(/statement timeout/);
  });

  it('is an empty-but-valid sheet for a range with no orders', async () => {
    const { db } = fakeDb({ ...WORLD, orders: [] });
    for (const r of RETENTION_REPORTS) {
      const t = await r.load(db, '2026-10-01', '2026-10-31');
      expect(t.columns.length).toBeGreaterThan(1);
      for (const row of t.rows) expect(row).toHaveLength(t.columns.length);
    }
  });

  it('uses the owner’s marketing win-back settings for the lifecycle when the playbooks exist', async () => {
    const tables: Record<string, Row[]> = {
      ...WORLD,
      orders: [
        { id: 'z1', order_number: 4001, created_at: at('2026-10-19'), status: 'completed', channel: 'staff_pos', user_id: null, customer_user_id: null, customer_phone: '+919800000009', customer_name: 'Zed', total_inr: 50, discount_inr: 0 },
      ],
      legacy_customers: [],
      legacy_orders: [],
    };
    const stage = async (rows: Row[]) => {
      const { db } = fakeDb({ ...tables, marketing_playbooks: rows });
      const t = await key('customer-visits').load(db, '2026-10-01', '2026-10-31');
      return cell(t, 0, 'Lifecycle stage');
    };
    expect(await stage([])).toBe('New');
    expect(await stage([{ key: 'winback_1', mode: 'off', params: { default_days: 10 } }])).toBe('Lapsed');
  });
});

describe('the loaders at volume', () => {
  it('pages past PostgREST’s 1,000-row cap and chunks every .in() list', async () => {
    const profiles: Row[] = [];
    const orders: Row[] = [];
    for (let i = 0; i < 1100; i++) {
      const account = i < 450;
      const id = `acct-${i}`;
      if (account) profiles.push({ id, name: `C${i}`, phone: `+9190000${String(i).padStart(5, '0')}`, phone_verified: true, role: 'customer' });
      orders.push({
        id: `v${i}`,
        order_number: 5000 + i,
        created_at: at('2026-10-15', `${String(8 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`),
        status: 'completed',
        channel: 'customer_web',
        user_id: account ? id : null,
        customer_user_id: null,
        // The phone-only half: unique valid mobiles.
        customer_phone: account ? '' : `+9198${String(i).padStart(8, '0')}`,
        customer_name: '',
        total_inr: 100,
        discount_inr: 0,
      });
    }
    const { db, calls } = fakeDb({ orders, profiles });
    const t = await key('retention-summary').load(db, '2026-10-01', '2026-10-31');
    expect(metric(t, 'Customers who visited')).toBe(1100);
    expect(metric(t, 'New customers')).toBe(1100);
    expect(metric(t, 'Bills in the period')).toBe(1100);
    for (const c of calls) for (const n of c.inSizes) expect(n).toBeLessThanOrEqual(200);
    expect(calls.filter((c) => c.table === 'orders').length).toBeGreaterThanOrEqual(2); // two pages of orders
  });
});

describe('loadRetentionInsights', () => {
  it('returns the KPIs, cohorts, lifecycle, top coupons and highlights for the page', async () => {
    const { db } = fakeDb(WORLD);
    const insights = await loadRetentionInsights(db, '2026-10-01', '2026-10-31');
    expect(insights.range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(insights.kpis).toMatchObject({ customers: 3, newCustomers: 1, returningCustomers: 2, petpoojaLapsedRegulars: 1 });
    expect(insights.cohorts).toHaveLength(12);
    expect(insights.lifecycle.total).toBeGreaterThan(0);
    expect(insights.coupons.map((c) => c.label)).toEqual(['Campaign: Win-back Oct', 'WELCOME10']);
    expect(insights.highlights.length).toBeGreaterThan(0);
    expect(insights.highlights.length).toBeLessThanOrEqual(6);
    expect(insights.highlights.join(' ')).toContain('Petpooja');
  });

  it('is quiet, not broken, for an empty range', async () => {
    const { db } = fakeDb({ profiles: [], orders: [] });
    const insights = await loadRetentionInsights(db, '2026-10-01', '2026-10-31');
    expect(insights.kpis.customers).toBe(0);
    expect(insights.coupons).toEqual([]);
    expect(insights.highlights).toEqual([]);
    expect(insights.atRisk).toBeNull();
  });
});
