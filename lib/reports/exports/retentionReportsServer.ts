import 'server-only';

// Reads the rows behind the retention and coupon downloads (Owner → Reports →
// Downloads → Loyalty, promotions & retention) and the Insights page's customer
// numbers. The sheets and the identity rules are pure
// (retentionReports.ts, customerIdentity.ts).
//
// The load is kept lean, because it looks a year back (to tell a new customer
// from a returning one) and a year of bills is the biggest read in the reports:
//   • orders: identity columns, created_at and the bill total only, paged;
//   • Petpooja: the completed bills that carry a phone (phone, time, total) for the
//     same window, plus legacy_customers for the people seen — so cohorts and
//     "new vs returning" hold across the 25 Sep 2026 switch from Petpooja;
//   • profiles: only the accounts those orders belong to, the owners of the phones
//     typed on phone-only orders, and the staff roster (who are not customers);
//   • `.in()` lists are chunked.
// Tables and columns from later migrations are optional: a database without
// legacy_*, the marketing tables or customer_user_id reads what it has.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError, type PostgrestLikeError } from '@/lib/api/postgrest';
import { isLapsedRegular, LAPSED_AFTER_DAYS } from '@/lib/legacy/ownerStats';
import { loyaltyUserIdFor } from '@/lib/loyalty/beneficiary';
import { winbackBundle } from '@/lib/marketing/server/audience';
import { loadPlaybooks } from '@/lib/marketing/server/repo';
import type { WinbackParamsBundle } from '@/lib/marketing/types';
import { istDateOf, rangeBounds } from '@/lib/reports/reconcile';
import { fetchAll, IN_CHUNK, withColumnTiers, type PageResult } from '@/lib/reports/reconcileServer';
import {
  appPhonesSince,
  createIdentityResolver,
  lookbackFrom,
  PHONE_KEY_PREFIX,
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
  type CampaignRow,
  type CouponInput,
  type CouponRow,
  type RedemptionRow,
  type RetentionInput,
  type RetentionInsights,
} from '@/lib/reports/exports/retentionReports';
import type { ReportDef } from '@/lib/reports/exports/types';

export type { RetentionInsights } from '@/lib/reports/exports/retentionReports';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Coupons and campaigns shown on the Insights page. */
const TOP_COUPONS = 8;

// The identity columns an order is read with; customer_user_id arrived with
// 2026-08-counter-loyalty.sql.
const ORDER_BASE =
  'id, order_number, created_at, status, channel, user_id, customer_phone, customer_name, total_inr, discount_inr';
const ORDER_TIERS = [`${ORDER_BASE}, customer_user_id`, ORDER_BASE];

const PROFILE_COLUMNS = 'id, name, phone, phone_verified, role';
const LEGACY_CUSTOMER_COLUMNS = 'phone, name, first_order_at, last_order_at, order_count, total_spend_inr';

function isMissingRelation(err: unknown): boolean {
  const e = err as PostgrestLikeError | undefined;
  return e?.code === '42P01' || e?.code === 'PGRST205' || /does not exist|could not find the table/i.test(e?.message ?? '');
}

/** An optional table that is not there reads as empty; any other error is real. */
async function orEmptyIfMissing<T>(run: Promise<T[]>): Promise<T[]> {
  try {
    return await run;
  } catch (err) {
    if (isMissingRelation(err)) return [];
    throw err;
  }
}

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) out.push(list.slice(i, i + IN_CHUNK));
  return out;
}

/** Runs `load` over each IN_CHUNK slice of `values` and joins the results. */
async function inChunks<T>(values: readonly string[], load: (slice: string[]) => Promise<T[]>): Promise<T[]> {
  return (await Promise.all(chunks(values).map(load))).flat();
}

// ── Customers ────────────────────────────────────────────────────────────────

/**
 * The win-back settings lifecycle staging runs on (the marketing agent's own
 * playbooks, so "at risk" means the same on both screens). An untouched or
 * absent marketing agent has the defaults, which is also what an unreadable one gets.
 */
async function loadWinbackParams(admin: SupabaseClient): Promise<WinbackParamsBundle> {
  try {
    return winbackBundle(await loadPlaybooks(admin as Parameters<typeof loadPlaybooks>[0]));
  } catch {
    return winbackBundle([]);
  }
}

async function loadProfiles(admin: SupabaseClient, orders: AppOrderRow[]): Promise<ProfileRow[]> {
  const byId = new Map<string, ProfileRow>();
  const add = (rows: ProfileRow[]) => rows.forEach((r) => byId.set(r.id, r));

  // Staff are the roster to leave out, so all of them; a role that is null is a customer.
  const staff = await fetchAll<ProfileRow>((a, b) =>
    admin
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .neq('role', 'customer')
      .order('id')
      .range(a, b) as unknown as PromiseLike<PageResult<ProfileRow>>,
  );
  add(staff);

  const accountIds = [...new Set(orders.map((o) => loyaltyUserIdFor(o)).filter((id): id is string => !!id))].filter(
    (id) => !byId.has(id),
  );
  add(
    await inChunks(accountIds, (slice) =>
      fetchAll<ProfileRow>((a, b) =>
        admin.from('profiles').select(PROFILE_COLUMNS).in('id', slice).order('id').range(a, b) as unknown as PromiseLike<PageResult<ProfileRow>>,
      ),
    ),
  );

  // A phone-only order joins the account that verified its number, if there is one.
  const resolver = createIdentityResolver([...byId.values()]);
  const phones = new Set<string>();
  for (const o of orders) {
    const key = resolver.keyForOrder(o);
    if (key?.startsWith(PHONE_KEY_PREFIX)) phones.add(key.slice(PHONE_KEY_PREFIX.length));
  }
  add(
    await inChunks([...phones], (slice) =>
      fetchAll<ProfileRow>((a, b) =>
        admin
          .from('profiles')
          .select(PROFILE_COLUMNS)
          .in('phone', slice)
          .eq('phone_verified', true)
          .order('id')
          .range(a, b) as unknown as PromiseLike<PageResult<ProfileRow>>,
      ),
    ),
  );
  return [...byId.values()];
}

/** Legacy customers with a bill in the window, then any other number a person goes by, looked up. */
async function loadLegacyCustomers(
  admin: SupabaseClient,
  windowStartIso: string,
  phones: readonly string[],
): Promise<LegacyCustomerRow[]> {
  const recent = await orEmptyIfMissing(
    fetchAll<LegacyCustomerRow>((a, b) =>
      admin
        .from('legacy_customers')
        .select(LEGACY_CUSTOMER_COLUMNS)
        .gte('last_order_at', windowStartIso)
        .order('phone')
        .range(a, b) as unknown as PromiseLike<PageResult<LegacyCustomerRow>>,
    ),
  );
  const loaded = new Set(recent.map((r) => toCustomerPhone(r.phone) ?? r.phone));
  const rest = await orEmptyIfMissing(
    inChunks(
      phones.filter((p) => !loaded.has(p)),
      (slice) =>
        fetchAll<LegacyCustomerRow>((a, b) =>
          admin
            .from('legacy_customers')
            .select(LEGACY_CUSTOMER_COLUMNS)
            .in('phone', slice)
            .order('phone')
            .range(a, b) as unknown as PromiseLike<PageResult<LegacyCustomerRow>>,
        ),
    ),
  );
  return [...recent, ...rest];
}

/** Petpooja regulars gone quiet (the owner's Customers page rule, lib/legacy/ownerStats.ts), as of the end of the period. */
async function countLapsedRegulars(admin: SupabaseClient, endIso: string, appPhones: Set<string>): Promise<number | null> {
  const end = new Date(endIso);
  const cutoffIso = new Date(end.getTime() - LAPSED_AFTER_DAYS * DAY_MS).toISOString();
  try {
    const rows = await fetchAll<{ phone: string; order_count: number | null; last_order_at: string | null }>(
      (a, b) =>
        admin
          .from('legacy_customers')
          .select('phone, order_count, last_order_at')
          .gte('order_count', 5)
          .lte('last_order_at', cutoffIso)
          .order('phone')
          .range(a, b) as unknown as PromiseLike<
          PageResult<{ phone: string; order_count: number | null; last_order_at: string | null }>
        >,
    );
    return rows.filter((r) =>
      isLapsedRegular(r.order_count ?? 0, r.last_order_at, toCustomerPhone(r.phone) ?? r.phone, appPhones, end),
    ).length;
  } catch (err) {
    if (isMissingRelation(err)) return null;
    throw err;
  }
}

/** Everything the retention sheets read, for IST dates from..to and the year before. */
export async function loadRetentionInput(
  admin: SupabaseClient,
  from: string,
  to: string,
  opts: { withLapsedRegulars?: boolean } = {},
): Promise<RetentionInput> {
  const { startIso, endIso } = rangeBounds(lookbackFrom(from), to);

  const [orders, legacyBills, winback] = await Promise.all([
    withColumnTiers<AppOrderRow>(ORDER_TIERS, (cols) =>
      fetchAll<AppOrderRow>((a, b) =>
        admin
          .from('orders')
          .select(cols)
          .gte('created_at', startIso)
          .lt('created_at', endIso)
          .order('created_at')
          .order('id')
          .range(a, b) as unknown as PromiseLike<PageResult<AppOrderRow>>,
      ),
    ),
    orEmptyIfMissing(
      fetchAll<LegacyBillRow>((a, b) =>
        admin
          .from('legacy_orders')
          .select('customer_phone, ordered_at, total_inr')
          .eq('status', 'completed')
          .not('customer_phone', 'is', null)
          .gte('ordered_at', startIso)
          .lt('ordered_at', endIso)
          .order('ordered_at')
          .order('id')
          .range(a, b) as unknown as PromiseLike<PageResult<LegacyBillRow>>,
      ),
    ),
    loadWinbackParams(admin),
  ]);

  const profiles = await loadProfiles(admin, orders);

  // Petpooja history for every number a person goes by: the phone-only people and the
  // accounts' verified phones, besides everyone who had a Petpooja bill in the window.
  const resolver = createIdentityResolver(profiles);
  const personPhones = new Set<string>();
  for (const o of orders) {
    const key = resolver.keyForOrder(o);
    if (!key) continue;
    const phone = key.startsWith(PHONE_KEY_PREFIX) ? key.slice(PHONE_KEY_PREFIX.length) : resolver.verifiedPhone(key);
    if (phone) personPhones.add(phone);
  }
  const legacyCustomers = await loadLegacyCustomers(admin, startIso, [...personPhones]);

  const petpoojaLapsedRegulars = opts.withLapsedRegulars
    ? await countLapsedRegulars(
        admin,
        endIso,
        appPhonesSince(orders, resolver, new Date(Date.parse(endIso) - LAPSED_AFTER_DAYS * DAY_MS).toISOString()),
      )
    : null;

  return { from, to, profiles, orders, legacyBills, legacyCustomers, winback, petpoojaLapsedRegulars };
}

// ── Coupons ──────────────────────────────────────────────────────────────────

/** Redemptions on the period's orders, with their coupons, campaign names and refunded orders. */
export async function loadCouponInput(
  admin: SupabaseClient,
  from: string,
  to: string,
  orders: readonly AppOrderRow[],
): Promise<CouponInput> {
  const { startIso, endIso } = rangeBounds(from, to);
  const inPeriod = new Set(
    orders
      .filter((o) => {
        const d = istDateOf(o.created_at);
        return d >= from && d <= to;
      })
      .map((o) => o.id),
  );

  // The redemption is written a moment after its order, so a day either side of the
  // period finds them all; the join to the period's orders trims the edges.
  const padStart = new Date(Date.parse(startIso) - DAY_MS).toISOString();
  const padEnd = new Date(Date.parse(endIso) + DAY_MS).toISOString();
  const found = await orEmptyIfMissing(
    fetchAll<RedemptionRow>((a, b) =>
      admin
        .from('coupon_redemptions')
        .select('coupon_id, order_id, discount_inr')
        .gte('created_at', padStart)
        .lt('created_at', padEnd)
        .order('created_at')
        .order('id')
        .range(a, b) as unknown as PromiseLike<PageResult<RedemptionRow>>,
    ),
  );
  const redemptions = found.filter((r) => inPeriod.has(r.order_id));

  const couponIds = [...new Set(redemptions.map((r) => r.coupon_id))];
  // campaign_id arrived with 2026-10-marketing-agent.sql.
  const coupons = await orEmptyIfMissing(
    inChunks(couponIds, (slice) =>
      withColumnTiers<CouponRow>(
        ['id, code, discount_type, discount_value, campaign_id', 'id, code, discount_type, discount_value'],
        (cols) =>
          fetchAll<CouponRow>((a, b) =>
            admin.from('coupons').select(cols).in('id', slice).order('id').range(a, b) as unknown as PromiseLike<PageResult<CouponRow>>,
          ),
      ),
    ),
  );

  const campaignIds = [...new Set(coupons.map((c) => c.campaign_id).filter((id): id is string => !!id))];
  const campaigns = await orEmptyIfMissing(
    inChunks(campaignIds, (slice) =>
      fetchAll<CampaignRow>((a, b) =>
        admin
          .from('marketing_campaigns')
          .select('id, name')
          .in('id', slice)
          .order('id')
          .range(a, b) as unknown as PromiseLike<PageResult<CampaignRow>>,
      ),
    ),
  );

  const orderIds = [...new Set(redemptions.map((r) => r.order_id))];
  const refunds = await orEmptyIfMissing(
    inChunks(orderIds, (slice) =>
      fetchAll<{ order_id: string }>((a, b) =>
        admin
          .from('refunds')
          .select('order_id')
          .in('order_id', slice)
          .eq('status', 'processed')
          .order('id')
          .range(a, b) as unknown as PromiseLike<PageResult<{ order_id: string }>>,
      ),
    ),
  );

  return { coupons, campaigns, redemptions, refundedOrderIds: [...new Set(refunds.map((r) => r.order_id))] };
}

// ── Insights ─────────────────────────────────────────────────────────────────

/** The customer numbers the Insights page shows for IST dates from..to. */
export async function loadRetentionInsights(admin: SupabaseClient, from: string, to: string): Promise<RetentionInsights> {
  const input = await loadRetentionInput(admin, from, to, { withLapsedRegulars: true });
  const analysis = analyseRetention(input);
  const coupons = couponInsights(analyseCoupons(analysis, await loadCouponInput(admin, from, to, input.orders)));
  return {
    range: { from, to },
    kpis: analysis.kpis,
    cohorts: analysis.cohorts,
    lifecycle: analysis.lifecycle,
    atRisk: analysis.atRisk,
    coupons: coupons.slice(0, TOP_COUPONS),
    highlights: retentionHighlights({
      kpis: analysis.kpis,
      lifecycle: analysis.lifecycle,
      atRisk: analysis.atRisk,
      coupons,
    }),
  };
}

// ── The downloads ────────────────────────────────────────────────────────────

export const RETENTION_REPORTS: ReportDef[] = [
  {
    key: 'retention-summary',
    group: 'loyalty',
    title: 'Customer retention summary',
    description:
      'How many customers came, how many were new and how many came back, repeat rate, average bill of new and returning customers, who is at risk or lapsed, and how many of last month’s new customers returned within 30 days. Petpooja history counts, so an old regular is not “new”.',
    load: async (admin, from, to) =>
      retentionSummary(analyseRetention(await loadRetentionInput(admin, from, to, { withLapsedRegulars: true }))),
  },
  {
    key: 'customer-visits',
    group: 'loyalty',
    title: 'Customer visit frequency',
    description:
      'One row per customer who visited in the period: first visit ever, visits and spend, last visit, usual gap between visits and lifecycle stage. Phone numbers are masked to the last four digits.',
    load: async (admin, from, to) => customerVisits(analyseRetention(await loadRetentionInput(admin, from, to))),
  },
  {
    key: 'cohort-retention',
    group: 'loyalty',
    title: 'Monthly cohort retention',
    description:
      'For each month’s first-time customers over the last 12 months, the share who came back in each of the next 6 months. A month still in progress is left blank.',
    load: async (admin, from, to) => cohortRetention(analyseRetention(await loadRetentionInput(admin, from, to))),
  },
  {
    key: 'coupon-performance',
    group: 'loyalty',
    title: 'Coupon & promotion performance',
    description:
      'Per coupon, with a marketing campaign’s codes together: redemptions, customers (new means the coupon was used on their very first visit), discount given, bill totals and refunded bills. Cancelled bills are counted apart and left out of the money.',
    load: async (admin, from, to) => {
      const input = await loadRetentionInput(admin, from, to);
      return couponPerformance(analyseRetention(input), await loadCouponInput(admin, from, to, input.orders));
    },
  },
  {
    key: 'coupon-redemptions',
    group: 'loyalty',
    title: 'Coupon redemptions',
    description:
      'Every coupon use in the period, one row each: invoice, code, campaign, customer (phone masked), new or returning, discount and the order’s status.',
    load: async (admin, from, to) => {
      const input = await loadRetentionInput(admin, from, to);
      return couponRedemptions(analyseRetention(input), await loadCouponInput(admin, from, to, input.orders));
    },
  },
];
