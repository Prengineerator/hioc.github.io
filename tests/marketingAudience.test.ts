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

// buildContacts (spec §1.1): joins consent, accounts, orders, points and send history into
// ContactStats. Order matching follows orderMatchFilter: user id, counter-linked user id,
// or phone in either stored spelling.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));

const { buildContacts, messageableContacts, winbackBundle } = await import('@/lib/marketing/server/audience');

const db = () => h.db;
const phone = (n: number) => `+9198765${String(50000 + n)}`;
const find = async (p: string) => (await buildContacts(NOW_SEND)).contacts.find((c) => c.stats.phone === p);

beforeEach(() => {
  h.db = newDb();
  seedSettings(db());
  seedPlaybooks(db());
  seedLoyalty(db());
  seedCostedMenu(db());
});

describe('who is a contact', () => {
  it('every identified customer: a verified account, an order phone, or a consent row', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[3, 300]], optedIn: true });
    db().tables.orders.push({ id: 'walk', created_at: daysAgo(4), total_inr: 150, status: 'completed', user_id: null, customer_user_id: null, customer_name: 'Ravi', customer_phone: '9812345678' });
    db().tables.marketing_consent.push({ phone: phone(2), status: 'opted_in', source: 'whatsapp_keyword' });
    db().tables.whatsapp_opt_outs = [{ phone: phone(3), source: 'stop_keyword' }];

    const { contacts } = await buildContacts(NOW_SEND);
    expect(contacts.map((c) => c.stats.phone).sort()).toEqual([phone(1), phone(2), phone(3), '+919812345678'].sort());

    const byPhone = new Map(contacts.map((c) => [c.stats.phone, c.stats]));
    expect(byPhone.get(phone(1))).toMatchObject({ consent_opted_in: true, opt_out_listed: false, order_count: 1 });
    // A walk-in with only an order phone: identified, not consented.
    expect(byPhone.get('+919812345678')).toMatchObject({ consent_opted_in: false, order_count: 1, user_id: null, first_name: 'Ravi' });
    // Consent with nothing else: a contact with no orders.
    expect(byPhone.get(phone(2))).toMatchObject({ consent_opted_in: true, stage: 'no_orders', order_count: 0 });
    // An opt-out for a phone with no other trace is still a (blocked) person, never "unknown".
    expect(byPhone.get(phone(3))).toMatchObject({ opt_out_listed: true, consent_opted_in: false });
  });

  it('messageableContacts keeps only opted-in phones that are not on the opt-out list', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[3, 300]], optedIn: true });
    seedCustomer(db(), { phone: phone(2), orders: [[3, 300]], optedIn: true, optedOut: true });
    seedCustomer(db(), { phone: phone(3), orders: [[3, 300]], optedIn: false });
    const snap = await buildContacts(NOW_SEND);
    expect(messageableContacts(snap).map((c) => c.stats.phone)).toEqual([phone(1)]);
  });

  it('an opt-out written in a different spelling still blocks the phone', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[3, 300]], optedIn: true });
    db().tables.whatsapp_opt_outs = [{ phone: phone(1).slice(1) }];
    expect((await find(phone(1)))!.stats.opt_out_listed).toBe(true);
  });

  it('carries the profile role, so staff are recognisable', async () => {
    seedCustomer(db(), { phone: phone(1), role: 'staff', orders: [[3, 300]], optedIn: true });
    expect((await find(phone(1)))!.stats.role).toBe('staff');
  });

  it('an unverified account is not a contact by itself', async () => {
    seedCustomer(db(), { phone: phone(1), verified: false, orders: [] });
    (db().tables.profiles ??= []).push({ id: 'unv', phone: phone(9), phone_verified: false, role: 'customer' });
    expect(await find(phone(9))).toBeUndefined();
  });
});

describe('order matching', () => {
  it('counts an order once even when it matches by user AND by phone', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[3, 300], [20, 200]] });
    expect((await find(phone(1)))!.stats).toMatchObject({ order_count: 2, total_spend_inr: 500, aov_inr: 250 });
  });

  it('matches orders by the counter-linked user id', async () => {
    seedCustomer(db(), { phone: phone(1), userId: 'u-linked', orders: [] });
    (db().tables.orders ??= []).push({ id: 'counter', created_at: daysAgo(6), total_inr: 240, status: 'completed', user_id: null, customer_user_id: 'u-linked', customer_name: 'x', customer_phone: '' });
    expect((await find(phone(1)))!.stats).toMatchObject({ order_count: 1, total_spend_inr: 240 });
  });

  it('matches orders by phone in the bare ten-digit spelling older rows keep', async () => {
    seedCustomer(db(), { phone: phone(1), userId: 'u1', orders: [] });
    (db().tables.orders ??= []).push({ id: 'old', created_at: daysAgo(6), total_inr: 100, status: 'completed', user_id: null, customer_user_id: null, customer_name: 'x', customer_phone: phone(1).slice(3) });
    expect((await find(phone(1)))!.stats.order_count).toBe(1);
  });

  it('ignores cancelled and rejected orders, and orders older than 365 days', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[3, 300]] });
    db().tables.orders.push(
      { id: 'c', created_at: daysAgo(2), total_inr: 999, status: 'cancelled', user_id: 'u-' + phone(1).slice(-4), customer_phone: phone(1) },
      { id: 'r', created_at: daysAgo(2), total_inr: 999, status: 'rejected', user_id: 'u-' + phone(1).slice(-4), customer_phone: phone(1) },
      { id: 'o', created_at: daysAgo(400), total_inr: 999, status: 'completed', user_id: 'u-' + phone(1).slice(-4), customer_phone: phone(1) },
    );
    expect((await find(phone(1)))!.stats).toMatchObject({ order_count: 1, total_spend_inr: 300 });
  });

  it('a customer\'s name comes from the profile, else their latest order, else "there"', async () => {
    seedCustomer(db(), { phone: phone(1), name: 'Priya Nair', orders: [[3, 300]] });
    db().tables.orders.push({ id: 'w1', created_at: daysAgo(9), total_inr: 100, status: 'completed', user_id: null, customer_user_id: null, customer_name: 'Ravi Kumar', customer_phone: '9812345678' });
    db().tables.orders.push({ id: 'w2', created_at: daysAgo(3), total_inr: 100, status: 'completed', user_id: null, customer_user_id: null, customer_name: 'Ravi K', customer_phone: '9812345678' });
    db().tables.orders.push({ id: 'w3', created_at: daysAgo(3), total_inr: 100, status: 'completed', user_id: null, customer_user_id: null, customer_name: '9876500000', customer_phone: '9823456789' });
    const { contacts } = await buildContacts(NOW_SEND);
    const name = (p: string) => contacts.find((c) => c.stats.phone === p)!.stats.first_name;
    expect(name(phone(1))).toBe('Priya');
    expect(name('+919812345678')).toBe('Ravi');
    expect(name('+919823456789')).toBe('there');
  });
});

describe('stage, points and VIP', () => {
  it('computes the lifecycle stage from the customer\'s own rhythm', async () => {
    // A daily-ish regular (every 2 days) 16 days after their last order is lapsed; a monthly visitor is not.
    seedCustomer(db(), { phone: phone(1), orders: [[16, 100], [18, 100], [20, 100], [22, 100]] });
    seedCustomer(db(), { phone: phone(2), orders: [[16, 100], [46, 100], [76, 100]] });
    const { contacts } = await buildContacts(NOW_SEND);
    const stage = (p: string) => contacts.find((c) => c.stats.phone === p)!.stats;
    expect(stage(phone(1))).toMatchObject({ typical_gap_days: 2, stage1_days: 14, stage: 'lapsed_1' });
    expect(stage(phone(2))).toMatchObject({ typical_gap_days: 30, stage1_days: 45, stage: 'active' });
  });

  it('uses the owner\'s win-back parameters, wherever the playbook is on or off', async () => {
    seedPlaybooks(db(), {}, { winback_1: { params: { gap_multiplier: 2.5, min_days: 14, max_days: 45, default_days: 20 } } });
    seedCustomer(db(), { phone: phone(1), orders: [[25, 300]] });
    expect((await find(phone(1)))!.stats).toMatchObject({ stage1_days: 20, stage: 'lapsed_1' });
  });

  it('reads points from the whole ledger: balance, and what expires within the playbook\'s days_ahead', async () => {
    // 30-day expiry: a credit 28 days old expires in 2 days; one 10 days old in 20.
    seedCustomer(db(), { phone: phone(1), orders: [[10, 400]], points: [[28, 60], [10, 40]] });
    const s = (await find(phone(1)))!.stats;
    expect(s).toMatchObject({ points_balance: 100, points_value_inr: 100, expiring_points: 60, expiring_value_inr: 60, expiry_date: '2026-10-07' });
    // days_ahead is the playbook's setting: at 1 day nothing is expiring yet.
    seedPlaybooks(db(), {}, { points_expiring: { params: { min_points: 20, days_ahead: 1, recent_order_days: 2, cooldown_days: 14 } } });
    expect((await find(phone(1)))!.stats.expiring_points).toBe(0);
  });

  it('points with expiry switched off never expire', async () => {
    seedLoyalty(db(), { points_expiry_days: 0 });
    seedCustomer(db(), { phone: phone(1), orders: [[10, 400]], points: [[300, 60]] });
    expect((await find(phone(1)))!.stats).toMatchObject({ points_balance: 60, expiring_points: 0, expiry_date: null });
  });

  it('VIP is decided over EVERY identified customer, not just those who opted in', async () => {
    // Ten regulars with ≥3 orders; the top 20% by spend are VIPs whether or not they opted in.
    for (let i = 0; i < 10; i++) {
      seedCustomer(db(), { phone: phone(i), optedIn: i % 2 === 0, orders: [[5, 100 * (i + 1)], [15, 100 * (i + 1)], [25, 100 * (i + 1)]] });
    }
    const { contacts } = await buildContacts(NOW_SEND);
    const vips = contacts.filter((c) => c.stats.vip).map((c) => c.stats.phone).sort();
    expect(vips).toEqual([phone(8), phone(9)]);
    // phone(9) opted out of nothing and never opted in (odd index): still a VIP.
    expect(contacts.find((c) => c.stats.phone === phone(9))!.stats.consent_opted_in).toBe(false);
  });
});

describe('history and economics inputs', () => {
  it('attaches each phone\'s marketing history', async () => {
    seedCustomer(db(), { phone: phone(1), orders: [[3, 300]], optedIn: true });
    db().tables.marketing_campaigns = [{ id: 'c1', playbook_key: 'winback_1', status: 'completed', created_at: daysAgo(10) }];
    db().tables.marketing_recipients = [{ id: 'r1', campaign_id: 'c1', phone: phone(1), arm: 'treatment', status: 'delivered', created_at: daysAgo(10), sent_at: daysAgo(10) }];
    const c = (await find(phone(1)))!;
    expect(c.history).toEqual([expect.objectContaining({ campaign_id: 'c1', playbook_key: 'winback_1', status: 'delivered' })]);
  });

  it('receipts count as connected once anything was delivered, and not before', async () => {
    db().tables.marketing_recipients = [{ id: 'r1', campaign_id: 'c1', phone: phone(1), arm: 'treatment', status: 'sent', created_at: daysAgo(10), sent_at: daysAgo(10) }];
    expect((await buildContacts(NOW_SEND)).receipts_connected).toBe(false);
    db().tables.marketing_recipients[0].status = 'delivered';
    expect((await buildContacts(NOW_SEND)).receipts_connected).toBe(true);
  });

  it('learns deliverability from sends old enough to have been delivered, once receipts flow and there are enough of them', async () => {
    const send = (i: number, status: string, ago = 5): Row => ({ id: `s${i}`, campaign_id: 'c1', phone: phone(i), arm: 'treatment', status, created_at: daysAgo(ago), sent_at: daysAgo(ago) });
    // 20 sends: 15 delivered, 5 stuck at "sent" → 75%.
    db().tables.marketing_recipients = Array.from({ length: 20 }, (_, i) => send(i, i < 15 ? 'delivered' : 'sent'));
    expect((await buildContacts(NOW_SEND)).economics.deliverability).toBeCloseTo(0.75);
    // Under 20 sends the ratio is noise: the 0.9 default.
    db().tables.marketing_recipients = db().tables.marketing_recipients.slice(0, 19);
    expect((await buildContacts(NOW_SEND)).economics.deliverability).toBe(0.9);
    // A message sent an hour ago has not had time to be delivered: it does not drag the ratio down.
    db().tables.marketing_recipients = [...Array.from({ length: 20 }, (_, i) => send(i, 'delivered')), send(99, 'sent', 0.04)];
    expect((await buildContacts(NOW_SEND)).economics.deliverability).toBe(1);
  });

  it('the store AOV is the mean order value of the last 90 days', async () => {
    db().tables.orders = [
      { id: 'a', created_at: daysAgo(10), total_inr: 200, status: 'completed' },
      { id: 'b', created_at: daysAgo(20), total_inr: 400, status: 'completed' },
      { id: 'c', created_at: daysAgo(200), total_inr: 9000, status: 'completed' },
    ];
    expect((await buildContacts(NOW_SEND)).economics.store_aov_inr).toBe(300);
  });

  it('the settings row missing yields the defaults with sending OFF', async () => {
    db().tables.marketing_settings = [];
    const snap = await buildContacts(NOW_SEND);
    expect(snap.settings_present).toBe(false);
    expect(snap.settings.enabled).toBe(false);
    expect(snap.settings.message_cost_inr).toBe(1.02);
  });

  it('winbackBundle falls back to defaults for a playbook that is not loaded', () => {
    expect(winbackBundle([])).toEqual({ winback_1: expect.objectContaining({ default_days: 30 }), winback_2: { offset_days: 30 }, winback_3: { offset_days: 60, max_days: 180 } });
  });

  it('reads a missing migration as the typed error, before any heavy read', async () => {
    db().setMissing('marketing_settings', true);
    await expect(buildContacts(NOW_SEND)).rejects.toMatchObject({ migration_missing: true });
    expect(rowsOf(db(), 'orders')).toBeDefined();
  });
});
