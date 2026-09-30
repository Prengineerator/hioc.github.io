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

  // STALE LINK: marketing_consent.user_id goes stale the day its user moves to a new verified number. It used to
  // be a second way to link a phone to an account, so the OLD number — recycled to a stranger — inherited the
  // account's orders, points and name ("Hi Asha, 120 Beanies expire…").
  describe('the VERIFIED profile phone is the only link from a phone to an account', () => {
    const OLD = phone(1);
    const NEW = phone(2);

    function movedUser() {
      // Asha (u-asha) now has a verified NEW number; her consent row for the OLD one still names her.
      db().tables.profiles = [{ id: 'u-asha', name: 'Asha Rao', phone: NEW, phone_verified: true, role: 'customer' }];
      db().tables.marketing_consent = [
        { phone: OLD, user_id: 'u-asha', status: 'opted_in', source: 'whatsapp_keyword' },
        { phone: NEW, user_id: 'u-asha', status: 'opted_in', source: 'profile' },
      ];
      // Her orders and points belong to the ACCOUNT (the order carries no phone that would match the old number).
      db().tables.orders = [
        { id: 'o1', created_at: daysAgo(10), total_inr: 300, status: 'completed', user_id: 'u-asha', customer_user_id: null, customer_name: 'Asha Rao', customer_phone: NEW },
        { id: 'o2', created_at: daysAgo(40), total_inr: 200, status: 'completed', user_id: 'u-asha', customer_user_id: null, customer_name: 'Asha Rao', customer_phone: '' },
      ];
      db().tables.loyalty_transactions = [{ id: 'lt1', user_id: 'u-asha', points: 120, created_at: daysAgo(28), type: 'earn' }];
    }

    it('the old number keeps nothing of the account: no user, orders, points or name', async () => {
      movedUser();
      const stale = (await find(OLD))!.stats;
      expect(stale).toMatchObject({ user_id: null, order_count: 0, total_spend_inr: 0, points_balance: 0, expiring_points: 0, first_name: 'there', stage: 'no_orders' });
      // Its consent is still its own.
      expect(stale.consent_opted_in).toBe(true);
    });

    it('the number that IS verified keeps all of it', async () => {
      movedUser();
      expect((await find(NEW))!.stats).toMatchObject({ user_id: 'u-asha', order_count: 2, total_spend_inr: 500, points_balance: 120, first_name: 'Asha' });
    });

    it('a phone with a consent row naming an account but no verified profile still matches ITS OWN orders by phone', async () => {
      db().tables.marketing_consent = [{ phone: OLD, user_id: 'u-gone', status: 'opted_in', source: 'whatsapp_keyword' }];
      db().tables.orders = [{ id: 'mine', created_at: daysAgo(10), total_inr: 150, status: 'completed', user_id: null, customer_user_id: null, customer_name: 'Ravi', customer_phone: OLD }];
      expect((await find(OLD))!.stats).toMatchObject({ user_id: null, order_count: 1, first_name: 'Ravi' });
    });
  });

  // STAFF: only a VERIFIED profile phone used to exclude a team member, but they sign in as <login_id>@hioc.in.
  describe('staff are recognised by every number recorded for them', () => {
    it('an unverified non-customer profile marks the contact staff, whatever spelling the phone has', async () => {
      seedCustomer(db(), { phone: phone(1), verified: false, optedIn: true, orders: [[3, 300]] });
      (db().tables.profiles ??= []).push({ id: 'st1', phone: phone(1).slice(3), phone_verified: false, role: 'staff' });
      expect((await find(phone(1)))!.stats.role).toBe('staff');
    });

    it('staff_accounts.phone marks the contact staff', async () => {
      seedCustomer(db(), { phone: phone(2), verified: false, optedIn: true, orders: [[3, 300]] });
      db().tables.staff_accounts = [{ user_id: 'st2', login_id: 'meena', phone: `+91 ${phone(2).slice(3, 8)} ${phone(2).slice(8)}`, status: 'active' }];
      expect((await find(phone(2)))!.stats.role).toBe('staff');
    });

    it('…even when the number is known only from an order or a consent row, and when it has a VERIFIED customer profile', async () => {
      db().tables.staff_accounts = [{ user_id: 's', login_id: 'a', phone: phone(3) }, { user_id: 't', login_id: 'b', phone: phone(4) }];
      db().tables.marketing_consent = [{ phone: phone(3), status: 'opted_in', source: 'whatsapp_keyword' }];
      seedCustomer(db(), { phone: phone(4), optedIn: true, orders: [[3, 300]] }); // verified profile with role 'customer'
      expect((await find(phone(3)))!.stats.role).toBe('staff');
      expect((await find(phone(4)))!.stats.role).toBe('staff');
    });

    it('a real owner/manager role is kept, and an ordinary customer stays a customer', async () => {
      seedCustomer(db(), { phone: phone(5), role: 'owner', optedIn: true, orders: [[3, 300]] });
      seedCustomer(db(), { phone: phone(6), optedIn: true, orders: [[3, 300]] });
      db().tables.staff_accounts = [{ user_id: 'x', login_id: 'x', phone: phone(5) }];
      expect((await find(phone(5)))!.stats.role).toBe('owner');
      expect((await find(phone(6)))!.stats.role).toBe('customer');
    });

    it('a staff number nothing else mentions does not become a contact', async () => {
      db().tables.staff_accounts = [{ user_id: 'x', login_id: 'x', phone: phone(7) }];
      expect(await find(phone(7))).toBeUndefined();
    });

    it('builds without staff_accounts (another migration) — staff are then found through profiles alone', async () => {
      seedCustomer(db(), { phone: phone(8), verified: false, optedIn: true, orders: [[3, 300]] });
      (db().tables.profiles ??= []).push({ id: 'st8', phone: phone(8), phone_verified: false, role: 'manager' });
      db().setMissing('staff_accounts', true);
      expect((await find(phone(8)))!.stats.role).toBe('staff');
    });

    it('messageableContacts leaves staff out', async () => {
      seedCustomer(db(), { phone: phone(1), optedIn: true, orders: [[3, 300]] });
      seedCustomer(db(), { phone: phone(2), verified: false, optedIn: true, orders: [[3, 300]] });
      db().tables.staff_accounts = [{ user_id: 'x', login_id: 'x', phone: phone(2) }];
      expect(messageableContacts(await buildContacts(NOW_SEND)).map((c) => c.stats.phone)).toEqual([phone(1)]);
    });
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

  // VIP is "the top 20% by spend among contacts with ≥ 3 orders" (spec §1.1) — contacts being the people a campaign
  // can reach. It used to be measured over every identified phone, so customers who never opted in (and staff)
  // raised the bar: a manual "VIP only" campaign could end up with no VIPs at all.
  describe('VIP is the top 20% of the MESSAGEABLE contacts with at least 3 orders', () => {
    const regular = (i: number, extra: Partial<Parameters<typeof seedCustomer>[1]> = {}) =>
      seedCustomer(db(), { phone: phone(i), orders: [[5, 100 * (i + 1)], [15, 100 * (i + 1)], [25, 100 * (i + 1)]], ...extra });
    const vips = async () => (await buildContacts(NOW_SEND)).contacts.filter((c) => c.stats.vip).map((c) => c.stats.phone).sort();

    it('customers who never opted in do not raise the bar for those who did', async () => {
      // Five opted-in regulars (spend 300…1500) and five big spenders who never opted in (1800…3000).
      for (let i = 0; i < 5; i++) regular(i, { optedIn: true });
      for (let i = 5; i < 10; i++) regular(i, { optedIn: false });
      // Over everyone the bar is the 2nd biggest spender (2700): NOBODY reachable would be a VIP.
      // Over the five reachable customers it is the biggest of them (1500).
      const { contacts } = await buildContacts(NOW_SEND);
      const vipOf = (i: number) => contacts.find((c) => c.stats.phone === phone(i))!.stats.vip;
      expect(vipOf(4)).toBe(true);
      for (const i of [0, 1, 2, 3]) expect(vipOf(i)).toBe(false);
    });

    it('opted-out customers and staff do not count either', async () => {
      for (let i = 0; i < 5; i++) regular(i, { optedIn: true });
      regular(5, { optedIn: true, optedOut: true });
      regular(6, { optedIn: true, role: 'staff' });
      regular(7, { optedIn: true, verified: false });
      db().tables.staff_accounts = [{ user_id: 's', login_id: 's', phone: phone(7) }];
      const { contacts } = await buildContacts(NOW_SEND);
      expect(contacts.find((c) => c.stats.phone === phone(4))!.stats.vip).toBe(true);
    });

    it('still needs 3 orders, and ties at the line are all in', async () => {
      for (let i = 0; i < 5; i++) regular(i, { optedIn: true });
      seedCustomer(db(), { phone: phone(20), optedIn: true, orders: [[5, 9000], [15, 9000]] }); // big, but only 2 orders
      regular(21, { optedIn: true }); // spends 2200, above everyone: sets the bar
      const v = await vips();
      expect(v).toContain(phone(21));
      expect(v).not.toContain(phone(20));
    });

    it('nobody with 3 orders among the reachable means no VIP', async () => {
      regular(1, { optedIn: false });
      regular(2, { optedIn: false });
      expect(await vips()).toEqual([]);
    });
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

  // DELIVERABILITY: Meta's 131049 arrives asynchronously, AFTER 'sent', and the webhook then moves the row
  // sent → failed keeping its sent_at. Leaving those rows out of the denominator overstated reach.
  describe('deliverability counts later-failed messages in the denominator', () => {
    const send = (i: number, status: string, over: Row = {}): Row => ({
      id: `s${i}`, campaign_id: 'c1', phone: phone(i), arm: 'treatment', status, created_at: daysAgo(5), sent_at: daysAgo(5), ...over,
    });

    it('15 delivered, 5 failed after sending → 75%, not 100%', async () => {
      db().tables.marketing_recipients = Array.from({ length: 20 }, (_, i) => send(i, i < 15 ? 'delivered' : 'failed'));
      expect((await buildContacts(NOW_SEND)).economics.deliverability).toBeCloseTo(0.75);
    });

    it('read counts as delivered, and sent-but-unconfirmed counts in the denominator only', async () => {
      db().tables.marketing_recipients = [
        ...Array.from({ length: 8 }, (_, i) => send(i, 'delivered')),
        ...Array.from({ length: 4 }, (_, i) => send(10 + i, 'read')),
        ...Array.from({ length: 4 }, (_, i) => send(20 + i, 'sent')),
        ...Array.from({ length: 4 }, (_, i) => send(30 + i, 'failed')),
      ];
      expect((await buildContacts(NOW_SEND)).economics.deliverability).toBeCloseTo(12 / 20);
    });

    it('a failure that never left (no sent_at), a holdout and a message too fresh to have arrived are not counted', async () => {
      db().tables.marketing_recipients = [
        ...Array.from({ length: 20 }, (_, i) => send(i, 'delivered')),
        send(40, 'failed', { sent_at: null }), // the sender failed it: nothing left
        send(41, 'holdout', { arm: 'holdout', sent_at: null }),
        send(42, 'failed', { sent_at: daysAgo(0.04) }), // an hour old: too soon to judge
      ];
      expect((await buildContacts(NOW_SEND)).economics.deliverability).toBe(1);
    });
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
