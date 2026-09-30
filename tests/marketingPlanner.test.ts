import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb, Row } from './helpers/marketingDb';
import {
  DAY,
  NOW_PLAN,
  daysAgo,
  newDb,
  rowsOf,
  seedCostedMenu,
  seedCustomer,
  seedLoyalty,
  seedPlaybooks,
  seedSettings,
} from './helpers/marketingWorld';

// The nightly planner (spec §6 "Planner"): measure → learn → tidy → (kill switch) → plan.
// Runs the REAL runDailyPlan over an in-memory database.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, send: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/notifications/adapters', () => ({ whatsappAdapter: { send: h.send } }));

const { runDailyPlan, learnFromClosedCampaigns } = await import('@/lib/marketing/server/planner');
const { seededShuffle } = await import('@/lib/marketing/server/campaigns');

const db = () => h.db;
const phone = (n: number) => `+9198765${String(20000 + n)}`;
const campaigns = (where: (r: Row) => boolean = () => true) => rowsOf(db(), 'marketing_campaigns', where);
const recipients = (where: (r: Row) => boolean = () => true) => rowsOf(db(), 'marketing_recipients', where);

/** n opted-in customers who last ordered `lastOrderDaysAgo` days before the planner runs. */
function lapsed(n: number, lastOrderDaysAgo = 35, extra: Partial<Parameters<typeof seedCustomer>[1]> = {}, start = 0) {
  for (let i = 0; i < n; i++) {
    seedCustomer(db(), { phone: phone(start + i), name: `Cust${start + i} Rao`, optedIn: true, orders: [[lastOrderDaysAgo, 400]], ...extra }, NOW_PLAN);
  }
}

beforeEach(() => {
  h.db = newDb({ startMs: NOW_PLAN.getTime() });
  seedSettings(db(), { holdout_pct: 10, min_margin_pct: 30 });
  seedPlaybooks(db(), { winback_1: 'review' });
  seedLoyalty(db());
  seedCostedMenu(db());
  h.send.mockReset();
  h.send.mockResolvedValue({ ok: true, providerRef: 'wamid.OK', error: '' });
  process.env.WHATSAPP_TOKEN = 'token';
  process.env.WHATSAPP_PHONE_ID = 'phone-id';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('planning a playbook campaign (Review)', () => {
  it('creates one pending_approval campaign with a frozen offer, template, projection and holdout', async () => {
    lapsed(20);

    const result = await runDailyPlan(NOW_PLAN);

    expect(result).toMatchObject({ enabled: true, planned: [{ key: 'winback_1', status: 'pending_approval', eligible: 20 }], expired: 0 });
    const [c] = campaigns();
    expect(c).toMatchObject({
      kind: 'playbook',
      playbook_key: 'winback_1',
      status: 'pending_approval',
      planned_for: '2026-10-05',
      priority: 4,
      treated_count: 18,
      holdout_count: 2,
      guardrail_flags: [],
    });
    expect(c).not.toHaveProperty('approved_at');
    expect(c.name).toBe('Win-back · stage 1 (we miss you) · 2026-10-05');
    // Frozen: the playbook's own offer and template, and the params it was planned with.
    expect(c.offer).toEqual({ type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 });
    expect((c.template as Row).name).toBe('hioc_winback_1');
    expect((c.audience as Row).params).toMatchObject({ gap_multiplier: 2.5, default_days: 30 });
    // The projection is the spec §1.6 one: 18 treated × ₹1.02, A = ₹400, discount 10% = ₹40.
    const p = c.projection as Row;
    expect(p).toMatchObject({ eligible: 20, holdout: 2, treated: 18, message_cost_inr: 1.02, basket_inr: 400, discount_inr: 40, offer_cost_inr: 40 });
    expect(p.message_spend_inr).toBeCloseTo(18 * 1.02);
    expect(p.expected_profit_inr as number).toBeGreaterThan(0);
    expect(rowsOf(db(), 'marketing_playbooks', (r) => r.key === 'winback_1')[0].last_planned_at).toBe(NOW_PLAN.toISOString());
  });

  it('draws the holdout: 10% of contacts held out, everyone else pending with a click token and frozen variables', async () => {
    lapsed(20);
    await runDailyPlan(NOW_PLAN);

    const all = recipients();
    expect(all).toHaveLength(20);
    expect(new Set(all.map((r) => r.phone)).size).toBe(20);
    const holdout = all.filter((r) => r.arm === 'holdout');
    const treated = all.filter((r) => r.arm === 'treatment');
    expect(holdout).toHaveLength(2);
    expect(treated).toHaveLength(18);
    for (const r of holdout) expect(r).toMatchObject({ status: 'holdout', click_token: null });
    for (const r of treated) {
      expect(r.status).toBe('pending');
      expect(r.click_token).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(r.vars).toMatchObject({ first_name: expect.stringMatching(/^Cust/), offer_text: '10% off (up to ₹60) on orders above ₹150', days_since_visit: '35' });
    }
    expect(new Set(treated.map((r) => r.click_token)).size).toBe(18);
  });

  it('a holdout of 0% holds nobody out', async () => {
    seedSettings(db(), { holdout_pct: 0 });
    lapsed(5);
    await runDailyPlan(NOW_PLAN);
    expect(recipients((r) => r.arm === 'holdout')).toHaveLength(0);
    expect(campaigns()[0]).toMatchObject({ treated_count: 5, holdout_count: 0 });
  });

  it('never plans a playbook that is off', async () => {
    seedPlaybooks(db(), {});
    lapsed(5);
    expect(await runDailyPlan(NOW_PLAN)).toMatchObject({ enabled: true, planned: [] });
    expect(campaigns()).toEqual([]);
  });

  it('plans nothing when nobody qualifies', async () => {
    lapsed(3, 5); // ordered 5 days ago — active, not lapsed
    expect(await runDailyPlan(NOW_PLAN)).toMatchObject({ planned: [] });
    expect(campaigns()).toEqual([]);
  });
});

describe('who is left out', () => {
  it('skips customers who have not opted in, staff, and anyone on the opt-out list', async () => {
    lapsed(3);
    seedCustomer(db(), { phone: phone(50), orders: [[35, 400]], optedIn: false }, NOW_PLAN); // never opted in
    seedCustomer(db(), { phone: phone(51), orders: [[35, 400]], optedIn: true, role: 'staff' }, NOW_PLAN);
    seedCustomer(db(), { phone: phone(52), orders: [[35, 400]], optedIn: true, optedOut: true }, NOW_PLAN);

    await runDailyPlan(NOW_PLAN);

    const phones = recipients().map((r) => r.phone);
    expect(phones.sort()).toEqual([phone(0), phone(1), phone(2)]);
  });

  it('skips a phone messaged recently (too_soon) and one already in flight in another campaign', async () => {
    lapsed(3);
    seedCustomer(db(), { phone: phone(60), orders: [[35, 400]], optedIn: true }, NOW_PLAN);
    seedCustomer(db(), { phone: phone(61), orders: [[35, 400]], optedIn: true }, NOW_PLAN);
    db().tables.marketing_campaigns = [
      { id: 'old-1', kind: 'manual', playbook_key: null, status: 'completed', created_at: daysAgo(3, NOW_PLAN) },
      { id: 'old-2', kind: 'manual', playbook_key: null, status: 'pending_approval', created_at: daysAgo(0.5, NOW_PLAN) },
    ];
    db().tables.marketing_recipients = [
      { id: 'h1', campaign_id: 'old-1', phone: phone(60), arm: 'treatment', status: 'delivered', created_at: daysAgo(3, NOW_PLAN), sent_at: daysAgo(3, NOW_PLAN) },
      { id: 'h2', campaign_id: 'old-2', phone: phone(61), arm: 'treatment', status: 'pending', created_at: daysAgo(0.5, NOW_PLAN) },
    ];

    await runDailyPlan(NOW_PLAN);

    const planned = campaigns((c) => c.kind === 'playbook');
    expect(planned).toHaveLength(1);
    expect(recipients((r) => r.campaign_id === planned[0].id).map((r) => r.phone).sort()).toEqual([phone(0), phone(1), phone(2)]);
  });

  it('gives a customer to the HIGHEST-priority playbook only, once a day', async () => {
    seedPlaybooks(db(), { winback_1: 'review', points_expiring: 'review' });
    // Lapsed (winback_1) AND holding points that expire in 2 days (points_expiring, priority 1).
    seedCustomer(db(), { phone: phone(1), orders: [[35, 400]], optedIn: true, points: [[28, 100]] }, NOW_PLAN);
    // Lapsed only.
    seedCustomer(db(), { phone: phone(2), orders: [[35, 400]], optedIn: true }, NOW_PLAN);

    const result = await runDailyPlan(NOW_PLAN);

    expect(result.planned.map((p) => p.key).sort()).toEqual(['points_expiring', 'winback_1']);
    const byKey = (key: string) => campaigns((c) => c.playbook_key === key)[0].id;
    expect(recipients((r) => r.campaign_id === byKey('points_expiring')).map((r) => r.phone)).toEqual([phone(1)]);
    expect(recipients((r) => r.campaign_id === byKey('winback_1')).map((r) => r.phone)).toEqual([phone(2)]);
  });

  it('a win-back stage is once per lapse: not again after it was already sent since the last order', async () => {
    lapsed(2);
    db().tables.marketing_campaigns = [{ id: 'prev', kind: 'playbook', playbook_key: 'winback_1', status: 'completed', created_at: daysAgo(10, NOW_PLAN) }];
    db().tables.marketing_recipients = [
      { id: 'p1', campaign_id: 'prev', phone: phone(0), arm: 'treatment', status: 'delivered', created_at: daysAgo(10, NOW_PLAN), sent_at: daysAgo(10, NOW_PLAN) },
    ];
    await runDailyPlan(NOW_PLAN);
    const planned = campaigns((c) => c.id !== 'prev');
    expect(recipients((r) => r.campaign_id === planned[0].id).map((r) => r.phone)).toEqual([phone(1)]);
  });
});

describe('Auto vs Review, and the guardrails', () => {
  it('Auto with every guardrail passing goes straight to approved, recipients queued', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    lapsed(20);

    const result = await runDailyPlan(NOW_PLAN);

    expect(result.planned).toEqual([{ key: 'winback_1', status: 'approved', eligible: 20 }]);
    const [c] = campaigns();
    expect(c).toMatchObject({ status: 'approved', guardrail_flags: [], approved_at: NOW_PLAN.toISOString() });
    expect(recipients((r) => r.arm === 'treatment').every((r) => r.status === 'queued')).toBe(true);
    // Holdout people are never queued.
    expect(recipients((r) => r.arm === 'holdout').every((r) => r.status === 'holdout')).toBe(true);
  });

  it('an Auto campaign is only marked approved AFTER all its recipients exist (the sender must never see it half-made)', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    lapsed(20);
    let statusWhileInserting: unknown = null;
    const realFrom = h.db.client.from.bind(h.db.client);
    h.db.client.from = (table: string) => {
      const chain = realFrom(table) as { insert: (rows: unknown) => unknown };
      if (table === 'marketing_recipients') {
        const insert = chain.insert.bind(chain);
        chain.insert = (rows: unknown) => {
          statusWhileInserting ??= db().tables.marketing_campaigns[0]?.status;
          return insert(rows);
        };
      }
      return chain;
    };

    await runDailyPlan(NOW_PLAN);

    // While its recipients were being written the campaign was NOT approved (so the sender's
    // "close any approved campaign with nothing in flight" sweep could not close it early)…
    expect(statusWhileInserting).toBe('pending_approval');
    // …and afterwards it is.
    expect(campaigns()[0]).toMatchObject({ status: 'approved', approved_at: NOW_PLAN.toISOString() });
    const log = db().log;
    expect(log.indexOf('insert marketing_campaigns')).toBeLessThan(log.indexOf('insert marketing_recipients'));
    expect(log.indexOf('insert marketing_recipients')).toBeLessThan(log.lastIndexOf('update marketing_campaigns'));
  });

  it('if the final approve cannot be written the campaign waits in Approvals — never half-sent', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    lapsed(20);
    // (The first update is the expiry sweep; the second is the final approve.)
    db().failNext('update marketing_campaigns', undefined, 1);
    const result = await runDailyPlan(NOW_PLAN);
    expect(result.planned).toEqual([{ key: 'winback_1', status: 'pending_approval', eligible: 20 }]);
    expect(campaigns()[0].status).toBe('pending_approval');
  });

  it('Auto with a guardrail flag falls back to Approvals (missing product costs)', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    // No costs entered, so nothing in the last 90 days rests on a real cost.
    db().tables.menu_item_costs = [];
    lapsed(20);

    const result = await runDailyPlan(NOW_PLAN);

    expect(result.planned).toEqual([{ key: 'winback_1', status: 'pending_approval', eligible: 20 }]);
    expect(campaigns()[0].guardrail_flags).toContain('missing_costs');
    expect(recipients((r) => r.arm === 'treatment').every((r) => r.status === 'pending')).toBe(true);
  });

  it('Auto with no template mapped falls back to Approvals', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' }, { winback_1: { template: { name: '', lang: 'en', vars: ['first_name'], url_button: false, body_preview: '' } } });
    lapsed(10);
    await runDailyPlan(NOW_PLAN);
    expect(campaigns()[0]).toMatchObject({ status: 'pending_approval' });
    expect(campaigns()[0].guardrail_flags).toContain('no_template');
  });

  it('Auto that would lose money falls back to Approvals (negative_profit)', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    seedSettings(db(), { message_cost_inr: 100, monthly_budget_inr: 1_000_000 });
    lapsed(10);
    await runDailyPlan(NOW_PLAN);
    expect(campaigns()[0]).toMatchObject({ status: 'pending_approval' });
    expect(campaigns()[0].guardrail_flags).toContain('negative_profit');
  });

  it('Auto that would overspend the month falls back to Approvals (over_budget)', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    seedSettings(db(), { monthly_budget_inr: 5 });
    lapsed(20);
    await runDailyPlan(NOW_PLAN);
    expect(campaigns()[0]).toMatchObject({ status: 'pending_approval' });
    expect(campaigns()[0].guardrail_flags).toContain('over_budget');
  });

  it('budget already promised to queued messages counts against a new campaign', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    seedSettings(db(), { monthly_budget_inr: 30 });
    // 20 approved-and-queued messages elsewhere = ₹20.40 already committed of ₹30.
    db().tables.marketing_recipients = Array.from({ length: 20 }, (_, i) => ({
      id: `q${i}`, campaign_id: 'other', phone: phone(900 + i), arm: 'treatment', status: 'queued', created_at: daysAgo(0, NOW_PLAN),
    }));
    lapsed(15); // ₹13.77 of messages > the ₹9.60 left
    await runDailyPlan(NOW_PLAN);
    expect(campaigns((c) => c.kind === 'playbook')[0].guardrail_flags).toContain('over_budget');
  });

  it('resolves a free-item offer to the best-value costed variant and freezes it', async () => {
    seedPlaybooks(db(), { winback_2: 'review' });
    lapsed(10, 65); // stage 2: 60 ≤ days < 90
    await runDailyPlan(NOW_PLAN);
    const [c] = campaigns();
    expect(c.playbook_key).toBe('winback_2');
    expect(c.offer).toMatchObject({
      type: 'free_item', item_id: 'item-1', variant_id: 'var-1', item_name: 'Cold Coffee', variant_label: 'Regular', price_inr: 200, cost_inr: 60,
    });
    // A free item costs its COGS (₹60), not its price, and takes nothing off the bill.
    expect(c.projection).toMatchObject({ offer_cost_inr: 60, discount_inr: 0 });
    expect(c.guardrail_flags).toEqual([]);
    // (The holdout draw is random per campaign: read a TREATED recipient, whose message is frozen.)
    expect(recipients((r) => r.arm === 'treatment')[0].vars).toMatchObject({ offer_text: 'a FREE Cold Coffee with any order above ₹200' });
  });

  it('a free-item campaign with nothing to give is flagged no_free_item and never auto-sends', async () => {
    seedPlaybooks(db(), { winback_2: 'auto' });
    db().tables.menu_item_costs = [];
    lapsed(10, 65);
    await runDailyPlan(NOW_PLAN);
    expect(campaigns()[0]).toMatchObject({ status: 'pending_approval' });
    expect(campaigns()[0].guardrail_flags).toEqual(expect.arrayContaining(['no_free_item', 'missing_costs']));
  });

  it('prices a points reminder as the customer\'s own points, with no offer', async () => {
    seedPlaybooks(db(), { points_expiring: 'review' });
    seedCustomer(db(), { phone: phone(1), orders: [[10, 400]], optedIn: true, points: [[28, 100]] }, NOW_PLAN);
    await runDailyPlan(NOW_PLAN);
    const [c] = campaigns();
    expect(c.offer).toEqual({ type: 'none' });
    // ₹100 of points, capped at 50% of a ₹400 basket = ₹200: the full ₹100.
    expect(c.projection).toMatchObject({ discount_inr: 100, offer_cost_inr: 100 });
    expect(recipients()[0].vars).toMatchObject({ expiring_points: '100', expiring_value_inr: '100', expiry_date: '7 Oct', first_name: 'Asha' });
  });
});

describe('idempotence', () => {
  it('a re-run the same day plans nothing more and duplicates no one', async () => {
    lapsed(20);
    await runDailyPlan(NOW_PLAN);
    const before = { campaigns: campaigns().length, recipients: recipients().length };

    const second = await runDailyPlan(NOW_PLAN);

    expect(second.planned).toEqual([]);
    expect({ campaigns: campaigns().length, recipients: recipients().length }).toEqual(before);
  });

  it('a unique violation on (playbook, day) is "already planned today": skipped, not an error, no recipients written', async () => {
    lapsed(5);
    // The first run made the campaign but died before its recipients landed.
    db().tables.marketing_campaigns = [{ id: 'existing', kind: 'playbook', playbook_key: 'winback_1', planned_for: '2026-10-05', status: 'pending_approval', created_at: daysAgo(0, NOW_PLAN) }];
    const result = await runDailyPlan(NOW_PLAN);
    expect(result.planned).toEqual([]);
    expect(campaigns()).toHaveLength(1);
    expect(recipients()).toEqual([]);
  });

  it('a new day is a new campaign', async () => {
    lapsed(5);
    await runDailyPlan(NOW_PLAN);
    // Tomorrow: the earlier campaign still awaits approval, so its people are in flight and no new one is made.
    const tomorrow = new Date(NOW_PLAN.getTime() + DAY);
    expect((await runDailyPlan(tomorrow)).planned).toEqual([]);
    lapsed(3, 35, {}, 100);
    const third = await runDailyPlan(tomorrow);
    expect(third.planned).toEqual([{ key: 'winback_1', status: 'pending_approval', eligible: 3 }]);
    expect(campaigns()).toHaveLength(2);
  });

  it('removes a half-made campaign if its recipients cannot be written, so tomorrow can retry', async () => {
    lapsed(5);
    db().failNext('insert marketing_recipients');
    const result = await runDailyPlan(NOW_PLAN);
    expect(result.planned).toEqual([]);
    expect(campaigns()).toEqual([]);
    // The retry works.
    expect((await runDailyPlan(NOW_PLAN)).planned).toHaveLength(1);
  });
});

describe('with the kill switch OFF', () => {
  beforeEach(() => seedSettings(db(), { enabled: false }));

  it('plans nothing and reports enabled:false', async () => {
    lapsed(10);
    expect(await runDailyPlan(NOW_PLAN)).toEqual({ enabled: false, attributed: 0, planned: [], expired: 0 });
    expect(campaigns()).toEqual([]);
  });

  it('still attributes returns and expires stale approvals — bookkeeping is not sending', async () => {
    db().tables.marketing_campaigns = [
      { id: 'stale', kind: 'manual', status: 'pending_approval', created_at: daysAgo(3, NOW_PLAN) },
      { id: 'fresh', kind: 'manual', status: 'pending_approval', created_at: daysAgo(1, NOW_PLAN) },
    ];
    db().tables.marketing_recipients = [
      { id: 's1', campaign_id: 'stale', phone: phone(70), arm: 'treatment', status: 'pending', created_at: daysAgo(3, NOW_PLAN) },
      { id: 'c1', campaign_id: 'fresh', phone: phone(71), arm: 'treatment', status: 'sent', sent_at: daysAgo(2, NOW_PLAN), reference_at: daysAgo(2, NOW_PLAN), created_at: daysAgo(2, NOW_PLAN), coupon_id: null },
    ];
    db().tables.orders = [
      { id: 'ret-1', created_at: daysAgo(1, NOW_PLAN), total_inr: 320, status: 'completed', user_id: null, customer_user_id: null, customer_phone: phone(71) },
    ];

    const result = await runDailyPlan(NOW_PLAN);

    expect(result).toEqual({ enabled: false, attributed: 1, planned: [], expired: 1 });
    expect(campaigns((c) => c.id === 'stale')[0].status).toBe('expired');
    expect(campaigns((c) => c.id === 'fresh')[0].status).toBe('pending_approval');
    expect(recipients((r) => r.id === 's1')[0].status).toBe('cancelled');
    expect(recipients((r) => r.id === 'c1')[0]).toMatchObject({ converted_order_id: 'ret-1', conversion_revenue_inr: 320, attributed_via: 'order' });
  });

  it('with no settings row at all it is also just bookkeeping', async () => {
    db().tables.marketing_settings = [];
    lapsed(5);
    expect(await runDailyPlan(NOW_PLAN)).toMatchObject({ enabled: false, planned: [] });
    expect(campaigns()).toEqual([]);
  });
});

describe('expiring stale approvals', () => {
  it('expires only pending_approval campaigns older than two days, cancelling their unsent recipients', async () => {
    db().tables.marketing_campaigns = [
      { id: 'a', kind: 'manual', status: 'pending_approval', created_at: daysAgo(2.5, NOW_PLAN) },
      { id: 'b', kind: 'manual', status: 'pending_approval', created_at: daysAgo(1.9, NOW_PLAN) },
      { id: 'c', kind: 'manual', status: 'draft', created_at: daysAgo(30, NOW_PLAN) },
      { id: 'd', kind: 'manual', status: 'approved', created_at: daysAgo(30, NOW_PLAN) },
    ];
    db().tables.marketing_recipients = [
      { id: 'ra', campaign_id: 'a', phone: phone(1), status: 'pending', arm: 'treatment', created_at: daysAgo(2.5, NOW_PLAN) },
      { id: 'rh', campaign_id: 'a', phone: phone(2), status: 'holdout', arm: 'holdout', created_at: daysAgo(2.5, NOW_PLAN) },
      { id: 'rb', campaign_id: 'b', phone: phone(3), status: 'pending', arm: 'treatment', created_at: daysAgo(1.9, NOW_PLAN) },
    ];
    const result = await runDailyPlan(NOW_PLAN);
    expect(result.expired).toBe(1);
    expect(campaigns().map((c) => [c.id, c.status])).toEqual([['a', 'expired'], ['b', 'pending_approval'], ['c', 'draft'], ['d', 'approved']]);
    expect(recipients((r) => r.id === 'ra')[0].status).toBe('cancelled');
    expect(recipients((r) => r.id === 'rh')[0].status).toBe('holdout');
    expect(recipients((r) => r.id === 'rb')[0].status).toBe('pending');
  });

  it('a holdout of an expired campaign does not count as "handled": the customer can be offered the stage later', async () => {
    lapsed(1);
    db().tables.marketing_campaigns = [{ id: 'dead', kind: 'playbook', playbook_key: 'winback_1', status: 'expired', created_at: daysAgo(4, NOW_PLAN) }];
    db().tables.marketing_recipients = [{ id: 'hh', campaign_id: 'dead', phone: phone(0), arm: 'holdout', status: 'holdout', created_at: daysAgo(4, NOW_PLAN) }];
    expect((await runDailyPlan(NOW_PLAN)).planned).toEqual([{ key: 'winback_1', status: 'pending_approval', eligible: 1 }]);
  });
});

describe('the send fallback', () => {
  it('nudges the sender once when the run happens inside the send window (no pg_cron)', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    // 09:45 IST is inside a 9–20 window.
    seedSettings(db(), { send_window_start_hour: 9, send_window_end_hour: 20 });
    lapsed(20);

    await runDailyPlan(NOW_PLAN);

    expect(h.send).toHaveBeenCalled();
    expect(recipients((r) => r.status === 'sent').length).toBeGreaterThan(0);
  });

  it('does not touch the sender outside the window', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    lapsed(20);
    await runDailyPlan(NOW_PLAN); // default window opens at 11:00
    expect(h.send).not.toHaveBeenCalled();
    expect(recipients((r) => r.status === 'queued').length).toBeGreaterThan(0);
  });

  it('a sender failure never fails the planning run', async () => {
    seedPlaybooks(db(), { winback_1: 'auto' });
    seedSettings(db(), { send_window_start_hour: 9, send_window_end_hour: 20 });
    lapsed(5);
    h.send.mockRejectedValue(new Error('boom'));
    await expect(runDailyPlan(NOW_PLAN)).resolves.toMatchObject({ planned: [{ status: 'approved' }] });
  });
});

describe('migration not applied', () => {
  it('is a no-op with migration_missing, not an error', async () => {
    db().setMissing('marketing_settings', true);
    expect(await runDailyPlan(NOW_PLAN)).toEqual({ enabled: false, migration_missing: true, attributed: 0, planned: [], expired: 0 });
  });

  it('is detected on a later table too', async () => {
    db().setMissing('marketing_recipients', true);
    lapsed(3);
    expect(await runDailyPlan(NOW_PLAN)).toMatchObject({ enabled: false, migration_missing: true });
  });
});

describe('learning from finished campaigns', () => {
  const settings = { attribution_days: 7 };

  function finished(over: Row = {}, recipientRows: Row[] = []) {
    db().tables.marketing_campaigns = [
      {
        id: 'done', kind: 'playbook', playbook_key: 'winback_1', status: 'completed', started_at: daysAgo(12, NOW_PLAN), created_at: daysAgo(12, NOW_PLAN),
        projection: { treated: 40, conversion_rate: 0.12 },
        ...over,
      },
    ];
    db().tables.marketing_recipients = recipientRows;
  }
  const sentRow = (i: number, converted: boolean, sentDaysAgo = 12): Row => ({
    id: `l${i}`, campaign_id: 'done', phone: phone(300 + i), arm: 'treatment', status: i % 2 ? 'delivered' : 'sent',
    sent_at: daysAgo(sentDaysAgo, NOW_PLAN), reference_at: daysAgo(sentDaysAgo, NOW_PLAN), created_at: daysAgo(sentDaysAgo, NOW_PLAN),
    converted_at: converted ? daysAgo(sentDaysAgo - 1, NOW_PLAN) : null,
  });

  it('adds the treated-delivered and converted counts to the playbook, once, and stamps the campaign', async () => {
    finished({}, [...Array.from({ length: 10 }, (_, i) => sentRow(i, i < 3)), { ...sentRow(99, false), status: 'failed', sent_at: null }]);

    const first = await learnFromClosedCampaigns(db().client as never, NOW_PLAN, settings);
    expect(first.campaigns).toBe(1);
    const pb = () => rowsOf(db(), 'marketing_playbooks', (r) => r.key === 'winback_1')[0];
    // The failed recipient was never delivered, so it is not in the denominator.
    expect(pb()).toMatchObject({ observed_treated: 10, observed_conversions: 3 });
    expect((campaigns()[0].projection as Row).learned_at).toBe(NOW_PLAN.toISOString());
    // The rest of the stored projection is kept.
    expect((campaigns()[0].projection as Row).treated).toBe(40);

    // Running again — the same night, or every night after — never counts it twice.
    await learnFromClosedCampaigns(db().client as never, new Date(NOW_PLAN.getTime() + DAY), settings);
    expect(pb()).toMatchObject({ observed_treated: 10, observed_conversions: 3 });
  });

  it('waits until the attribution window has closed (last send + attribution_days + 1)', async () => {
    finished({}, [sentRow(1, false, 8)]); // sent 8 days ago; window closes at 7 + 1 = 8 → not yet a full day past 7
    // 8 days after sending == exactly the close; one hour before is still open.
    const early = new Date(NOW_PLAN.getTime() - 60 * 60 * 1000);
    expect((await learnFromClosedCampaigns(db().client as never, early, settings)).campaigns).toBe(0);
    expect((await learnFromClosedCampaigns(db().client as never, NOW_PLAN, settings)).campaigns).toBe(1);
  });

  it('does not learn from a campaign that is still sending or has recipients in flight', async () => {
    finished({ status: 'sending' }, [sentRow(1, true)]);
    expect((await learnFromClosedCampaigns(db().client as never, NOW_PLAN, settings)).campaigns).toBe(0);

    finished({}, [sentRow(1, true), { ...sentRow(2, false), status: 'queued', sent_at: null }]);
    expect((await learnFromClosedCampaigns(db().client as never, NOW_PLAN, settings)).campaigns).toBe(0);
  });

  it('does not learn from a campaign that never started, or a manual one (no playbook to teach)', async () => {
    finished({ started_at: null }, [sentRow(1, true)]);
    expect((await learnFromClosedCampaigns(db().client as never, NOW_PLAN, settings)).campaigns).toBe(0);
    finished({ kind: 'manual', playbook_key: null }, [sentRow(1, true)]);
    expect((await learnFromClosedCampaigns(db().client as never, NOW_PLAN, settings)).campaigns).toBe(0);
  });

  it('a cancelled campaign that did send is still evidence', async () => {
    finished({ status: 'cancelled' }, [sentRow(1, true)]);
    expect((await learnFromClosedCampaigns(db().client as never, NOW_PLAN, settings)).campaigns).toBe(1);
  });

  it('holdout recipients are not part of what a message achieved', async () => {
    finished({}, [sentRow(1, true), { ...sentRow(2, true), arm: 'holdout', status: 'holdout' }]);
    await learnFromClosedCampaigns(db().client as never, NOW_PLAN, settings);
    expect(rowsOf(db(), 'marketing_playbooks', (r) => r.key === 'winback_1')[0]).toMatchObject({ observed_treated: 1, observed_conversions: 1 });
  });

  it('the next projection uses the learned rate: (prior × 50 + conversions) ÷ (50 + treated)', async () => {
    finished({}, Array.from({ length: 50 }, (_, i) => sentRow(i, i < 25)));
    lapsed(10);
    await runDailyPlan(NOW_PLAN);
    const fresh = campaigns((c) => c.id !== 'done')[0];
    // prior 12% of 50 = 6; observed 25 of 50 → (6 + 25) / (50 + 50) = 0.31
    expect((fresh.projection as Row).conversion_rate).toBeCloseTo(0.31, 5);
  });
});

describe('the deterministic holdout shuffle', () => {
  it('is stable for one seed and different for another', () => {
    const phones = Array.from({ length: 30 }, (_, i) => `p${i}`);
    expect(seededShuffle(phones, 'campaign-a')).toEqual(seededShuffle(phones, 'campaign-a'));
    expect(seededShuffle(phones, 'campaign-a')).not.toEqual(seededShuffle(phones, 'campaign-b'));
  });

  it('is a permutation and does not mutate its input', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = seededShuffle(input, 'x');
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(input).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
