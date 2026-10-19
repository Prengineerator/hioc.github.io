import 'server-only';

// Reads the rows behind the Beanies, HIOC Ritual and marketing-campaign
// downloads (Owner → Reports → Downloads → Loyalty) and the Insights page's
// programme section. The sheets and every rule are the pure builders in
// loyaltyReports.ts. The order side of Beanies (what redemptions cost, average
// bills) comes from loadOrderDataset, so it agrees with the sales sheets; the
// pass and campaign figures reuse the owner screens' own folding
// (lib/passes/summary.ts, lib/marketing/server/campaigns.ts).
//
// The Ritual and marketing sheets exist only while their feature flags are on
// (the registry is built when this module loads). A flag that is on while its
// migration is not applied reads as "nothing yet": empty sheets, a null section.
// Any other read error is real and throws.

import type { SupabaseClient } from '@supabase/supabase-js';
import { flags } from '@/lib/flags';
import { isMissingColumnError, type PostgrestLikeError } from '@/lib/api/postgrest';
import { isMissingPassSchema } from '@/lib/passes/api';
import { SUMMARY_PASS_COLUMNS, toSummaryPassRow } from '@/lib/passes/summary';
import { offerText } from '@/lib/marketing/offers';
import { emptyAggregate, loadAggregates } from '@/lib/marketing/server/campaigns';
import { isMigrationMissing, isMigrationMissingError, toCampaignRow } from '@/lib/marketing/server/repo';
import { MANUAL_CAMPAIGN_LABEL, PLAYBOOK_LABELS } from '@/lib/marketing/types';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { CsvTable } from '@/lib/reports/csv';
import { rangeBounds } from '@/lib/reports/reconcile';
import { fetchAll, IN_CHUNK, withColumnTiers, type PageResult } from '@/lib/reports/reconcileServer';
import { loadOrderDataset } from '@/lib/reports/exports/orderDataServer';
import type { ReportDef } from '@/lib/reports/exports/types';
import {
  beaniesCustomerIds,
  beaniesCustomers,
  beaniesLedger,
  beaniesMetrics,
  beaniesSummary,
  campaignMetrics,
  campaignPerformance,
  DEFAULT_LOYALTY_RATES,
  programmeHighlights,
  ritualMetrics,
  ritualPasses,
  ritualRedemptions,
  ritualReferences,
  ritualSummary,
  type BeaniesInput,
  type CampaignRecord,
  type LedgerRow,
  type LoyaltyCustomer,
  type LoyaltyRates,
  type ProgrammeInsights,
  type RitualAdjustment,
  type RitualInput,
  type RitualOrder,
  type RitualPass,
  type RitualRedemption,
} from '@/lib/reports/exports/loyaltyReports';

export type { ProgrammeInsights } from '@/lib/reports/exports/loyaltyReports';

type Row = Record<string, unknown>;

// ── Small helpers ────────────────────────────────────────────────────────────

function isMissingRelation(err: unknown): boolean {
  const e = err as PostgrestLikeError | undefined;
  return e?.code === '42P01' || e?.code === 'PGRST205' || /does not exist|could not find the table/i.test(e?.message ?? '');
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) out.push(list.slice(i, i + IN_CHUNK));
  return out;
}

/** Runs `load` over each IN_CHUNK slice of `ids` and joins the results. */
async function inChunks<T>(ids: readonly string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  return (await Promise.all(chunks([...new Set(ids)]).map(load))).flat();
}

/** The header of a sheet with no rows, for a feature whose tables are not there yet. */
const blank = (t: CsvTable): CsvTable => ({ columns: t.columns, rows: [] });

// ── Beanies ──────────────────────────────────────────────────────────────────

/** The whole ledger (balances at the period end need every row), oldest first. */
async function loadLedger(admin: SupabaseClient): Promise<LedgerRow[]> {
  try {
    return await fetchAll<LedgerRow>((a, b) =>
      admin
        .from('loyalty_transactions')
        .select('id, user_id, order_id, type, points, note, created_at')
        .order('created_at')
        .order('id')
        .range(a, b) as unknown as PromiseLike<PageResult<LedgerRow>>,
    );
  } catch (err) {
    if (isMissingRelation(err)) return [];
    throw err;
  }
}

async function loadRates(admin: SupabaseClient): Promise<LoyaltyRates> {
  const { data, error } = await admin
    .from('loyalty_config')
    .select('inr_per_point, points_expiry_days')
    .eq('is_singleton', true)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return DEFAULT_LOYALTY_RATES;
    throw new Error(`loyalty report: loyalty_config read failed: ${error.message}`);
  }
  const row = data as { inr_per_point: number | string | null; points_expiry_days: number | null } | null;
  const rate = Number(row?.inr_per_point);
  return {
    inrPerPoint: row && Number.isFinite(rate) ? rate : DEFAULT_LOYALTY_RATES.inrPerPoint,
    expiryDays: row?.points_expiry_days ?? DEFAULT_LOYALTY_RATES.expiryDays,
  };
}

/** profiles.name and phone for these accounts; '' where a profile has no name. */
async function loadCustomers(admin: SupabaseClient, ids: readonly string[]): Promise<Map<string, LoyaltyCustomer>> {
  const rows = await inChunks(ids, async (chunk) => {
    const { data, error } = await admin.from('profiles').select('id, name, phone').in('id', chunk);
    if (error) throw new Error(`loyalty report: profiles read failed: ${error.message}`);
    return (data ?? []) as { id: string; name: string | null; phone: string | null }[];
  });
  return new Map(rows.map((r): [string, LoyaltyCustomer] => [r.id, { name: (r.name ?? '').trim(), phone: r.phone ?? '' }]));
}

interface OrderLookup {
  id: string;
  order_number: number;
  total_inr: number | null;
  status: string;
}

async function loadOrderLookups(admin: SupabaseClient, ids: readonly string[]): Promise<OrderLookup[]> {
  return inChunks(ids, async (chunk) => {
    const { data, error } = await admin.from('orders').select('id, order_number, total_inr, status').in('id', chunk);
    if (error) throw new Error(`loyalty report: order lookup failed: ${error.message}`);
    return (data ?? []) as OrderLookup[];
  });
}

/** Summary sheet and insights: the ledger plus the dataset's orders (what redemptions cost, average bills). */
async function loadBeaniesSummaryInput(admin: SupabaseClient, from: string, to: string, now = new Date()): Promise<BeaniesInput> {
  const [ledger, rates, ds] = await Promise.all([loadLedger(admin), loadRates(admin), loadOrderDataset(admin, from, to)]);
  return { from, to, now, ledger, rates, orders: ds.orders };
}

/** Ledger and by-customer sheets: the ledger with the people (and, for the ledger, the bills) it names. */
async function loadBeaniesPeopleInput(
  admin: SupabaseClient,
  from: string,
  to: string,
  withInvoices: boolean,
): Promise<BeaniesInput> {
  const { startIso, endIso } = rangeBounds(from, to);
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const [ledger, rates] = await Promise.all([loadLedger(admin), loadRates(admin)]);
  const orderIds = withInvoices
    ? ledger
        .filter((r) => r.order_id && Date.parse(r.created_at) >= start && Date.parse(r.created_at) < end)
        .map((r) => r.order_id as string)
    : [];
  const [customers, orders] = await Promise.all([
    loadCustomers(admin, beaniesCustomerIds(ledger, from, to)),
    loadOrderLookups(admin, orderIds),
  ]);
  const invoiceNos = new Map(orders.map((o): [string, string] => [o.id, formatOrderNumber(o.order_number)]));
  return { from, to, now: new Date(), ledger, rates, orders: [], customers, invoiceNos };
}

// ── HIOC Ritual ──────────────────────────────────────────────────────────────

const PASS_VIEW = 'v_coffee_pass_balances';
// drink_label arrived with 2026-10-coffee-pass-per-drink.sql.
const PASS_TIERS = [
  `${SUMMARY_PASS_COLUMNS}, order_id, drinks_used, drink_label`,
  `${SUMMARY_PASS_COLUMNS}, order_id, drinks_used`,
];

const invalidStatus = (s: string) => s === 'cancelled' || s === 'rejected';

/** Every pass, redemption and adjustment ever made (small tables; the period-end liability needs the history), or null when the Ritual tables are not there. */
async function loadRitualInput(admin: SupabaseClient, from: string, to: string, now = new Date()): Promise<RitualInput | null> {
  try {
    const [passRows, redemptionRows, adjustmentRows] = await Promise.all([
      withColumnTiers<Row>(PASS_TIERS, (cols) =>
        fetchAll<Row>((a, b) =>
          admin.from(PASS_VIEW).select(cols).order('created_at').order('id').range(a, b) as unknown as PromiseLike<PageResult<Row>>,
        ),
      ),
      fetchAll<Row>((a, b) =>
        admin
          .from('coffee_pass_redemptions')
          .select('pass_id, order_id, drinks, covered_inr, created_at, reversed_at')
          .order('created_at')
          .order('id')
          .range(a, b) as unknown as PromiseLike<PageResult<Row>>,
      ),
      fetchAll<Row>((a, b) =>
        admin
          .from('coffee_pass_adjustments')
          .select('pass_id, kind, days, drinks, created_at')
          .order('created_at')
          .order('id')
          .range(a, b) as unknown as PromiseLike<PageResult<Row>>,
      ),
    ]);

    const passes: RitualPass[] = passRows.map((r) => ({
      ...toSummaryPassRow(r),
      order_id: r.order_id ? String(r.order_id) : null,
      drink_label: typeof r.drink_label === 'string' ? r.drink_label : '',
      drinks_used: num(r.drinks_used),
    }));
    const redemptions: RitualRedemption[] = redemptionRows.map((r) => ({
      pass_id: String(r.pass_id),
      order_id: String(r.order_id),
      drinks: num(r.drinks),
      covered_inr: num(r.covered_inr),
      created_at: String(r.created_at),
      reversed_at: r.reversed_at ? String(r.reversed_at) : null,
    }));
    const adjustments: RitualAdjustment[] = adjustmentRows.map((r) => ({
      pass_id: String(r.pass_id),
      kind: r.kind as RitualAdjustment['kind'],
      days: r.days === null || r.days === undefined ? null : num(r.days),
      drinks: r.drinks === null || r.drinks === undefined ? null : num(r.drinks),
      created_at: String(r.created_at),
    }));

    const { userIds, orderIds } = ritualReferences({ from, to, passes, redemptions });
    const [holders, orderRows] = await Promise.all([loadCustomers(admin, userIds), loadOrderLookups(admin, orderIds)]);
    const orders = new Map(
      orderRows.map((o): [string, RitualOrder] => [
        o.id,
        { invoiceNo: formatOrderNumber(o.order_number), totalInr: num(o.total_inr), valid: !invalidStatus(o.status) },
      ]),
    );
    return { from, to, now, passes, redemptions, adjustments, holders, orders };
  } catch (err) {
    if (isMissingPassSchema(err as PostgrestLikeError) || isMissingRelation(err)) return null;
    throw err;
  }
}

/** An input with nothing in it: what the Ritual sheets are built from when the tables are missing (then blanked). */
const noRitual = (from: string, to: string): RitualInput => ({ from, to, now: new Date(), passes: [], redemptions: [], adjustments: [] });

// ── Marketing campaigns ──────────────────────────────────────────────────────

/** Coupon discount given on each campaign's own codes, on bills that were not cancelled or rejected (redemptions are not reversed on cancel). */
async function loadCouponDiscounts(admin: SupabaseClient, campaignIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const coupons = await inChunks(campaignIds, (chunk) =>
      fetchAll<{ id: string; campaign_id: string }>((a, b) =>
        admin.from('coupons').select('id, campaign_id').in('campaign_id', chunk).order('id').range(a, b) as unknown as PromiseLike<
          PageResult<{ id: string; campaign_id: string }>
        >,
      ),
    );
    const campaignOf = new Map(coupons.map((c): [string, string] => [c.id, c.campaign_id]));
    const redemptions = await inChunks([...campaignOf.keys()], (chunk) =>
      fetchAll<{ coupon_id: string; order_id: string; discount_inr: number }>((a, b) =>
        admin
          .from('coupon_redemptions')
          .select('coupon_id, order_id, discount_inr')
          .in('coupon_id', chunk)
          .order('id')
          .range(a, b) as unknown as PromiseLike<PageResult<{ coupon_id: string; order_id: string; discount_inr: number }>>,
      ),
    );
    const orders = await loadOrderLookups(admin, redemptions.map((r) => r.order_id));
    const kept = new Set(orders.filter((o) => !invalidStatus(o.status)).map((o) => o.id));
    for (const r of redemptions) {
      const campaign = campaignOf.get(r.coupon_id);
      if (!campaign || !kept.has(r.order_id)) continue;
      out.set(campaign, (out.get(campaign) ?? 0) + num(r.discount_inr));
    }
  } catch (err) {
    // Before the marketing migration coupons have no campaign_id: no campaign codes, no discount.
    if (isMissingColumnError(err as PostgrestLikeError) || isMissingRelation(err)) return new Map();
    throw err;
  }
  return out;
}

/**
 * The campaigns that were sending in the range (started before its end and not
 * finished before its start) with their results to date, or null when the
 * marketing tables are not there. The recipient folding is the Marketing tab's
 * own (loadAggregates), so these figures are the ones the owner already sees.
 */
async function loadCampaignRecords(admin: SupabaseClient, from: string, to: string): Promise<CampaignRecord[] | null> {
  const { startIso, endIso } = rangeBounds(from, to);
  try {
    const raw = await fetchAll<Row>((a, b) =>
      admin
        .from('marketing_campaigns')
        .select('*')
        .not('started_at', 'is', null)
        .lt('started_at', endIso)
        .order('started_at')
        .order('id')
        .range(a, b) as unknown as PromiseLike<PageResult<Row>>,
    );
    const rows = raw.map(toCampaignRow).filter((c) => !c.completed_at || Date.parse(c.completed_at) >= Date.parse(startIso));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [aggregates, discounts] = await Promise.all([loadAggregates(admin, ids), loadCouponDiscounts(admin, ids)]);
    return rows.map((c): CampaignRecord => {
      const a = aggregates.get(c.id) ?? emptyAggregate();
      return {
        name: c.name,
        kind: c.playbook_key ? PLAYBOOK_LABELS[c.playbook_key] : MANUAL_CAMPAIGN_LABEL,
        offer: offerText(c.offer),
        startedAt: c.started_at,
        sent: a.sent,
        delivered: a.delivered,
        read: a.read,
        clicked: a.clicked,
        conversions: a.returned,
        revenueInr: a.revenue_inr,
        treatedConverted: a.treated_converted,
        holdoutN: a.holdout_n,
        holdoutConverted: a.holdout_converted,
        costInr: a.spend_inr,
        couponDiscountInr: discounts.get(c.id) ?? 0,
      };
    });
  } catch (err) {
    if (isMigrationMissingError(err) || isMigrationMissing(err as PostgrestLikeError) || isMissingRelation(err)) return null;
    throw err;
  }
}

// ── Insights ─────────────────────────────────────────────────────────────────

/**
 * The numbers behind the Insights page's Beanies / HIOC Ritual / campaigns
 * section for IST dates from..to. Beanies always loads (and throws if it
 * cannot). Ritual and campaigns are null while their flag is off or their tables
 * are missing; if one is on but fails to load, it is null and `problems` says so,
 * so one broken section does not take down the others.
 */
export async function loadProgrammeInsights(admin: SupabaseClient, from: string, to: string): Promise<ProgrammeInsights> {
  const now = new Date();
  const problems: ProgrammeInsights['problems'] = {};

  const section = async <T>(on: boolean, key: 'ritual' | 'campaigns', label: string, run: () => Promise<T | null>) => {
    if (!on) return null;
    try {
      return await run();
    } catch (err) {
      console.error(`loadProgrammeInsights: ${key} failed`, err);
      problems[key] = `Could not load the ${label} numbers.`;
      return null;
    }
  };

  const [beaniesInput, ritual, campaigns] = await Promise.all([
    loadBeaniesSummaryInput(admin, from, to, now),
    section(flags.coffeePass, 'ritual', 'HIOC Ritual', async () => {
      const input = await loadRitualInput(admin, from, to, now);
      return input ? ritualMetrics(input) : null;
    }),
    section(flags.marketing, 'campaigns', 'marketing campaign', async () => {
      const records = await loadCampaignRecords(admin, from, to);
      return records ? campaignMetrics(records) : null;
    }),
  ]);

  const beanies = beaniesMetrics(beaniesInput);
  return {
    range: { from, to },
    beanies,
    ritual,
    campaigns,
    highlights: programmeHighlights({ beanies, ritual, campaigns }),
    problems,
  };
}

// ── The registry ─────────────────────────────────────────────────────────────

const BEANIES_REPORTS: ReportDef[] = [
  {
    key: 'beanies-summary',
    group: 'loyalty',
    title: 'Beanies summary',
    description:
      'Beanies earned, redeemed and expired in the period, what the redemptions cost in rupees, and the Beanies still outstanding at the end of it (your liability), with how many expire soon.',
    load: async (admin, from, to) => beaniesSummary(await loadBeaniesSummaryInput(admin, from, to)),
  },
  {
    key: 'beanies-ledger',
    group: 'loyalty',
    title: 'Beanies ledger',
    description:
      'Every Beanies movement in the period (earned, redeemed, expired, reversed, adjusted) with the customer (phone masked) and the bill it came from.',
    load: async (admin, from, to) => beaniesLedger(await loadBeaniesPeopleInput(admin, from, to, true)),
  },
  {
    key: 'beanies-customers',
    group: 'loyalty',
    title: 'Beanies by customer',
    description:
      'Each customer’s Beanies earned, redeemed, expired and held at the end of the period, biggest balance first (phone masked).',
    load: async (admin, from, to) => beaniesCustomers(await loadBeaniesPeopleInput(admin, from, to, false)),
  },
];

/** A Ritual sheet: built from the passes, or just its header while the Ritual tables are missing. */
function ritualSheet(build: (input: RitualInput) => CsvTable): ReportDef['load'] {
  return async (admin, from, to) => {
    const input = await loadRitualInput(admin, from, to);
    return input ? build(input) : blank(build(noRitual(from, to)));
  };
}

const RITUAL_REPORTS: ReportDef[] = [
  {
    key: 'ritual-summary',
    group: 'loyalty',
    title: 'HIOC Ritual summary',
    description:
      'HIOC Ritual passes sold, refunded and renewed, cups served, and the cups still owed to customers at the end of the period (liability), with expired-unused cups.',
    load: ritualSheet(ritualSummary),
  },
  {
    key: 'ritual-passes',
    group: 'loyalty',
    title: 'HIOC Ritual passes sold',
    description:
      'Every HIOC Ritual pass sold in the period with its buyer (phone masked), plan, drink, price, cups used and left, and state.',
    load: ritualSheet(ritualPasses),
  },
  {
    key: 'ritual-redemptions',
    group: 'loyalty',
    title: 'HIOC Ritual cups served',
    description:
      'Every HIOC Ritual cup served in the period with the bill it was served on; reversed cups are flagged and not counted in the total.',
    load: ritualSheet(ritualRedemptions),
  },
];

const CAMPAIGN_REPORTS: ReportDef[] = [
  {
    key: 'campaign-performance',
    group: 'loyalty',
    title: 'Marketing campaign results',
    description:
      'Each campaign that was sending in the period: messages sent and read, customers who came back, revenue, cost, lift against the holdout and coupon discount. Results are for each campaign’s whole run so far.',
    load: async (admin, from, to) => campaignPerformance((await loadCampaignRecords(admin, from, to)) ?? []),
  },
];

export const LOYALTY_REPORTS: ReportDef[] = [
  ...BEANIES_REPORTS,
  ...(flags.coffeePass ? RITUAL_REPORTS : []),
  ...(flags.marketing ? CAMPAIGN_REPORTS : []),
];
