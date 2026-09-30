import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb, Row } from './helpers/marketingDb';
import {
  NOW_SEND,
  daysAgo,
  newDb,
  rowsOf,
  seedCostedMenu,
  seedCustomer,
  seedLoyalty,
  seedPlaybooks,
  seedSettings,
} from './helpers/marketingWorld';

// The dashboard read models (spec §1.9, §7): Overview, Audience and Product costs. Real
// lib/marketing/server/{overview,costs}.ts over an in-memory database.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/notifications/adapters', () => ({ whatsappAdapter: { send: vi.fn() } }));

const { getOverview, getOverviewSummary, getAudienceSummary, maskPhone } = await import('@/lib/marketing/server/overview');
const { optinUrl } = await import('@/lib/marketing/optin');
const { listCosts, putCosts } = await import('@/lib/marketing/server/costs');

const db = () => h.db;
const phone = (n: number) => `+9198765${String(40000 + n)}`;
const insight = (o: Awaited<ReturnType<typeof getOverview>>, id: string) => o.insights.find((i) => i.id === id);

let rn = 0;
function seedRecipient(over: Row = {}): Row {
  const row: Row = {
    id: `rec${++rn}`, campaign_id: 'c1', phone: phone(500 + rn), arm: 'treatment', status: 'sent', cost_inr: 1.02, sent_at: daysAgo(3), created_at: daysAgo(3),
    converted_at: null, conversion_revenue_inr: 0, ...over,
  };
  (db().tables.marketing_recipients ??= []).push(row);
  return row;
}

beforeEach(() => {
  rn = 0;
  h.db = newDb();
  seedSettings(db());
  seedPlaybooks(db());
  seedLoyalty(db());
  seedCostedMenu(db());
  process.env.WHATSAPP_TOKEN = 'token';
  process.env.WHATSAPP_PHONE_ID = 'phone-id';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('helpers', () => {
  it('masks a phone for the audit list', () => {
    expect(maskPhone('+919876543210')).toBe('+91 98••• ••210');
    expect(maskPhone('+14155550123')).toBe('+14••• ••123');
  });

  it('builds the wa.me opt-in link from the business number', () => {
    expect(optinUrl('+91 98765 00000')).toBe('https://wa.me/919876500000?text=START');
    expect(optinUrl('')).toBeNull();
    expect(optinUrl(undefined)).toBeNull();
  });
});

describe('overview: the headline numbers', () => {
  it('reports the kill switch, WhatsApp configuration and whether receipts flow', async () => {
    let o = await getOverview(NOW_SEND);
    expect(o).toMatchObject({ enabled: true, whatsapp_configured: true, receipts_connected: false });

    seedSettings(db(), { enabled: false });
    delete process.env.WHATSAPP_TOKEN;
    o = await getOverview(NOW_SEND);
    expect(o).toMatchObject({ enabled: false, whatsapp_configured: false });

    seedRecipient({ status: 'delivered' });
    expect((await getOverview(NOW_SEND)).receipts_connected).toBe(true);
  });

  it('counts opted-in customers and the share of ACTIVE customers who can be reached', async () => {
    for (let i = 0; i < 4; i++) seedCustomer(db(), { phone: phone(i), orders: [[3, 300]], optedIn: i < 1 });
    seedCustomer(db(), { phone: phone(10), orders: [[90, 300]], optedIn: true }); // lapsed: not "active"
    const o = await getOverview(NOW_SEND);
    expect(o.kpis).toMatchObject({ opted_in: 2, active_customers: 4, active_opted_in_pct: 25 });
  });

  it('has no coverage percentage when there are no active customers', async () => {
    expect((await getOverview(NOW_SEND)).kpis.active_opted_in_pct).toBeNull();
  });

  it('spend is this IST month only, sends are the last 30 days, and failures cost nothing', async () => {
    seedSettings(db(), { monthly_budget_inr: 500 });
    seedRecipient({ sent_at: daysAgo(2), cost_inr: 1.02 });
    seedRecipient({ sent_at: daysAgo(4), status: 'delivered', cost_inr: 1.02 });
    seedRecipient({ sent_at: '2026-09-30T18:00:00.000Z', cost_inr: 1.02 }); // still September in IST
    seedRecipient({ status: 'failed', sent_at: null, cost_inr: 0 });
    const k = (await getOverview(NOW_SEND)).kpis;
    expect(k.month_spend_inr).toBeCloseTo(2.04);
    expect(k.monthly_budget_inr).toBe(500);
    expect(k.messages_sent_30d).toBe(3);
  });

  it('delivered% and read% appear only when receipts are flowing', async () => {
    for (let i = 0; i < 4; i++) seedRecipient({ status: 'sent' });
    expect((await getOverview(NOW_SEND)).kpis).toMatchObject({ delivered_pct_30d: null, read_pct_30d: null });

    db().tables.marketing_recipients = [];
    seedRecipient({ status: 'read' });
    seedRecipient({ status: 'delivered' });
    seedRecipient({ status: 'delivered' });
    seedRecipient({ status: 'sent' });
    // 3 of 4 delivered (75%); 1 of those 3 read (33.3%).
    expect((await getOverview(NOW_SEND)).kpis).toMatchObject({ messages_sent_30d: 4, delivered_pct_30d: 75, read_pct_30d: 33.3 });
  });

  // Meta's 131049 arrives AFTER it accepted the message; the webhook then moves the row sent → failed but keeps sent_at.
  // Dropping those rows from the denominator made delivery look better than it is.
  it('delivered% counts the messages that were sent and LATER failed in its denominator', async () => {
    for (let i = 0; i < 6; i++) seedRecipient({ status: 'delivered' });
    for (let i = 0; i < 2; i++) seedRecipient({ status: 'read' });
    for (let i = 0; i < 4; i++) seedRecipient({ status: 'failed', sent_at: daysAgo(3), cost_inr: 0 }); // sent, then 131049
    seedRecipient({ status: 'failed', sent_at: null, cost_inr: 0 }); // the sender failed it: nothing left
    seedRecipient({ arm: 'holdout', status: 'holdout', sent_at: null, cost_inr: 0 });
    const k = (await getOverview(NOW_SEND)).kpis;
    // 8 delivered or read of the 12 that left → 66.7%, not 8/8 = 100%.
    expect(k).toMatchObject({ messages_sent_30d: 12, delivered_pct_30d: 66.7, read_pct_30d: 25 });
    // They cost nothing, so the spend is unchanged.
    expect(k.month_spend_inr).toBeCloseTo(8 * 1.02);
  });

  it('returning orders and revenue are treated recipients attributed in the last 30 days', async () => {
    seedRecipient({ status: 'delivered', converted_at: daysAgo(2), conversion_revenue_inr: 300 });
    seedRecipient({ status: 'delivered', converted_at: daysAgo(5), conversion_revenue_inr: 200 });
    seedRecipient({ status: 'delivered', converted_at: daysAgo(45), conversion_revenue_inr: 999, sent_at: daysAgo(50) });
    seedRecipient({ arm: 'holdout', status: 'holdout', converted_at: daysAgo(2), conversion_revenue_inr: 700, sent_at: null });
    const k = (await getOverview(NOW_SEND)).kpis;
    expect(k).toMatchObject({ returning_orders_30d: 2, returning_revenue_30d_inr: 500 });
  });

  it('estimated ROI: revenue that came back × (1 − food cost) − offer cost − message spend, over what was spent', async () => {
    db().tables.marketing_campaigns = [{ id: 'c1', kind: 'playbook', playbook_key: 'winback_1', status: 'completed', projection: { offer_cost_inr: 40 }, created_at: daysAgo(5) }];
    // 100 messages sent (₹102), 10 came back with ₹3000 in total.
    for (let i = 0; i < 100; i++) seedRecipient({ status: 'delivered', converted_at: i < 10 ? daysAgo(2) : null, conversion_revenue_inr: i < 10 ? 300 : 0 });
    // Food cost here: costed lines → ratio 60/200 = 0.30? (the seeded lines are ₹ per order; see below)
    const o = await getOverview(NOW_SEND);
    const ratio = 0.35; // no order lines seeded → the default 35%
    const offerCost = 10 * 40;
    const profit = 3000 * (1 - ratio) - offerCost - 100 * 1.02;
    expect(o.kpis.est_roi).toBeCloseTo(profit / (100 * 1.02 + offerCost), 5);
  });

  it('estimated ROI is null when nothing was spent', async () => {
    expect((await getOverview(NOW_SEND)).kpis.est_roi).toBeNull();
  });

  it('counts campaigns awaiting a decision, and lists the latest', async () => {
    for (const [id, status] of [['a', 'draft'], ['b', 'pending_approval'], ['c', 'approved'], ['d', 'completed']] as const) {
      db().tables.marketing_campaigns = [...(db().tables.marketing_campaigns ?? []), { id, kind: 'manual', status, name: id, template: { name: 't', lang: 'en', vars: [], url_button: false, body_preview: '' }, created_at: daysAgo(10 - id.charCodeAt(0) + 96) }];
    }
    const o = await getOverview(NOW_SEND);
    expect(o.pending_approvals).toBe(2);
    expect(o.recent_campaigns.map((c) => c.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('measured lift pools recently completed campaigns whose holdout is big enough', async () => {
    const campaign = (id: string, holdoutN: number, treatedConv: number, holdoutConv: number) => {
      db().tables.marketing_campaigns = [...(db().tables.marketing_campaigns ?? []), { id, kind: 'manual', status: 'completed', started_at: daysAgo(20), created_at: daysAgo(20) }];
      for (let i = 0; i < 100; i++) seedRecipient({ campaign_id: id, status: 'delivered', sent_at: daysAgo(20), converted_at: i < treatedConv ? daysAgo(18) : null });
      for (let i = 0; i < holdoutN; i++) seedRecipient({ campaign_id: id, arm: 'holdout', status: 'holdout', sent_at: null, converted_at: i < holdoutConv ? daysAgo(18) : null });
    };
    campaign('big', 50, 30, 5); // treated 30%, holdout 10%  → +20pp
    campaign('tiny', 5, 0, 5); // too small a holdout: ignored, however extreme
    expect((await getOverview(NOW_SEND)).kpis.lift_pp).toBeCloseTo(20);
  });

  it('measured lift is null when no campaign qualifies', async () => {
    expect((await getOverview(NOW_SEND)).kpis.lift_pp).toBeNull();
  });
});

describe('overview: the weekly chart and drop alert', () => {
  function week(monday: string, customers: number) {
    for (let i = 0; i < customers; i++) {
      (db().tables.orders ??= []).push({
        id: `w-${monday}-${i}`, created_at: `${monday}T08:00:00.000Z`, total_inr: 200, status: 'completed', user_id: `wk-${monday}-${i}`,
        customer_user_id: null, customer_name: null, customer_phone: null,
      });
    }
  }

  it('returns nine complete IST weeks, oldest first, zero-filled', async () => {
    week('2026-09-28', 3);
    const { weekly } = await getOverview(NOW_SEND);
    expect(weekly).toHaveLength(9);
    expect(weekly[8]).toEqual({ week_start: '2026-09-28', customers: 3, orders: 3 });
    expect(weekly[0].week_start).toBe('2026-08-03');
    expect(weekly[0]).toMatchObject({ customers: 0, orders: 0 });
  });

  it('raises the alert when last week fell 15%+ below the prior four-week mean', async () => {
    for (const m of ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']) week(m, 10);
    week('2026-09-28', 5);
    const o = await getOverview(NOW_SEND);
    expect(o.drop_alert).toEqual({ week_start: '2026-09-28', last_week_customers: 5, baseline_customers: 10, drop_pct: 50, drop_customers: 5 });
  });

  it('is quiet when last week held up', async () => {
    for (const m of ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']) week(m, 10);
    week('2026-09-28', 9);
    expect((await getOverview(NOW_SEND)).drop_alert).toBeNull();
  });

  it('uses the owner\'s threshold', async () => {
    seedSettings(db(), { drop_alert_pct: 5 });
    for (const m of ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']) week(m, 10);
    week('2026-09-28', 9);
    expect((await getOverview(NOW_SEND)).drop_alert).toMatchObject({ drop_pct: 10 });
  });
});

// The /owner home card used to call the full overview (a year of orders, the whole ledger) on EVERY visit.
describe('getOverviewSummary — what the /owner home card shows', () => {
  function week(monday: string, customers: number) {
    for (let i = 0; i < customers; i++) {
      (db().tables.orders ??= []).push({
        id: `w-${monday}-${i}`, created_at: `${monday}T08:00:00.000Z`, total_inr: 200, status: 'completed', user_id: `wk-${monday}-${i}`,
        customer_user_id: null, customer_name: null, customer_phone: null,
      });
    }
  }
  const campaign = (id: string, status: string) =>
    (db().tables.marketing_campaigns ??= []).push({ id, kind: 'manual', status, name: id, created_at: daysAgo(2) });

  it('is exactly the five fields of the contract', async () => {
    seedSettings(db(), { monthly_budget_inr: 500, enabled: true });
    campaign('a', 'draft');
    campaign('b', 'pending_approval');
    campaign('c', 'approved');
    campaign('d', 'completed');
    seedRecipient({ sent_at: daysAgo(2), cost_inr: 1.02 });
    seedRecipient({ sent_at: daysAgo(40), cost_inr: 1.02 }); // last month
    for (const m of ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']) week(m, 10);
    week('2026-09-28', 5);

    const s = await getOverviewSummary(NOW_SEND);

    expect(Object.keys(s).sort()).toEqual(['drop_alert', 'enabled', 'month_budget_inr', 'month_spend_inr', 'pending_approvals']);
    expect(s).toEqual({
      enabled: true,
      pending_approvals: 2,
      month_spend_inr: 1.02,
      month_budget_inr: 500,
      drop_alert: { week_start: '2026-09-28', last_week_customers: 5, baseline_customers: 10, drop_pct: 50, drop_customers: 5 },
    });
  });

  it('agrees with the full overview on every number they share', async () => {
    seedSettings(db(), { monthly_budget_inr: 750 });
    campaign('a', 'pending_approval');
    seedRecipient({ sent_at: daysAgo(1), cost_inr: 1.02 });
    for (const m of ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21']) week(m, 8);
    week('2026-09-28', 4);
    const [full, summary] = [await getOverview(NOW_SEND), await getOverviewSummary(NOW_SEND)];
    expect(summary).toEqual({
      enabled: full.enabled,
      pending_approvals: full.pending_approvals,
      month_spend_inr: full.kpis.month_spend_inr,
      month_budget_inr: full.kpis.monthly_budget_inr,
      drop_alert: full.drop_alert,
    });
    expect(summary.drop_alert).not.toBeNull();
  });

  it('is cheap: it needs none of the tables the full overview joins (consent, opt-outs, ledger, profiles, menu, history)', async () => {
    seedSettings(db(), { monthly_budget_inr: 500 });
    for (const t of ['marketing_consent', 'whatsapp_opt_outs', 'loyalty_transactions', 'profiles', 'menu_items', 'menu_item_variants', 'menu_item_costs', 'marketing_playbooks']) {
      db().setMissing(t, true);
    }
    await expect(getOverview(NOW_SEND)).rejects.toMatchObject({ migration_missing: true });
    await expect(getOverviewSummary(NOW_SEND)).resolves.toMatchObject({ enabled: true, month_budget_inr: 500 });
  });

  it('reads only about ten weeks of orders, never the year', async () => {
    const seen: string[] = [];
    const inner = db().client;
    db().client = {
      ...inner,
      from: (t: string) => {
        const q = inner.from(t) as { gte: (c: string, v: string) => unknown };
        if (t !== 'orders') return q;
        const gte = q.gte.bind(q);
        return Object.assign(q, { gte: (c: string, v: string) => (seen.push(v), gte(c, v)) });
      },
    };
    await getOverviewSummary(NOW_SEND);
    expect(seen).toHaveLength(1);
    const days = (NOW_SEND.getTime() - Date.parse(seen[0])) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(63);
    expect(days).toBeLessThanOrEqual(77);
  });

  it('with no settings row it says sending is OFF and uses the default budget; with no campaigns nothing waits', async () => {
    db().tables.marketing_settings = [];
    expect(await getOverviewSummary(NOW_SEND)).toEqual({ enabled: false, pending_approvals: 0, month_spend_inr: 0, month_budget_inr: 1000, drop_alert: null });
  });

  it('reports a missing migration as the typed error (the route answers 409; the card then renders nothing)', async () => {
    db().setMissing('marketing_settings', true);
    await expect(getOverviewSummary(NOW_SEND)).rejects.toMatchObject({ migration_missing: true });
  });
});

describe('overview: insights', () => {
  it('points about to expire, with nothing warning the customers', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[10, 300]], points: [[28, 60]] });
    seedCustomer(db(), { phone: phone(2), orders: [[10, 300]], points: [[27, 40]] });
    seedCustomer(db(), { phone: phone(3), orders: [[10, 300]], points: [[5, 90]] }); // fresh: not expiring this week
    let o = await getOverview(NOW_SEND);
    expect(insight(o, 'points_expiring_off')).toMatchObject({
      tone: 'warn',
      message: '₹100 of Beanies (2 customers) expire in the next 7 days.',
      cta: { label: 'Turn on Beanies reminders', tab: 'playbooks', playbook_key: 'points_expiring' },
    });
    seedPlaybooks(db(), { points_expiring: 'review' });
    o = await getOverview(NOW_SEND);
    expect(insight(o, 'points_expiring_off')).toBeUndefined();
  });

  it('customers who became lapsed, with no win-back running', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[35, 300]] }); // 5 days past the default 30-day threshold
    seedCustomer(db(), { phone: phone(2), orders: [[36, 300]] });
    seedCustomer(db(), { phone: phone(3), orders: [[80, 300]] }); // lapsed_2, lapsed long ago — not "this month"
    let o = await getOverview(NOW_SEND);
    expect(insight(o, 'lapsed_no_winback')).toMatchObject({ message: '2 customers became lapsed this month.', cta: { tab: 'playbooks', playbook_key: 'winback_1' } });
    seedPlaybooks(db(), { winback_2: 'review' });
    o = await getOverview(NOW_SEND);
    expect(insight(o, 'lapsed_no_winback')).toBeUndefined();
  });

  it('low consent coverage among active customers', async () => {
    for (let i = 0; i < 10; i++) seedCustomer(db(), { phone: phone(i), orders: [[3, 300]], optedIn: i < 2 });
    let o = await getOverview(NOW_SEND);
    expect(insight(o, 'low_consent_coverage')).toMatchObject({ message: 'Only 20% of your active customers can receive offers.', cta: { tab: 'audience' } });
    for (let i = 2; i < 5; i++) {
      db().tables.marketing_consent.push({ phone: phone(i), status: 'opted_in', source: 'profile' });
    }
    o = await getOverview(NOW_SEND);
    expect(insight(o, 'low_consent_coverage')).toBeUndefined();
  });

  it('product costs missing for most of the revenue — and the best free item once costs exist', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[10, 400]] });
    db().tables.menu_item_costs = [];
    let o = await getOverview(NOW_SEND);
    expect(insight(o, 'costs_missing')).toMatchObject({ message: 'Costs missing for items making 100% of revenue.', cta: { tab: 'costs' } });
    expect(insight(o, 'best_free_item')).toBeUndefined();

    db().tables.menu_item_costs = [{ variant_id: 'var-1', menu_item_id: 'item-1', cost_inr: 45 }];
    o = await getOverview(NOW_SEND);
    expect(insight(o, 'costs_missing')).toBeUndefined();
    expect(insight(o, 'best_free_item')).toMatchObject({ message: 'Best free-item offer: Cold Coffee (worth ₹200, costs ₹45).', tone: 'info' });
  });

  it('receipts not connected — until any message is delivered', async () => {
    let o = await getOverview(NOW_SEND);
    expect(insight(o, 'receipts_not_connected')).toMatchObject({ tone: 'warn', cta: null, message: expect.stringContaining('WHATSAPP_APP_SECRET') });
    seedRecipient({ status: 'delivered' });
    o = await getOverview(NOW_SEND);
    expect(insight(o, 'receipts_not_connected')).toBeUndefined();
  });
});

describe('the audience summary', () => {
  it('counts every identified customer per stage, and how many of them can be messaged', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[3, 300], [10, 300]], optedIn: true }); // active
    seedCustomer(db(), { phone: phone(2), orders: [[3, 300]], optedIn: false }); // new (1 order)
    seedCustomer(db(), { phone: phone(3), orders: [[40, 300]], optedIn: true }); // lapsed_1
    seedCustomer(db(), { phone: phone(4), orders: [[40, 300]], optedIn: true, optedOut: true }); // opted in but on the opt-out list
    seedCustomer(db(), { phone: phone(5), verified: false, orders: [] }); // no account, no orders: not a customer
    // A walk-in with a phone on an order and nothing else is identified too.
    db().tables.orders.push({ id: 'walk', created_at: daysAgo(3), total_inr: 150, status: 'completed', user_id: null, customer_user_id: null, customer_name: 'Ravi', customer_phone: '9812345678' });

    const a = await getAudienceSummary(NOW_SEND);

    expect(a.total_customers).toBe(5);
    const stage = (s: string) => a.stages.find((x) => x.stage === s)!;
    expect(a.stages.map((x) => x.stage)).toEqual(['new', 'active', 'at_risk', 'lapsed_1', 'lapsed_2', 'lapsed_3', 'lost', 'no_orders']);
    expect(stage('active')).toEqual({ stage: 'active', all: 1, opted_in: 1 });
    expect(stage('new')).toEqual({ stage: 'new', all: 2, opted_in: 0 });
    expect(stage('lapsed_1')).toEqual({ stage: 'lapsed_1', all: 2, opted_in: 1 });
  });

  it('summarises points: balance, ₹ outstanding and what expires within 7 days', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[10, 300]], points: [[28, 60], [5, 30]] });
    seedCustomer(db(), { phone: phone(2), orders: [[10, 300]], points: [[3, 45]] });
    seedCustomer(db(), { phone: phone(3), orders: [[10, 300]] });
    const a = await getAudienceSummary(NOW_SEND);
    expect(a.points).toEqual({ customers_with_balance: 2, outstanding_inr: 135, expiring_7d_inr: 60, expiring_7d_customers: 1 });
  });

  it('shows consent counts by status and source, and the last 30 days of events with masked phones', async () => {
    db().tables.marketing_consent = [
      { phone: phone(1), status: 'opted_in', source: 'profile' },
      { phone: phone(2), status: 'opted_in', source: 'profile' },
      { phone: phone(3), status: 'opted_in', source: 'whatsapp_keyword' },
      { phone: phone(4), status: 'opted_out', source: 'stop_keyword' },
    ];
    db().tables.marketing_consent_events = [
      { id: 'e0', phone: '+919876543210', action: 'opt_in', source: 'profile', created_at: daysAgo(1) },
      { id: 'e1', phone: '+919876543211', action: 'opt_out', source: 'stop_keyword', created_at: daysAgo(2) },
      { id: 'e2', phone: '+919876543212', action: 'opt_in', source: 'profile', created_at: daysAgo(40) }, // older than 30 days
    ];
    const a = await getAudienceSummary(NOW_SEND);
    expect(a.consent.opted_in).toBe(3);
    expect(a.consent.opted_out).toBe(1);
    expect(a.consent.by_source).toEqual([
      { source: 'profile', opted_in: 2, opted_out: 0 },
      { source: 'stop_keyword', opted_in: 0, opted_out: 1 },
      { source: 'whatsapp_keyword', opted_in: 1, opted_out: 0 },
    ]);
    expect(a.consent.recent_events).toEqual([
      { phone_masked: '+91 98••• ••210', action: 'opt_in', source: 'profile', created_at: daysAgo(1) },
      { phone_masked: '+91 98••• ••211', action: 'opt_out', source: 'stop_keyword', created_at: daysAgo(2) },
    ]);
    // No full number leaves the API.
    expect(JSON.stringify(a)).not.toContain('9876543210');
  });

  it('gives the opt-in link, or says the number is not set', async () => {
    let a = await getAudienceSummary(NOW_SEND);
    expect(a).toMatchObject({ whatsapp_business_number: '+919876500000', optin_url: 'https://wa.me/919876500000?text=START' });
    seedSettings(db(), { whatsapp_business_number: '' });
    a = await getAudienceSummary(NOW_SEND);
    expect(a).toMatchObject({ whatsapp_business_number: '', optin_url: null });
  });
});

describe('product costs', () => {
  function menu() {
    db().tables.menu_items = [
      { id: 'i1', name: 'Cold Coffee', category: 'Coffee', is_available: true, sort_order: 1 },
      { id: 'i2', name: 'Waffle', category: 'Waffles', is_available: true, sort_order: 1 },
      { id: 'i3', name: 'Retired Shake', category: 'Shakes', is_available: false, sort_order: 1 },
    ];
    db().tables.menu_item_variants = [
      { id: 'v1a', menu_item_id: 'i1', label: 'Regular', price_inr: 180, sort_order: 1 },
      { id: 'v1b', menu_item_id: 'i1', label: 'Large', price_inr: 240, sort_order: 2 },
      { id: 'v2', menu_item_id: 'i2', label: 'Regular', price_inr: 150, sort_order: 1 },
      { id: 'v3', menu_item_id: 'i3', label: 'Regular', price_inr: 100, sort_order: 1 },
    ];
    db().tables.menu_item_costs = [
      { variant_id: 'v1a', menu_item_id: 'i1', cost_inr: 45 },
      { variant_id: 'v1b', menu_item_id: 'i1', cost_inr: 80 },
      { variant_id: 'v3', menu_item_id: 'i3', cost_inr: 10 },
    ];
    // ₹360 of Regular cold coffee and ₹300 of waffle in the last 90 days: 360 of 660 has a real cost.
    db().tables.orders = [{ id: 'oa', created_at: daysAgo(10), total_inr: 660, status: 'completed' }];
    db().tables.order_items = [
      { id: 'l1', order_id: 'oa', variant_id: 'v1a', quantity: 2, line_total_inr: 360, voided: false },
      { id: 'l2', order_id: 'oa', variant_id: 'v2', quantity: 2, line_total_inr: 300, voided: false },
      { id: 'l3', order_id: 'oa', variant_id: 'v1b', quantity: 1, line_total_inr: 999, voided: true },
    ];
  }

  it('lists one row per variant with food cost %, margin and 90-day revenue', async () => {
    menu();
    const r = await listCosts(NOW_SEND);
    expect(r.default_food_cost_pct).toBe(35);
    // Menu order: by category, then the item's own order, then each item's sizes.
    expect(r.items.map((i) => i.variant_id)).toEqual(['v1a', 'v1b', 'v3', 'v2']);
    const byId = (id: string) => r.items.find((i) => i.variant_id === id)!;
    expect(r.items[0]).toEqual({
      variant_id: 'v1a', item_id: 'i1', category: 'Coffee', item_name: 'Cold Coffee', variant_label: 'Regular', price_inr: 180, cost_inr: 45,
      food_cost_pct: 25, margin_inr: 135, is_available: true, revenue_90d_inr: 360,
    });
    // No cost entered: nulls, not zeros.
    expect(byId('v2')).toMatchObject({ variant_id: 'v2', cost_inr: null, food_cost_pct: null, margin_inr: null, revenue_90d_inr: 300 });
    // A voided line was never sold.
    expect(byId('v1b').revenue_90d_inr).toBe(0);
    expect(byId('v3')).toMatchObject({ is_available: false });
  });

  it('coverage is the share of the last 90 days\' revenue resting on a real cost', async () => {
    menu();
    expect((await listCosts(NOW_SEND)).coverage_pct).toBeCloseTo(54.5, 1);
  });

  it('ranks free-item candidates by price ÷ cost among AVAILABLE, costed variants — never an uncosted one', async () => {
    menu();
    const r = await listCosts(NOW_SEND);
    // 180/45 = 4.0 beats 240/80 = 3.0; the waffle has no cost; the shake is unavailable.
    expect(r.free_item_ranking.map((c) => c.variant_id)).toEqual(['v1a', 'v1b']);
    expect(r.free_item_ranking[0]).toMatchObject({ item_name: 'Cold Coffee', price_inr: 180, cost_inr: 45, value_per_rupee: 4 });
  });

  it('never returns a cost in anything but the owner-only response shape', async () => {
    menu();
    const r = await listCosts(NOW_SEND);
    expect(Object.keys(r).sort()).toEqual(['coverage_pct', 'default_food_cost_pct', 'free_item_ranking', 'items']);
  });

  describe('saving', () => {
    beforeEach(menu);

    it('upserts costs and deletes on null — looking the item up itself', async () => {
      const r = await putCosts(
        [
          { variant_id: 'v2', cost_inr: 38.5 },
          { variant_id: 'v1a', cost_inr: 50 },
          { variant_id: 'v1b', cost_inr: null },
        ],
        'owner-1',
        NOW_SEND,
      );
      expect(r.ok).toBe(true);
      const costs = rowsOf(db(), 'menu_item_costs').sort((a, b) => String(a.variant_id).localeCompare(String(b.variant_id)));
      expect(costs.map((c) => [c.variant_id, c.menu_item_id, c.cost_inr])).toEqual([
        ['v1a', 'i1', 50],
        ['v2', 'i2', 38.5],
        ['v3', 'i3', 10],
      ]);
      expect(costs[1]).toMatchObject({ updated_by: 'owner-1' });
      // The response is the fresh listing.
      if (r.ok) expect(r.response.items.find((i) => i.variant_id === 'v2')!.cost_inr).toBe(38.5);
    });

    it('rejects an unknown variant id — and applies NOTHING from the request', async () => {
      const before = JSON.stringify(rowsOf(db(), 'menu_item_costs'));
      const r = await putCosts([{ variant_id: 'v2', cost_inr: 10 }, { variant_id: 'ghost', cost_inr: 5 }], 'owner-1');
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('ghost') });
      expect(JSON.stringify(rowsOf(db(), 'menu_item_costs'))).toBe(before);
    });

    it('an empty list is a no-op', async () => {
      expect((await putCosts([], 'owner-1')).ok).toBe(true);
    });
  });
});
