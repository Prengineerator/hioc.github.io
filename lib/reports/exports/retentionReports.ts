// Retention, repeat-visit, cohort and coupon sheets for the owner's downloads
// (Owner → Reports → Downloads → Loyalty, promotions & retention), and the
// numbers behind the Insights page. Pure: the server loader
// (retentionReportsServer.ts) reads the rows; who a customer is and when their
// first visit was lives in customerIdentity.ts.
//
// Definitions, all reused rather than invented:
//   • Orders count when valid (not cancelled or rejected), dated by the IST day
//     they were placed. A VISIT is an IST day with at least one bill.
//   • "Walk-in / counter customer / online" is classifyOrderKind
//     (lib/analytics/customerSegments.ts), the split the owner's dashboard shows.
//   • The typical gap between visits is typicalGapDays and the lifecycle stage
//     (new / active / at risk / lapsed / lost) is lifecycleStage, both from
//     lib/marketing/segments.ts, with the win-back settings the marketing agent
//     uses — so this report and the marketing screens call the same customer
//     "at risk". Petpooja regulars who have lapsed use lib/legacy/ownerStats.ts
//     (the server counts them; the number comes in as input).
//   • A coupon is redeemed on an order; coupon_redemptions is NOT reversed when
//     the order is cancelled, so every figure joins the order and drops the
//     cancelled and rejected ones (counted apart). Machine-made marketing codes
//     (coupons.campaign_id) roll up into one row per campaign.
//
// Phones are shown masked to their last four digits (lib/passes/summary.ts
// maskPhone). Money headers end in "(INR)"; percentages are to 1 dp; dates are IST.

import { round2, type CsvTable, type CsvValue } from '@/lib/reports/csv';
import { classifyOrderKind, segmentForKind, type CustomerOrderInput } from '@/lib/analytics/customerSegments';
import { addDaysToIstDate, daysBetweenIstDates } from '@/lib/marketing/ist';
import { isValidOrderStatus, lifecycleStage, stageThresholds, typicalGapDays } from '@/lib/marketing/segments';
import type { LifecycleStage, WinbackParamsBundle } from '@/lib/marketing/types';
import { maskPhone } from '@/lib/passes/summary';
import { istDateOf, rangeBounds } from '@/lib/reports/reconcile';
import {
  addMonthsToDate,
  buildCustomerBook,
  type AppOrderRow,
  type CustomerBook,
  type LegacyBillRow,
  type LegacyCustomerRow,
  type Person,
  type ProfileRow,
} from '@/lib/reports/exports/customerIdentity';
import { formatOrderNumber } from '@/lib/utils/orderNumber';

export const COHORT_MONTHS = 12;
export const COHORT_FOLLOW_MONTHS = 6;
/** A customer is "returned" when they come back within this many days of their first visit. */
export const RETURN_WINDOW_DAYS = 30;
/** Share of bills with nobody attached above which the walk-in highlight is worth saying. */
const WALK_IN_HIGHLIGHT_SHARE = 0.25;

// ── Input ────────────────────────────────────────────────────────────────────

export interface RetentionInput {
  /** IST dates, inclusive. */
  from: string;
  to: string;
  profiles: ProfileRow[];
  /** App orders of any status from the lookback start (12 months before `from`) to the end of `to`. */
  orders: AppOrderRow[];
  /** Completed Petpooja bills with a phone, same window. */
  legacyBills: LegacyBillRow[];
  /** Petpooja customers for the people seen (all-time first/last bill and bill count). */
  legacyCustomers: LegacyCustomerRow[];
  winback: WinbackParamsBundle;
  /** Petpooja regulars (5+ bills, none for 60+ days, no app order since) at the end of `to`; null when it could not be read. */
  petpoojaLapsedRegulars: number | null;
}

export interface CouponRow {
  id: string;
  code: string;
  discount_type: string;
  discount_value: number | null;
  /** coupons.campaign_id (2026-10-marketing-agent.sql); absent before it. */
  campaign_id?: string | null;
}

export interface CampaignRow {
  id: string;
  name: string;
}

export interface RedemptionRow {
  coupon_id: string;
  order_id: string;
  discount_inr: number | null;
}

export interface CouponInput {
  coupons: CouponRow[];
  campaigns: CampaignRow[];
  redemptions: RedemptionRow[];
  /** Orders with at least one processed refund. */
  refundedOrderIds: string[];
}

// ── The analysis ─────────────────────────────────────────────────────────────

export interface PersonStats {
  person: Person;
  /** Distinct visit dates up to `to`, ascending. */
  visitDates: string[];
  visitsInPeriod: number;
  billsInPeriod: number;
  spendInPeriodInr: number;
  /** First visit ever falls in the period. */
  isNew: boolean;
  lastVisitDate: string;
  /** Whole days from the last visit to the end of the period. */
  daysSinceLast: number;
  typicalGap: number | null;
  stage: LifecycleStage;
  /** Visit days in the app, plus Petpooja bills. */
  allTimeVisits: number;
}

export interface CohortRow {
  /** 'YYYY-MM' of the first visit. */
  month: string;
  /** 'Oct 2025'. */
  label: string;
  customers: number;
  /** [Month 1 … Month 6]: % of the cohort seen in that later month; null when the month is not over yet (or the cohort is empty). */
  retention: (number | null)[];
}

export interface LifecycleCounts {
  /** One bill so far and not lapsed. */
  new: number;
  active: number;
  atRisk: number;
  /** All three lapsed stages. */
  lapsed: number;
  lost: number;
  total: number;
}

/** The at-risk customers who have a rhythm (3+ bills): the ones with a "usually every G days" to point at. */
export interface AtRiskSummary {
  count: number;
  /** Median of their typical gaps, whole days. */
  typicalGapDays: number;
  /** The shortest time any of them has been away. */
  minDaysAway: number;
}

export interface NewCustomerReturn {
  /** 'YYYY-MM' of the cohort: the month before the period's first month. */
  month: string;
  label: string;
  /** First-time customers that month. */
  customers: number;
  /** Those whose 30 days are over by the end of the period. */
  eligible: number;
  returned: number;
  /** customers − eligible: still inside their first 30 days. */
  pending: number;
}

export interface RetentionKpis {
  customers: number;
  newCustomers: number;
  returningCustomers: number;
  newRevenueInr: number;
  returningRevenueInr: number;
  repeatCustomers: number;
  repeatRatePct: number | null;
  avgVisitsPerCustomer: number | null;
  avgGapDays: number | null;
  avgBillNewInr: number | null;
  avgBillReturningInr: number | null;
  /** Valid app bills in the period. */
  bills: number;
  walkInBills: number;
  /** Counter bills with a name, a phone or an account. */
  counterBills: number;
  /** Online and table QR bills. */
  onlineBills: number;
  /** Bills the report can follow to a person. */
  trackedBills: number;
  petpoojaLapsedRegulars: number | null;
  newCustomerReturn: NewCustomerReturn;
}

export interface RetentionAnalysis {
  input: RetentionInput;
  book: CustomerBook;
  /** Everyone with a visit up to the end of the period. */
  stats: PersonStats[];
  /** Those who visited in the period, most visits first. */
  seen: PersonStats[];
  /** Orders (any status) placed in the period. */
  periodOrders: AppOrderRow[];
  kpis: RetentionKpis;
  lifecycle: LifecycleCounts;
  atRisk: AtRiskSummary | null;
  cohorts: CohortRow[];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
];

const monthOf = (date: string): string => date.slice(0, 7);
const monthIndex = (ym: string): number => Number(ym.slice(5, 7)) - 1;
/** 'YYYY-MM' moved by whole months. */
const addMonths = (ym: string, n: number): string => addMonthsToDate(`${ym}-01`, n).slice(0, 7);
const monthLabel = (ym: string): string => `${MONTH_NAMES[monthIndex(ym)]} ${ym.slice(0, 4)}`;
const fullMonthLabel = (ym: string): string => `${FULL_MONTH_NAMES[monthIndex(ym)]} ${ym.slice(0, 4)}`;
/** The last IST day of a month, 'YYYY-MM-DD'. */
const monthEnd = (ym: string): string => addDaysToIstDate(`${addMonths(ym, 1)}-01`, -1);

const ms = (iso: string): number => Date.parse(iso);
const pct1 = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const perOrNull = (total: number, count: number): number | null => (count > 0 ? round2(total / count) : null);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Works out every figure the retention sheets and the Insights page share. */
export function analyseRetention(input: RetentionInput): RetentionAnalysis {
  const { from, to } = input;
  const endMs = ms(rangeBounds(from, to).endIso);
  const book = buildCustomerBook(input);

  const stats: PersonStats[] = [];
  for (const person of book.people.values()) {
    const visits = person.visits.filter((v) => v.date <= to);
    if (visits.length === 0) continue;
    const inPeriod = visits.filter((v) => v.date >= from);
    const visitDates = [...new Set(visits.map((v) => v.date))].sort();
    const lastVisitDate = visitDates[visitDates.length - 1];

    const appBills = visits.filter((v) => v.source === 'app').length;
    const petpoojaRead = visits.length - appBills;
    const legacy = person.legacy;
    // The Petpooja count is the all-time one once the person's last Petpooja bill is
    // before the end of the period; if a later bill exists, only what was read counts.
    const petpoojaBills =
      legacy?.lastOrderAt && ms(legacy.lastOrderAt) < endMs ? Math.max(legacy.orderCount, petpoojaRead) : petpoojaRead;
    const appDays = new Set(visits.filter((v) => v.source === 'app').map((v) => v.date)).size;

    const typicalGap = typicalGapDays(visits.map((v) => v.at));
    const daysSinceLast = Math.max(0, daysBetweenIstDates(lastVisitDate, to));

    stats.push({
      person,
      visitDates,
      visitsInPeriod: new Set(inPeriod.map((v) => v.date)).size,
      billsInPeriod: inPeriod.length,
      spendInPeriodInr: round2(inPeriod.reduce((s, v) => s + v.totalInr, 0)),
      isNew: person.firstVisitDate >= from && person.firstVisitDate <= to,
      lastVisitDate,
      daysSinceLast,
      typicalGap,
      stage: lifecycleStage(appBills + petpoojaBills, daysSinceLast, stageThresholds(typicalGap, input.winback)),
      allTimeVisits: appDays + (legacy ? Math.max(legacy.orderCount, petpoojaRead) : petpoojaRead),
    });
  }

  const seen = stats
    .filter((s) => s.billsInPeriod > 0)
    .sort(
      (a, b) =>
        b.visitsInPeriod - a.visitsInPeriod ||
        b.spendInPeriodInr - a.spendInPeriodInr ||
        a.person.name.localeCompare(b.person.name) ||
        a.person.key.localeCompare(b.person.key),
    );

  const periodOrders = input.orders.filter((o) => {
    const d = istDateOf(o.created_at);
    return d >= from && d <= to;
  });

  return {
    input,
    book,
    stats,
    seen,
    periodOrders,
    kpis: kpisOf(input, book, seen, periodOrders, stats),
    lifecycle: lifecycleCounts(stats),
    atRisk: atRiskOf(stats),
    cohorts: cohortsOf(stats, to),
  };
}

function kpisOf(
  input: RetentionInput,
  book: CustomerBook,
  seen: PersonStats[],
  periodOrders: AppOrderRow[],
  stats: PersonStats[],
): RetentionKpis {
  const fresh = seen.filter((s) => s.isNew);
  const back = seen.filter((s) => !s.isNew);
  const sum = (xs: PersonStats[], f: (s: PersonStats) => number) => round2(xs.reduce((t, s) => t + f(s), 0));
  const newRevenueInr = sum(fresh, (s) => s.spendInPeriodInr);
  const returningRevenueInr = sum(back, (s) => s.spendInPeriodInr);
  const repeatCustomers = seen.filter((s) => s.visitsInPeriod >= 2).length;
  const gaps = seen.map((s) => s.typicalGap).filter((g): g is number => g !== null);

  const validOrders = periodOrders.filter((o) => isValidOrderStatus(o.status));
  const segments = { walk_in: 0, identified: 0, online: 0 };
  for (const o of validOrders) segments[segmentForKind(classifyOrderKind(o as unknown as CustomerOrderInput))] += 1;

  return {
    customers: seen.length,
    newCustomers: fresh.length,
    returningCustomers: back.length,
    newRevenueInr,
    returningRevenueInr,
    repeatCustomers,
    repeatRatePct: pct1(repeatCustomers, seen.length),
    avgVisitsPerCustomer: seen.length > 0 ? round1(sum(seen, (s) => s.visitsInPeriod) / seen.length) : null,
    avgGapDays: gaps.length > 0 ? round1(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
    avgBillNewInr: perOrNull(newRevenueInr, fresh.reduce((t, s) => t + s.billsInPeriod, 0)),
    avgBillReturningInr: perOrNull(returningRevenueInr, back.reduce((t, s) => t + s.billsInPeriod, 0)),
    bills: validOrders.length,
    walkInBills: segments.walk_in,
    counterBills: segments.identified,
    onlineBills: segments.online,
    trackedBills: validOrders.filter((o) => book.keyByOrderId.get(o.id)).length,
    petpoojaLapsedRegulars: input.petpoojaLapsedRegulars,
    newCustomerReturn: newCustomerReturn(stats, input.from, input.to),
  };
}

/** The month before the period's first month: how many of its first-timers came back within 30 days. */
function newCustomerReturn(stats: PersonStats[], from: string, to: string): NewCustomerReturn {
  const month = addMonths(monthOf(from), -1);
  const cohort = stats.filter((s) => monthOf(s.person.firstVisitDate) === month);
  // Only people whose 30 days are over by the end of the period can be judged.
  const eligible = cohort.filter((s) => addDaysToIstDate(s.person.firstVisitDate, RETURN_WINDOW_DAYS) <= to);
  const returned = eligible.filter((s) => {
    const last = addDaysToIstDate(s.person.firstVisitDate, RETURN_WINDOW_DAYS);
    return s.visitDates.some((d) => d > s.person.firstVisitDate && d <= last);
  });
  return {
    month,
    label: fullMonthLabel(month),
    customers: cohort.length,
    eligible: eligible.length,
    returned: returned.length,
    pending: cohort.length - eligible.length,
  };
}

function lifecycleCounts(stats: PersonStats[]): LifecycleCounts {
  const out: LifecycleCounts = { new: 0, active: 0, atRisk: 0, lapsed: 0, lost: 0, total: 0 };
  for (const s of stats) {
    switch (s.stage) {
      case 'new':
        out.new += 1;
        break;
      case 'active':
        out.active += 1;
        break;
      case 'at_risk':
        out.atRisk += 1;
        break;
      case 'lapsed_1':
      case 'lapsed_2':
      case 'lapsed_3':
        out.lapsed += 1;
        break;
      case 'lost':
        out.lost += 1;
        break;
      default:
        continue;
    }
    out.total += 1;
  }
  return out;
}

function atRiskOf(stats: PersonStats[]): AtRiskSummary | null {
  const regulars = stats.filter((s) => s.stage === 'at_risk' && s.typicalGap !== null);
  if (regulars.length === 0) return null;
  return {
    count: regulars.length,
    typicalGapDays: Math.round(median(regulars.map((s) => s.typicalGap as number))),
    minDaysAway: Math.min(...regulars.map((s) => s.daysSinceLast)),
  };
}

function cohortsOf(stats: PersonStats[], to: string): CohortRow[] {
  const last = monthOf(to);
  const byMonth = new Map<string, PersonStats[]>();
  for (const s of stats) {
    const m = monthOf(s.person.firstVisitDate);
    byMonth.set(m, [...(byMonth.get(m) ?? []), s]);
  }
  const rows: CohortRow[] = [];
  for (let i = COHORT_MONTHS - 1; i >= 0; i--) {
    const month = addMonths(last, -i);
    const members = byMonth.get(month) ?? [];
    const retention: (number | null)[] = [];
    for (let k = 1; k <= COHORT_FOLLOW_MONTHS; k++) {
      const later = addMonths(month, k);
      // A month counts only once it is over: part of a month would read as lost customers.
      if (members.length === 0 || monthEnd(later) > to) {
        retention.push(null);
        continue;
      }
      const came = members.filter((s) => s.visitDates.some((d) => monthOf(d) === later)).length;
      retention.push(pct1(came, members.length));
    }
    rows.push({ month, label: monthLabel(month), customers: members.length, retention });
  }
  return rows;
}

// ── Sheet plumbing ───────────────────────────────────────────────────────────

const orBlank = (v: number | null): CsvValue => (v === null ? '' : v);

const STAGE_LABEL: Record<LifecycleStage, string> = {
  new: 'New',
  active: 'Active',
  at_risk: 'At risk',
  lapsed_1: 'Lapsed',
  lapsed_2: 'Lapsed',
  lapsed_3: 'Lapsed',
  lost: 'Lost',
  no_orders: '',
};

const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

// ── Customer retention summary ───────────────────────────────────────────────

/** Metric, Value, Note. A rate with nothing to divide by is left blank rather than 0. */
export function retentionSummary(a: RetentionAnalysis): CsvTable {
  const k = a.kpis;
  const l = a.lifecycle;
  const w = a.input.winback.winback_1;
  const share = (n: number): string => (k.bills > 0 ? `${pct1(n, k.bills)}% of the period's bills. ` : '');
  const r = k.newCustomerReturn;

  const rows: CsvValue[][] = [
    ['Customers who visited', k.customers, 'Customers the café can follow (an account, or a phone number) with at least one bill in the period. Petpooja bills count when the period covers them.'],
    ['New customers', k.newCustomers, 'First visit ever was in the period. Petpooja history counts as a visit, so an old regular who is new to the app is not new.'],
    ['Returning customers', k.returningCustomers, 'Had visited before the period began.'],
    ['Revenue from new customers (INR)', k.newRevenueInr, 'Bill totals of their bills in the period.'],
    ['Revenue from returning customers (INR)', k.returningRevenueInr, 'Bill totals of their bills in the period.'],
    ['Repeat rate (%)', orBlank(k.repeatRatePct), 'Customers who came on 2 or more different days in the period, out of everyone who visited.'],
    ['Average visits per customer', orBlank(k.avgVisitsPerCustomer), 'A visit is a day with at least one bill; two bills in one sitting are one visit.'],
    ['Average days between visits', orBlank(k.avgGapDays), "Average of each customer's typical gap: the median days between their visit days over the last 12 months. Needs 3 or more bills."],
    ['Average bill, new customers (INR)', orBlank(k.avgBillNewInr), 'Their revenue divided by their bills.'],
    ['Average bill, returning customers (INR)', orBlank(k.avgBillReturningInr), 'Their revenue divided by their bills.'],
    ['Bills in the period', k.bills, 'Valid app bills (cancelled and rejected left out). Petpooja bills are not in the order counts below.'],
    ['Bills from walk-ins', k.walkInBills, `${share(k.walkInBills)}Counter bills with no name, phone or account.`],
    ['Bills from counter customers', k.counterBills, `${share(k.counterBills)}Counter bills with a name, a phone number or an account.`],
    ['Bills from online and table QR orders', k.onlineBills, `${share(k.onlineBills)}Orders customers placed themselves.`],
    ['Bills linked to a customer', k.trackedBills, `${share(k.trackedBills)}Bills with an account or a usable Indian mobile number: the ones this report can follow.`],
    [
      'At period end: new customers (one bill so far)',
      l.new,
      `Counted at the end of the period over everyone seen in the last 12 months. A customer lapses after about ${w.gap_multiplier} times their usual gap between visits (between ${w.min_days} and ${w.max_days} days; ${w.default_days} days when there is no pattern yet).`,
    ],
    ['At period end: active customers', l.active, 'Still inside their usual rhythm.'],
    ['At period end: customers at risk', l.atRisk, 'In the last fifth of the time before they count as lapsed.'],
    ['At period end: lapsed customers', l.lapsed, 'Past their personal lapse point but not yet lost.'],
    ['At period end: lost customers', l.lost, 'Away for so long the marketing agent no longer messages them.'],
    [
      'Petpooja regulars who have lapsed',
      k.petpoojaLapsedRegulars === null ? '' : k.petpoojaLapsedRegulars,
      k.petpoojaLapsedRegulars === null
        ? 'Petpooja history could not be read.'
        : '5 or more Petpooja bills, the last one 60 or more days before the end of the period, and no app order in those 60 days.',
    ],
    [
      `30-day return rate of ${r.label}'s new customers (%)`,
      orBlank(pct1(r.returned, r.eligible)),
      r.customers === 0
        ? `No first-time customers in ${r.label}.`
        : `${r.returned} of ${r.eligible} first-time customers came back within 30 days of their first visit.${
            r.pending > 0 ? ` ${r.pending} more are still inside their first 30 days and are not counted.` : ''
          }`,
    ],
  ];
  return { columns: ['Metric', 'Value', 'Note'], rows };
}

// ── Customer visit frequency ─────────────────────────────────────────────────

/** One row per customer who visited in the period, most visits first, with a TOTAL row. */
export function customerVisits(a: RetentionAnalysis): CsvTable {
  const rows: CsvValue[][] = a.seen.map((s) => [
    s.person.name,
    maskPhone(s.person.phone),
    s.person.firstVisitDate,
    s.isNew ? 'Yes' : 'No',
    s.visitsInPeriod,
    s.spendInPeriodInr,
    round2(s.spendInPeriodInr / s.billsInPeriod),
    s.lastVisitDate,
    s.daysSinceLast,
    s.typicalGap === null ? '' : s.typicalGap,
    STAGE_LABEL[s.stage],
    s.allTimeVisits,
  ]);
  const visits = a.seen.reduce((t, s) => t + s.visitsInPeriod, 0);
  const bills = a.seen.reduce((t, s) => t + s.billsInPeriod, 0);
  const spend = round2(a.seen.reduce((t, s) => t + s.spendInPeriodInr, 0));
  rows.push(['TOTAL', '', '', '', visits, spend, bills > 0 ? round2(spend / bills) : 0, '', '', '', '', '']);
  return {
    columns: [
      'Customer',
      'Phone',
      'First visit ever',
      'New this period',
      'Visits in period',
      'Spend in period (INR)',
      'Avg bill (INR)',
      'Last visit',
      'Days since last visit (at period end)',
      'Typical gap (days)',
      'Lifecycle stage',
      'Visits all time (app + Petpooja)',
    ],
    rows,
  };
}

// ── Monthly cohort retention ─────────────────────────────────────────────────

/** First-visit month by row; Month 1 … 6 = % of the cohort seen in that later month, blank until the month is over. */
export function cohortRetention(a: RetentionAnalysis): CsvTable {
  return {
    columns: [
      'Cohort month',
      'New customers',
      ...Array.from({ length: COHORT_FOLLOW_MONTHS }, (_, i) => `Month ${i + 1} (%)`),
    ],
    rows: a.cohorts.map((c) => [c.label, c.customers, ...c.retention.map(orBlank)]),
  };
}

// ── Coupons ──────────────────────────────────────────────────────────────────

/** One redemption, joined to its order and customer. */
export interface RedemptionDetail {
  date: string;
  createdAt: string;
  invoiceNo: string;
  code: string;
  /** The campaign name for a machine-made code; '' for a coupon the owner made. */
  campaign: string;
  customer: string;
  phone: string;
  /** 'New' when the order was the customer's first visit ever, 'Returning' otherwise, '' when nobody is attached. */
  newOrReturning: 'New' | 'Returning' | '';
  discountInr: number;
  billTotalInr: number;
  status: string;
  valid: boolean;
}

/** One coupon, or one campaign's codes together. */
export interface CouponGroup {
  /** The code, or "Campaign: <name>". */
  label: string;
  kind: 'coupon' | 'campaign';
  /** The code, or the bare campaign name. */
  name: string;
  typeLabel: string;
  valueLabel: string;
  redemptions: number;
  uniqueCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  discountInr: number;
  billTotalInr: number;
  avgBillInr: number;
  discountPct: number | null;
  cancelledRedemptions: number;
  refundedBills: number;
}

export interface CouponAnalysis {
  groups: CouponGroup[];
  total: CouponGroup;
  details: RedemptionDetail[];
}

function typeLabelOf(types: Set<string>): string {
  if (types.size > 1) return 'Mixed';
  const [t] = [...types];
  return t === 'percent' ? 'Percent off' : t === 'flat' ? 'Flat off' : (t ?? '');
}

function valueLabelOf(types: Set<string>, values: Set<number>): string {
  if (types.size !== 1 || values.size !== 1) return values.size > 1 ? 'Various' : '';
  const [t] = [...types];
  const [v] = [...values];
  return t === 'percent' ? `${v}%` : t === 'flat' ? `₹${v}` : String(v);
}

interface GroupAcc {
  label: string;
  kind: 'coupon' | 'campaign';
  name: string;
  types: Set<string>;
  values: Set<number>;
  orders: Set<string>;
  people: Set<string>;
  newPeople: Set<string>;
  redemptions: number;
  discountInr: number;
  billTotalInr: number;
  cancelledRedemptions: number;
  refundedOrders: Set<string>;
}

const emptyAcc = (label: string, kind: 'coupon' | 'campaign', name: string): GroupAcc => ({
  label,
  kind,
  name,
  types: new Set(),
  values: new Set(),
  orders: new Set(),
  people: new Set(),
  newPeople: new Set(),
  redemptions: 0,
  discountInr: 0,
  billTotalInr: 0,
  cancelledRedemptions: 0,
  refundedOrders: new Set(),
});

function finish(g: GroupAcc): CouponGroup {
  const discountInr = round2(g.discountInr);
  const billTotalInr = round2(g.billTotalInr);
  return {
    label: g.label,
    kind: g.kind,
    name: g.name,
    typeLabel: typeLabelOf(g.types),
    valueLabel: valueLabelOf(g.types, g.values),
    redemptions: g.redemptions,
    uniqueCustomers: g.people.size,
    newCustomers: g.newPeople.size,
    returningCustomers: g.people.size - g.newPeople.size,
    discountInr,
    billTotalInr,
    avgBillInr: g.orders.size > 0 ? round2(billTotalInr / g.orders.size) : 0,
    discountPct: pct1(discountInr, billTotalInr),
    cancelledRedemptions: g.cancelledRedemptions,
    refundedBills: g.refundedOrders.size,
  };
}

/**
 * Every redemption on an order placed in the period, rolled up per coupon (codes of
 * one marketing campaign together). Redemptions on cancelled and rejected bills are
 * counted apart and add to no money column. A redemption is a NEW customer's when the
 * bill was that customer's first visit ever, so "brought new customers" means it.
 */
export function analyseCoupons(a: RetentionAnalysis, c: CouponInput): CouponAnalysis {
  const orders = new Map(a.periodOrders.map((o) => [o.id, o]));
  const coupons = new Map(c.coupons.map((x) => [x.id, x]));
  const campaigns = new Map(c.campaigns.map((x) => [x.id, x.name]));
  const refunded = new Set(c.refundedOrderIds);

  const groups = new Map<string, GroupAcc>();
  const overall = emptyAcc('TOTAL', 'coupon', 'TOTAL');
  const details: RedemptionDetail[] = [];

  for (const r of c.redemptions) {
    const o = orders.get(r.order_id);
    if (!o) continue;
    const coupon = coupons.get(r.coupon_id);
    const campaignId = coupon?.campaign_id ?? null;
    const campaignName = campaignId ? (campaigns.get(campaignId)?.trim() || 'Unnamed campaign') : '';
    const valid = isValidOrderStatus(o.status);
    const key = a.book.keyByOrderId.get(o.id) ?? null;
    const person = key ? a.book.people.get(key) : undefined;
    const date = istDateOf(o.created_at);
    const discount = Number(r.discount_inr) || 0;
    const total = Number(o.total_inr) || 0;
    const newOrReturning: RedemptionDetail['newOrReturning'] = valid && person ? (person.firstVisitDate === date ? 'New' : 'Returning') : '';

    details.push({
      date,
      createdAt: o.created_at,
      invoiceNo: formatOrderNumber(o.order_number),
      code: coupon?.code ?? 'Unknown coupon',
      campaign: campaignName,
      customer: person?.name ?? '',
      phone: person ? maskPhone(person.phone) : '',
      newOrReturning,
      discountInr: discount,
      billTotalInr: total,
      status: o.status,
      valid,
    });

    const groupKey = campaignId ? `campaign:${campaignId}` : `coupon:${r.coupon_id}`;
    let g = groups.get(groupKey);
    if (!g) {
      g = campaignId
        ? emptyAcc(`Campaign: ${campaignName}`, 'campaign', campaignName)
        : emptyAcc(coupon?.code ?? 'Unknown coupon', 'coupon', coupon?.code ?? 'Unknown coupon');
      groups.set(groupKey, g);
    }
    for (const acc of [g, overall]) {
      if (!valid) {
        acc.cancelledRedemptions += 1;
        continue;
      }
      acc.redemptions += 1;
      acc.discountInr += discount;
      if (!acc.orders.has(o.id)) acc.billTotalInr += total;
      acc.orders.add(o.id);
      if (coupon) {
        acc.types.add(coupon.discount_type);
        acc.values.add(Number(coupon.discount_value) || 0);
      }
      if (key) {
        acc.people.add(key);
        if (newOrReturning === 'New') acc.newPeople.add(key);
      }
      if (refunded.has(o.id)) acc.refundedOrders.add(o.id);
    }
  }

  const finished = [...groups.values()]
    .filter((g) => g.redemptions > 0)
    .map(finish)
    .sort((x, y) => y.redemptions - x.redemptions || y.discountInr - x.discountInr || x.label.localeCompare(y.label));
  details.sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.code.localeCompare(y.code));
  return { groups: finished, total: finish(overall), details };
}

/** Per coupon (a campaign's codes together) with redemptions on valid orders in the period, and a TOTAL row. */
export function couponPerformance(a: RetentionAnalysis, c: CouponInput): CsvTable {
  const { groups, total } = analyseCoupons(a, c);
  const row = (g: CouponGroup, first: string): CsvValue[] => [
    first,
    g.typeLabel,
    g.valueLabel,
    g.redemptions,
    g.uniqueCustomers,
    g.newCustomers,
    g.returningCustomers,
    g.discountInr,
    g.billTotalInr,
    g.avgBillInr,
    orBlank(g.discountPct),
    g.cancelledRedemptions,
    g.refundedBills,
  ];
  // The TOTAL row counts a customer once however many coupons they used, so its customer columns are not the sum of the rows above.
  const totalRow = row(total, 'TOTAL');
  totalRow[1] = '';
  totalRow[2] = '';
  return {
    columns: [
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
    ],
    rows: [...groups.map((g) => row(g, g.label)), totalRow],
  };
}

/** Every redemption on an order placed in the period, cancelled bills included and flagged; the TOTAL row adds up the valid ones. */
export function couponRedemptions(a: RetentionAnalysis, c: CouponInput): CsvTable {
  const { details } = analyseCoupons(a, c);
  const valid = details.filter((d) => d.valid);
  return {
    columns: [
      'Date',
      'Invoice no',
      'Code',
      'Campaign',
      'Customer',
      'Phone',
      'New/Returning',
      'Discount (INR)',
      'Bill total (INR)',
      'Order status',
    ],
    rows: [
      ...details.map((d) => [
        d.date,
        d.invoiceNo,
        d.code,
        d.campaign,
        d.customer,
        d.phone,
        d.newOrReturning,
        d.discountInr,
        d.billTotalInr,
        d.status,
      ]),
      [
        'TOTAL',
        '',
        '',
        '',
        '',
        '',
        '',
        round2(valid.reduce((s, d) => s + d.discountInr, 0)),
        round2(valid.reduce((s, d) => s + d.billTotalInr, 0)),
        'valid orders only',
      ],
    ],
  };
}

// ── Insights ─────────────────────────────────────────────────────────────────

/** A coupon (or campaign) for the Insights page. */
export interface CouponInsight {
  label: string;
  kind: 'coupon' | 'campaign';
  name: string;
  redemptions: number;
  uniqueCustomers: number;
  newCustomers: number;
  discountInr: number;
  billTotalInr: number;
  discountPct: number | null;
  /** Discount given ÷ new customers; null when it brought none. */
  costPerNewCustomerInr: number | null;
}

export function couponInsights(analysis: CouponAnalysis): CouponInsight[] {
  return analysis.groups.map((g) => ({
    label: g.label,
    kind: g.kind,
    name: g.name,
    redemptions: g.redemptions,
    uniqueCustomers: g.uniqueCustomers,
    newCustomers: g.newCustomers,
    discountInr: g.discountInr,
    billTotalInr: g.billTotalInr,
    discountPct: g.discountPct,
    costPerNewCustomerInr: g.newCustomers > 0 ? round2(g.discountInr / g.newCustomers) : null,
  }));
}

export interface RetentionInsights {
  range: { from: string; to: string };
  kpis: RetentionKpis;
  cohorts: CohortRow[];
  lifecycle: LifecycleCounts;
  atRisk: AtRiskSummary | null;
  /** Top coupons and campaigns by redemptions. */
  coupons: CouponInsight[];
  highlights: string[];
}

export interface RetentionHighlightInput {
  kpis: RetentionKpis;
  lifecycle: LifecycleCounts;
  atRisk: AtRiskSummary | null;
  /** Every coupon and campaign (not just the top few), so the best one for new customers is found. */
  coupons: CouponInsight[];
}

/** How many sentences the Insights page shows at most. */
export const MAX_HIGHLIGHTS = 6;

/**
 * Plain-English sentences from the numbers, up to six, each only when its own
 * denominator is above zero. Most useful first.
 */
export function retentionHighlights(h: RetentionHighlightInput): string[] {
  const { kpis: k, atRisk } = h;
  const out: string[] = [];

  if (k.customers > 0 && k.repeatRatePct !== null) {
    out.push(
      `${k.repeatCustomers} of the ${k.customers} ${plural(k.customers, 'customer')} who visited (${k.repeatRatePct}%) came back on more than one day.`,
    );
  }

  const r = k.newCustomerReturn;
  if (r.eligible > 0) {
    out.push(
      `${r.returned} of ${r.label}'s ${r.eligible} new ${plural(r.eligible, 'customer')} returned within 30 days${
        r.pending > 0 ? ` (${r.pending} more are still inside their first 30 days)` : ''
      }.`,
    );
  }

  if (atRisk && atRisk.count > 0) {
    out.push(
      `${atRisk.count} ${plural(atRisk.count, 'regular is', 'regulars are')} at risk: they usually visit every ${atRisk.typicalGapDays} days but haven't been in for ${atRisk.minDaysAway}+ days.`,
    );
  }

  const best = h.coupons
    .filter((c) => c.newCustomers > 0 && c.costPerNewCustomerInr !== null)
    .sort((x, y) => y.newCustomers - x.newCustomers || (x.costPerNewCustomerInr ?? 0) - (y.costPerNewCustomerInr ?? 0))[0];
  if (best) {
    out.push(
      `${best.kind === 'campaign' ? 'Campaign' : 'Coupon'} ${best.name} brought ${best.newCustomers} new ${plural(best.newCustomers, 'customer')} at ${inr(best.costPerNewCustomerInr ?? 0)} of discount each.`,
    );
  }

  if (k.petpoojaLapsedRegulars !== null && k.petpoojaLapsedRegulars > 0) {
    out.push(
      `${k.petpoojaLapsedRegulars} Petpooja ${plural(k.petpoojaLapsedRegulars, 'regular')} (5+ bills) haven't visited for 60+ days and haven't ordered in the app: a win-back message could bring them back.`,
    );
  }

  const followed = k.newRevenueInr + k.returningRevenueInr;
  if (followed > 0 && k.returningCustomers > 0) {
    out.push(
      `Returning customers brought ${Math.round((k.returningRevenueInr / followed) * 100)}% of the revenue from customers the café can follow (${inr(k.returningRevenueInr)} against ${inr(k.newRevenueInr)} from new ones).`,
    );
  }

  if (k.bills > 0 && k.walkInBills / k.bills >= WALK_IN_HIGHLIGHT_SHARE) {
    out.push(
      `${Math.round((k.walkInBills / k.bills) * 100)}% of bills (${k.walkInBills}) had no name, phone or account: asking for a phone number at the counter lets this report follow those customers.`,
    );
  }

  const given = h.coupons.reduce((s, c) => s + c.discountInr, 0);
  const used = h.coupons.reduce((s, c) => s + c.redemptions, 0);
  if (used > 0 && given > 0) {
    out.push(`Coupons and campaigns took ${inr(given)} off ${used} ${plural(used, 'bill')} in the period.`);
  }

  return out.slice(0, MAX_HIGHLIGHTS);
}
