// The dashboard's read models: the Overview tab and the Audience tab (spec §1.9, §7).
// Everything here is computed on load from the same joined snapshot the planner uses
// (audience.ts), so the numbers an owner sees are the numbers the agent acts on.

import 'server-only';
import { computeLift, rankFreeItems } from '@/lib/marketing/economics';
import { DAY_MS, istMonthStart } from '@/lib/marketing/ist';
import { optinUrl } from '@/lib/marketing/optin';
import { LOYALTY_UNIT } from '@/lib/loyalty/brand';
import { detectDrop, weeklyActive } from '@/lib/marketing/segments';
import {
  DEFAULT_SETTINGS,
  INSIGHT_EXPIRY_DAYS,
  LIFECYCLE_STAGES,
  MIN_COST_COVERAGE_PCT,
  MIN_HOLDOUT_FOR_LIFT,
  WEEKLY_ACTIVE_WEEKS,
} from '@/lib/marketing/types';
import type {
  AudienceSummary,
  ConsentEventRow,
  Insight,
  LifecycleStage,
  MarketingKpis,
  MarketingOverview,
  MarketingOverviewSummary,
  PlaybookKey,
} from '@/lib/marketing/types';
import { whatsappReminderHealth } from '@/lib/notifications/health';
import { buildContacts, type AudienceSnapshot } from './audience';
import { loadAggregates, projectionOf, recentCampaigns } from './campaigns';
import {
  assertOk,
  loadCampaignsByIds,
  loadSettings,
  loadValidOrders,
  marketingAdmin,
  pageAll,
  sumSpendSince,
  type Admin,
} from './repo';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A phone for an audit list: '+91 98••• ••210'. The list is for spotting patterns, not for looking people up. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/^\+/, '');
  if (phone.startsWith('+91') && digits.length === 12) return `+91 ${digits.slice(2, 4)}••• ••${digits.slice(-3)}`;
  return `${phone.slice(0, Math.min(3, phone.length))}••• ••${phone.slice(-3)}`;
}

const ACTIVE_STAGES: readonly LifecycleStage[] = ['new', 'active', 'at_risk'];
const LAPSED_STAGES: readonly LifecycleStage[] = ['lapsed_1', 'lapsed_2', 'lapsed_3'];
const WINBACK_KEYS: readonly PlaybookKey[] = ['winback_1', 'winback_2', 'winback_3'];

const canMessage = (c: AudienceSnapshot['contacts'][number]) => c.stats.consent_opted_in && !c.stats.opt_out_listed;

// ---------------------------------------------------------------------------
// Insights (spec §1.9)
// ---------------------------------------------------------------------------

/** Each insight has a call to action; none is shown when there is nothing to say. Pure over the snapshot. */
export function buildInsights(snapshot: AudienceSnapshot, receiptsConnected: boolean, activeOptedInPct: number | null, activeCustomers: number): Insight[] {
  const out: Insight[] = [];
  const { contacts, playbooks, economics } = snapshot;
  const mode = (key: PlaybookKey) => playbooks.find((p) => p.key === key)?.mode ?? 'off';

  // 1. Points about to expire, and nothing warning the customers about it.
  if (mode('points_expiring') === 'off') {
    const expiring = contacts.filter((c) => c.stats.expiring_points_7d > 0);
    const value = expiring.reduce((s, c) => s + c.stats.expiring_value_7d_inr, 0);
    if (value > 0) {
      out.push({
        id: 'points_expiring_off',
        tone: 'warn',
        message: `₹${value} of ${LOYALTY_UNIT.many} (${expiring.length} ${expiring.length === 1 ? 'customer' : 'customers'}) expire in the next ${INSIGHT_EXPIRY_DAYS} days.`,
        cta: { label: 'Turn on Beanies reminders', tab: 'playbooks', playbook_key: 'points_expiring' },
      });
    }
  }

  // 2. Customers slipping away with no win-back running.
  if (WINBACK_KEYS.every((k) => mode(k) === 'off')) {
    const recentlyLapsed = contacts.filter((c) => {
      const d = c.stats.days_since_last_order;
      return LAPSED_STAGES.includes(c.stats.stage) && d !== null && d - c.stats.stage1_days < 30;
    }).length;
    if (recentlyLapsed > 0) {
      out.push({
        id: 'lapsed_no_winback',
        tone: 'warn',
        message: `${recentlyLapsed} ${recentlyLapsed === 1 ? 'customer' : 'customers'} became lapsed this month.`,
        cta: { label: 'Turn on win-back', tab: 'playbooks', playbook_key: 'winback_1' },
      });
    }
  }

  // 3. Few of the customers can be reached at all.
  if (activeCustomers > 0 && activeOptedInPct !== null && activeOptedInPct < 30) {
    out.push({
      id: 'low_consent_coverage',
      tone: 'info',
      message: `Only ${Math.round(activeOptedInPct)}% of your active customers can receive offers.`,
      cta: { label: 'Get the opt-in QR', tab: 'audience' },
    });
  }

  // 4. Costs missing for what actually sells.
  const coverage = economics.food_cost.coverage_pct;
  if (economics.food_cost.revenue_inr > 0 && coverage < MIN_COST_COVERAGE_PCT) {
    out.push({
      id: 'costs_missing',
      tone: 'warn',
      message: `Costs missing for items making ${Math.round(100 - coverage)}% of revenue.`,
      cta: { label: 'Enter product costs', tab: 'costs' },
    });
  }

  // 5. The best free-item offer, once there are costs to rank by.
  const best = rankFreeItems(economics.variants)[0];
  if (best) {
    const name = best.variant_label && best.variant_label.toLowerCase() !== 'regular' ? `${best.item_name} (${best.variant_label})` : best.item_name;
    out.push({
      id: 'best_free_item',
      tone: 'info',
      message: `Best free-item offer: ${name} (worth ₹${best.price_inr}, costs ₹${round1(best.cost_inr)}).`,
      cta: { label: 'See product costs', tab: 'costs' },
    });
  }

  // 6. Without receipts, STOP/START and delivery tracking cannot work.
  if (!receiptsConnected) {
    out.push({
      id: 'receipts_not_connected',
      tone: 'warn',
      message: 'Delivery receipts are not connected: set WHATSAPP_APP_SECRET, or STOP/START and delivery tracking will not work.',
      cta: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

interface SentRow {
  campaign_id: string;
  arm: string;
  status: string;
  cost_inr: number | string;
  converted_at: string | null;
  conversion_revenue_inr: number | string;
}

/**
 * Treated recipients touched in the last 30 days: sent then, or converted then.
 *
 * `sent` is every treated row that LEFT in the window (sent_at set), the later-failed ones
 * included. Meta reports 131049 ("not delivered to maintain ecosystem engagement") a while
 * AFTER accepting the message, and the webhook then moves the row sent → failed while keeping
 * its sent_at; a status filter of sent/delivered/read would quietly remove exactly the messages
 * that did not arrive and make delivery look better than it is. (A failed row costs 0.)
 */
async function loadRecent30(admin: Admin, sinceIso: string): Promise<{ sent: SentRow[]; converted: SentRow[] }> {
  const cols = 'campaign_id, arm, status, cost_inr, converted_at, conversion_revenue_inr';
  const [sent, converted] = await Promise.all([
    pageAll<SentRow>('marketing_recipients read', (from, to) =>
      admin
        .from('marketing_recipients')
        .select(cols)
        .eq('arm', 'treatment')
        .in('status', ['sent', 'delivered', 'read', 'failed'])
        .gte('sent_at', sinceIso)
        .order('sent_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    pageAll<SentRow>('marketing_recipients read', (from, to) =>
      admin
        .from('marketing_recipients')
        .select(cols)
        .eq('arm', 'treatment')
        .gte('converted_at', sinceIso)
        .order('converted_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ]);
  return { sent, converted };
}

/**
 * GET /overview?summary=1 — what the /owner home card shows: the kill switch, campaigns
 * waiting for a decision, this month's spend against the budget, and the customer-drop alert.
 * Four cheap reads instead of the whole snapshot: the settings, a count, a sum, and just the
 * orders the weekly chart looks at (WEEKLY_ACTIVE_WEEKS complete weeks plus the week in progress
 * fit inside one more week's margin). The alert is the same detectDrop over the same series the
 * full overview shows, so the card and the Overview tab can never disagree.
 */
export async function getOverviewSummary(now: Date = new Date()): Promise<MarketingOverviewSummary> {
  const admin = marketingAdmin();
  const sinceOrders = new Date(now.getTime() - (WEEKLY_ACTIVE_WEEKS + 1) * 7 * DAY_MS).toISOString();
  const [stored, monthSpend, pendingRes, orders] = await Promise.all([
    loadSettings(admin),
    sumSpendSince(admin, istMonthStart(now).toISOString()),
    admin.from('marketing_campaigns').select('id', { count: 'exact', head: true }).in('status', ['draft', 'pending_approval']),
    loadValidOrders(sinceOrders),
  ]);
  assertOk('marketing_campaigns count', pendingRes.error);
  const settings = stored ?? DEFAULT_SETTINGS;
  return {
    enabled: stored !== null && stored.enabled,
    pending_approvals: pendingRes.count ?? 0,
    month_spend_inr: Math.round(monthSpend * 1000) / 1000,
    month_budget_inr: settings.monthly_budget_inr,
    drop_alert: detectDrop(weeklyActive(orders, now), settings.drop_alert_pct),
  };
}

/** GET /overview. */
export async function getOverview(now: Date = new Date()): Promise<MarketingOverview> {
  const admin = marketingAdmin();
  const snapshot = await buildContacts(now, admin);
  const { settings, contacts, economics } = snapshot;
  const since30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const since90 = new Date(now.getTime() - 90 * DAY_MS).toISOString();

  // ---- reach ----------------------------------------------------------------
  const active = contacts.filter((c) => ACTIVE_STAGES.includes(c.stats.stage));
  const activeReachable = active.filter(canMessage).length;
  const activeOptedInPct = active.length > 0 ? round1((100 * activeReachable) / active.length) : null;
  const optedIn = snapshot.consent.filter((c) => c.status === 'opted_in').length;

  // ---- sends and returns (30 days) ------------------------------------------
  const [monthSpend, recent, pendingRes] = await Promise.all([
    sumSpendSince(admin, istMonthStart(now).toISOString()),
    loadRecent30(admin, since30),
    admin.from('marketing_campaigns').select('id', { count: 'exact', head: true }).in('status', ['draft', 'pending_approval']),
  ]);
  assertOk('marketing_campaigns count', pendingRes.error);

  const sent30 = recent.sent.length;
  const delivered30 = recent.sent.filter((r) => r.status === 'delivered' || r.status === 'read').length;
  const read30 = recent.sent.filter((r) => r.status === 'read').length;
  const receiptsFlowing = snapshot.receipts_connected;
  const returning = recent.converted;
  const returningRevenue = returning.reduce((s, r) => s + (Number(r.conversion_revenue_inr) || 0), 0);

  // ---- measured lift: pooled over recently completed campaigns with a big-enough holdout ----
  const { data: doneRows, error: doneError } = await admin
    .from('marketing_campaigns')
    .select('id')
    .eq('status', 'completed')
    .not('started_at', 'is', null)
    .gte('started_at', since90);
  assertOk('marketing_campaigns read', doneError);
  const doneIds = ((doneRows ?? []) as { id: string }[]).map((r) => r.id);
  const aggregates = await loadAggregates(admin, doneIds);
  const pooled = { treated_delivered: 0, treated_converted: 0, holdout_n: 0, holdout_converted: 0 };
  for (const a of aggregates.values()) {
    if (a.holdout_n < MIN_HOLDOUT_FOR_LIFT) continue;
    pooled.treated_delivered += a.sent;
    pooled.treated_converted += a.treated_converted;
    pooled.holdout_n += a.holdout_n;
    pooled.holdout_converted += a.holdout_converted;
  }
  const liftPp = pooled.holdout_n >= MIN_HOLDOUT_FOR_LIFT ? computeLift(pooled).lift_pp : null;

  // ---- estimated ROI (30 days) ------------------------------------------------
  // profit ≈ revenue that came back × (1 − food cost) − what the offers cost − what the messages cost.
  // Conservative on purpose: a percentage offer's discount is already out of the order total, and is subtracted again.
  const spend30 = recent.sent.reduce((s, r) => s + (Number(r.cost_inr) || 0), 0);
  const campaignsOfReturns = await loadCampaignsByIds(admin, [...new Set(returning.map((r) => r.campaign_id))]);
  const offerCost = returning.reduce((s, r) => {
    const c = campaignsOfReturns.get(r.campaign_id);
    return s + (c ? projectionOf(c).offer_cost_inr : 0);
  }, 0);
  const denominator = spend30 + offerCost;
  const estProfit = returningRevenue * (1 - economics.food_cost.ratio) - offerCost - spend30;

  const kpis: MarketingKpis = {
    opted_in: optedIn,
    active_customers: active.length,
    active_opted_in_pct: activeOptedInPct,
    month_spend_inr: Math.round(monthSpend * 1000) / 1000,
    monthly_budget_inr: settings.monthly_budget_inr,
    messages_sent_30d: sent30,
    delivered_pct_30d: receiptsFlowing && sent30 > 0 ? round1((100 * delivered30) / sent30) : null,
    read_pct_30d: receiptsFlowing && delivered30 > 0 ? round1((100 * read30) / delivered30) : null,
    returning_orders_30d: returning.length,
    returning_revenue_30d_inr: Math.round(returningRevenue),
    lift_pp: liftPp,
    est_roi: denominator > 0 ? estProfit / denominator : null,
  };

  // ---- the customer-count series and its drop alert ---------------------------
  const weekly = weeklyActive(snapshot.orders, now);

  return {
    enabled: snapshot.settings_present && settings.enabled,
    whatsapp_configured: whatsappReminderHealth().configured,
    receipts_connected: snapshot.receipts_connected,
    kpis,
    pending_approvals: pendingRes.count ?? 0,
    weekly,
    drop_alert: detectDrop(weekly, settings.drop_alert_pct),
    insights: buildInsights(snapshot, snapshot.receipts_connected, activeOptedInPct, active.length),
    recent_campaigns: await recentCampaigns(admin, 8, now),
  };
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

/** GET /audience. */
export async function getAudienceSummary(now: Date = new Date()): Promise<AudienceSummary> {
  const admin = marketingAdmin();
  const snapshot = await buildContacts(now, admin);
  const { contacts, consent, settings } = snapshot;

  const stages = LIFECYCLE_STAGES.map((stage) => {
    const inStage = contacts.filter((c) => c.stats.stage === stage);
    return { stage, all: inStage.length, opted_in: inStage.filter(canMessage).length };
  });

  const withBalance = contacts.filter((c) => c.stats.points_balance > 0);
  const expiring = contacts.filter((c) => c.stats.expiring_points_7d > 0);

  const bySource = new Map<string, { source: string; opted_in: number; opted_out: number }>();
  for (const c of consent) {
    const key = c.source || 'unknown';
    const row = bySource.get(key) ?? { source: key, opted_in: 0, opted_out: 0 };
    if (c.status === 'opted_in') row.opted_in += 1;
    else row.opted_out += 1;
    bySource.set(key, row);
  }

  const { data: events, error } = await admin
    .from('marketing_consent_events')
    .select('phone, action, source, created_at')
    .gte('created_at', new Date(now.getTime() - 30 * DAY_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(50);
  assertOk('marketing_consent_events read', error);
  const recentEvents: ConsentEventRow[] = ((events ?? []) as { phone: string; action: 'opt_in' | 'opt_out'; source: string; created_at: string }[]).map((e) => ({
    phone_masked: maskPhone(e.phone),
    action: e.action,
    source: e.source,
    created_at: e.created_at,
  }));

  return {
    total_customers: contacts.length,
    stages,
    points: {
      customers_with_balance: withBalance.length,
      outstanding_inr: withBalance.reduce((s, c) => s + c.stats.points_value_inr, 0),
      expiring_7d_inr: expiring.reduce((s, c) => s + c.stats.expiring_value_7d_inr, 0),
      expiring_7d_customers: expiring.length,
    },
    consent: {
      opted_in: consent.filter((c) => c.status === 'opted_in').length,
      opted_out: consent.filter((c) => c.status === 'opted_out').length,
      by_source: [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source)),
      recent_events: recentEvents,
    },
    whatsapp_business_number: settings.whatsapp_business_number,
    optin_url: optinUrl(settings.whatsapp_business_number),
  };
}

