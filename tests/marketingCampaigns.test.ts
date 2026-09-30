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

// Campaign lifecycle and read models: manual drafts, the wizard preview, approve /
// cancel / expire, the detail page and the lists. Real lib/marketing/server/campaigns.ts
// over an in-memory database.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));

const C = await import('@/lib/marketing/server/campaigns');

const db = () => h.db;
const phone = (n: number) => `+9198765${String(30000 + n)}`;
const campaign = (id: string) => rowsOf(db(), 'marketing_campaigns', (r) => r.id === id)[0];
const recipients = (where: (r: Row) => boolean = () => true) => rowsOf(db(), 'marketing_recipients', where);

const TEMPLATE = {
  name: 'hioc_offer_1',
  lang: 'en',
  vars: ['first_name', 'headline', 'offer_text', 'code', 'valid_till'] as const,
  url_button: true,
  body_preview: 'Hi {{1}}, {{2}} at HIOC! Enjoy {{3}} with code {{4}}, valid till {{5}}.',
};
const manual = (over: Record<string, unknown> = {}) => ({
  name: 'New hazelnut latte',
  audience: {},
  offer: { type: 'percent' as const, percent: 15, cap_inr: 80, min_order_inr: 200, validity_days: 7 },
  template: { ...TEMPLATE, vars: [...TEMPLATE.vars] },
  headline: 'Hazelnut latte is here',
  send_after: null,
  ...over,
});

function seedCampaignRow(over: Row = {}): Row {
  const row: Row = {
    id: 'camp', kind: 'manual', playbook_key: null, name: 'A campaign', status: 'pending_approval', planned_for: '2026-10-05',
    send_after: null, audience: {}, offer: { type: 'none' }, template: { name: 't', lang: 'en', vars: ['first_name'], url_button: false, body_preview: 'Hi {{1}}' },
    projection: {}, guardrail_flags: [], priority: 4, treated_count: 0, holdout_count: 0, started_at: null, completed_at: null, created_at: daysAgo(0), ...over,
  };
  (db().tables.marketing_campaigns ??= []).push(row);
  return row;
}
let rn = 0;
function seedRec(over: Row = {}): Row {
  const row: Row = {
    id: `rec${++rn}`, campaign_id: 'camp', phone: phone(rn), arm: 'treatment', status: 'pending', first_name: 'Asha', vars: { first_name: 'Asha' },
    cost_inr: 0, created_at: new Date(NOW_SEND.getTime() + rn).toISOString(), ...over,
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
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('manual campaigns', () => {
  function customers() {
    // Three lapsed regulars, two active, one who never opted in.
    // Orders 30 days apart → a 30-day rhythm → lapse threshold 45 days; 50 days since the last one = lapsed.
    for (let i = 0; i < 3; i++) seedCustomer(db(), { phone: phone(i), name: `Lapsed${i} Rao`, optedIn: true, orders: [[50, 300], [80, 300], [110, 300]] });
    for (let i = 3; i < 5; i++) seedCustomer(db(), { phone: phone(i), name: `Active${i} Rao`, optedIn: true, orders: [[3, 500]] });
    seedCustomer(db(), { phone: phone(9), name: 'Nope Rao', optedIn: false, orders: [[40, 300]] });
  }

  it('saves a DRAFT with a frozen projection, pending recipients and the headline in their variables', async () => {
    seedSettings(db(), { holdout_pct: 0 });
    customers();
    const r = await C.createManualDraft(manual(), 'owner-1', NOW_SEND);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const c = r.campaign;
    expect(c).toMatchObject({ kind: 'manual', playbook_key: null, status: 'draft', name: 'New hazelnut latte', treated_count: 5, holdout_count: 0, template_name: 'hioc_offer_1' });
    expect(c.projection).toMatchObject({ eligible: 5, holdout: 0, treated: 5, message_cost_inr: 1.02 });
    // A manual campaign has no history, so it uses the 5% research prior.
    expect(c.projection.conversion_rate).toBeCloseTo(0.05);
    expect(c.audience).toEqual({ filter: {}, headline: 'Hazelnut latte is here' });
    expect(c.offer_text).toBe('15% off (up to ₹80) on orders above ₹200');

    const row = campaign(c.id);
    expect(row).toMatchObject({ created_by: 'owner-1', priority: 10, status: 'draft' });
    const all = recipients();
    expect(all).toHaveLength(5);
    expect(all.every((x) => x.status === 'pending')).toBe(true);
    expect(all[0].vars).toMatchObject({ headline: 'Hazelnut latte is here', offer_text: '15% off (up to ₹80) on orders above ₹200' });
    // Nothing can send from a draft: no coupon exists yet.
    expect(rowsOf(db(), 'coupons')).toEqual([]);
  });

  it('applies the owner\'s audience filter, and only ever to customers who opted in', async () => {
    customers();
    const r = await C.createManualDraft(manual({ audience: { stages: ['lapsed_1'], min_orders: 3 } }), null, NOW_SEND);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.campaign.treated_count + r.campaign.holdout_count).toBe(3);
    expect(recipients().map((x) => x.phone).sort()).toEqual([phone(0), phone(1), phone(2)]);
  });

  it('draws the holdout at the configured %, never over everyone', async () => {
    seedSettings(db(), { holdout_pct: 20 });
    for (let i = 0; i < 10; i++) seedCustomer(db(), { phone: phone(i), optedIn: true, orders: [[40, 300]] });
    const r = await C.createManualDraft(manual(), null, NOW_SEND);
    if (!r.ok) throw new Error('expected ok');
    expect(r.campaign).toMatchObject({ treated_count: 8, holdout_count: 2 });
    expect(recipients((x) => x.arm === 'holdout').every((x) => x.status === 'holdout' && x.click_token === null)).toBe(true);
    expect(recipients((x) => x.arm === 'treatment').every((x) => typeof x.click_token === 'string')).toBe(true);
  });

  it('refuses to save an empty audience', async () => {
    customers();
    const r = await C.createManualDraft(manual({ audience: { min_orders: 99 } }), null, NOW_SEND);
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(rowsOf(db(), 'marketing_campaigns')).toEqual([]);
  });

  it('honours send_after', async () => {
    customers();
    const at = '2026-10-10T05:00:00.000Z';
    const r = await C.createManualDraft(manual({ send_after: at }), null, NOW_SEND);
    if (!r.ok) throw new Error('expected ok');
    expect(r.campaign.send_after).toBe(at);
  });

  it('flags a template with no name (the wizard can still preview it)', async () => {
    customers();
    const r = await C.createManualDraft(manual({ template: { ...TEMPLATE, vars: [...TEMPLATE.vars], name: '' } }), null, NOW_SEND);
    if (!r.ok) throw new Error('expected ok');
    expect(r.campaign.guardrail_flags).toContain('no_template');
  });

  it('freezes the free item it resolved', async () => {
    customers();
    const r = await C.createManualDraft(
      manual({ offer: { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 } }),
      null,
      NOW_SEND,
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.campaign.offer).toMatchObject({ type: 'free_item', item_id: 'item-1', variant_id: 'var-1', price_inr: 200, cost_inr: 60 });
    expect(r.campaign.offer_text).toBe('a FREE Cold Coffee with any order above ₹200');
  });

  it('one forgotten draft does not make every other campaign see "nobody is eligible" (drafts are not in flight)', async () => {
    customers();
    const first = await C.createManualDraft(manual({ name: 'Forgotten' }), 'owner-1', NOW_SEND);
    expect(first.ok).toBe(true);
    // The five eligible customers now have pending recipients in a DRAFT. They are still eligible for the next campaign…
    const p = await C.previewManual(manual({ name: 'Second' }), NOW_SEND);
    expect(p.eligible).toBe(5);
    const second = await C.createManualDraft(manual({ name: 'Second' }), 'owner-1', NOW_SEND);
    expect(second.ok).toBe(true);
    // …while a campaign that is waiting for approval DOES hold its recipients.
    const waiting = campaign((first as { ok: true; campaign: { id: string } }).campaign.id);
    waiting.status = 'pending_approval';
    expect((await C.previewManual(manual(), NOW_SEND)).eligible).toBe(0);
  });

  it('never picks a control-group member of a live campaign, for any audience filter (rule 8)', async () => {
    customers();
    seedCampaignRow({ id: 'live', kind: 'playbook', playbook_key: 'winback_1', status: 'sending', started_at: daysAgo(1), created_at: daysAgo(1) });
    seedRec({ id: 'h', campaign_id: 'live', phone: phone(0), arm: 'holdout', status: 'holdout', created_at: daysAgo(1), reference_at: daysAgo(1) });
    const snap = await (await import('@/lib/marketing/server/audience')).buildContacts(NOW_SEND);

    expect(C.eligibleForManual(snap, {}).map((s) => s.phone)).not.toContain(phone(0));
    expect(C.eligibleForManual(snap, { stages: ['lapsed_1'] }).map((s) => s.phone).sort()).toEqual([phone(1), phone(2)]);
    // Once that window closes (attribution_days = 7) they are eligible again.
    const later = new Date(NOW_SEND.getTime() + 7 * 24 * 60 * 60 * 1000 + 60_000);
    const snapLater = await (await import('@/lib/marketing/server/audience')).buildContacts(later);
    expect(C.eligibleForManual(snapLater, {}).map((s) => s.phone)).toContain(phone(0));
  });

  it('never picks staff: an unverified staff profile, or a staff_accounts number, is enough to exclude', async () => {
    customers();
    seedCustomer(db(), { phone: phone(40), optedIn: true, verified: false, orders: [[40, 300]] });
    db().tables.profiles.push({ id: 'st1', phone: phone(40), phone_verified: false, role: 'staff' });
    seedCustomer(db(), { phone: phone(41), optedIn: true, verified: false, orders: [[40, 300]] });
    db().tables.staff_accounts = [{ user_id: 'st2', login_id: 'ravi', phone: phone(41), status: 'active' }];
    const snap = await (await import('@/lib/marketing/server/audience')).buildContacts(NOW_SEND);
    const phones = C.eligibleForManual(snap, {}).map((s) => s.phone);
    expect(phones).not.toContain(phone(40));
    expect(phones).not.toContain(phone(41));
    expect(phones).toHaveLength(5);
  });

  it('a 409-worthy state: the draft appears in the pending_approval list with rendered samples', async () => {
    customers();
    await C.createManualDraft(manual(), null, NOW_SEND);
    const [c] = await C.listCampaigns('pending_approval', NOW_SEND);
    expect(c.status).toBe('draft');
    expect(c.samples).toHaveLength(3);
    // The coupon code is a visible placeholder — real codes are issued at send.
    expect(c.samples[0].text).toMatch(/Hi \w+, Hazelnut latte is here at HIOC! Enjoy 15% off .* with code OFXXXXXX, valid till 12 Oct\./);
    expect(c.samples[0].coupon_code).toBe('');
  });
});

describe('the wizard preview', () => {
  it('prices the campaign and shows samples, and saves NOTHING', async () => {
    for (let i = 0; i < 4; i++) seedCustomer(db(), { phone: phone(i), optedIn: true, orders: [[40, 300]] });
    const nonEmpty = () => JSON.stringify(Object.fromEntries(Object.entries(db().tables).filter(([, rows]) => rows.length > 0)));
    const before = nonEmpty();

    const p = await C.previewManual(manual(), NOW_SEND);

    expect(p.eligible).toBe(4);
    expect(p.projection).toMatchObject({ eligible: 4, treated: 4 });
    expect(p.guardrail_flags).toEqual(expect.any(Array));
    expect(p.samples).toHaveLength(3);
    expect(nonEmpty()).toBe(before);
    expect(db().log.filter((l) => l.startsWith('insert') || l.startsWith('update') || l.startsWith('delete'))).toEqual([]);
  });

  it('answers with zero eligible rather than failing on an empty audience', async () => {
    const p = await C.previewManual(manual(), NOW_SEND);
    expect(p).toMatchObject({ eligible: 0, samples: [] });
    expect(p.projection.treated).toBe(0);
  });
});

describe('approve', () => {
  beforeEach(() => {
    seedCampaignRow({ id: 'camp', status: 'pending_approval', treated_count: 2, holdout_count: 1 });
    seedRec({ id: 't1' });
    seedRec({ id: 't2' });
    seedRec({ id: 'h1', arm: 'holdout', status: 'holdout' });
  });

  it('moves a pending_approval campaign to approved and queues its pending recipients', async () => {
    const r = await C.approveCampaign('camp', 'owner-1', NOW_SEND);
    expect(r.ok).toBe(true);
    expect(campaign('camp')).toMatchObject({ status: 'approved', approved_by: 'owner-1', approved_at: NOW_SEND.toISOString() });
    expect(recipients((x) => x.id === 't1')[0].status).toBe('queued');
    expect(recipients((x) => x.id === 't2')[0].status).toBe('queued');
    // The holdout is never queued.
    expect(recipients((x) => x.id === 'h1')[0].status).toBe('holdout');
  });

  it('approves a draft too', async () => {
    campaign('camp').status = 'draft';
    expect((await C.approveCampaign('camp', 'owner-1')).ok).toBe(true);
  });

  it.each(['approved', 'sending', 'completed', 'cancelled', 'expired'])('refuses a campaign that is already %s', async (status) => {
    campaign('camp').status = status;
    const r = await C.approveCampaign('camp', 'owner-1');
    expect(r).toMatchObject({ ok: false, code: 'invalid_state', status });
    expect(recipients((x) => x.id === 't1')[0].status).toBe('pending');
  });

  it('a second tap of the button does nothing more', async () => {
    await C.approveCampaign('camp', 'owner-1');
    campaign('camp').approved_by = 'owner-1';
    const again = await C.approveCampaign('camp', 'owner-2');
    expect(again).toMatchObject({ ok: false, code: 'invalid_state' });
    expect(campaign('camp').approved_by).toBe('owner-1');
  });

  it('404s an unknown campaign', async () => {
    expect(await C.approveCampaign('nope', 'owner-1')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('puts the campaign back if the recipients cannot be queued, so the owner can retry', async () => {
    db().failNext('update marketing_recipients');
    await expect(C.approveCampaign('camp', 'owner-1')).rejects.toThrow();
    expect(campaign('camp')).toMatchObject({ status: 'pending_approval', approved_by: null });
  });
});

describe('cancel', () => {
  beforeEach(() => {
    seedCampaignRow({ id: 'camp', status: 'approved' });
    seedRec({ id: 'p', status: 'pending' });
    seedRec({ id: 'q', status: 'queued' });
    seedRec({ id: 's', status: 'sent', sent_at: daysAgo(1) });
    seedRec({ id: 'sg', status: 'sending' });
    seedRec({ id: 'h', arm: 'holdout', status: 'holdout' });
  });

  it('cancels the campaign and its pending and queued recipients — nothing else', async () => {
    const r = await C.cancelCampaign('camp', NOW_SEND);
    expect(r.ok).toBe(true);
    expect(campaign('camp').status).toBe('cancelled');
    const status = (id: string) => recipients((x) => x.id === id)[0].status;
    expect(status('p')).toBe('cancelled');
    expect(status('q')).toBe('cancelled');
    expect(status('s')).toBe('sent');
    expect(status('sg')).toBe('sending');
    expect(status('h')).toBe('holdout');
  });

  it.each(['draft', 'pending_approval', 'approved', 'sending'])('cancels a %s campaign', async (status) => {
    campaign('camp').status = status;
    expect((await C.cancelCampaign('camp')).ok).toBe(true);
  });

  it.each(['completed', 'cancelled', 'expired'])('refuses a terminal (%s) campaign', async (status) => {
    campaign('camp').status = status;
    expect(await C.cancelCampaign('camp')).toMatchObject({ ok: false, code: 'invalid_state', status });
  });

  it('404s an unknown campaign', async () => {
    expect(await C.cancelCampaign('nope')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a cancelled campaign can no longer be approved', async () => {
    await C.cancelCampaign('camp');
    expect(await C.approveCampaign('camp', 'owner-1')).toMatchObject({ ok: false, code: 'invalid_state' });
  });
});

describe('expireStale', () => {
  it('expires pending_approval campaigns older than 2 days and cancels their unsent recipients', async () => {
    seedCampaignRow({ id: 'old', status: 'pending_approval', created_at: daysAgo(2.1) });
    seedCampaignRow({ id: 'new', status: 'pending_approval', created_at: daysAgo(1.5) });
    seedRec({ id: 'ro', campaign_id: 'old' });
    seedRec({ id: 'rn', campaign_id: 'new' });
    expect(await C.expireStale(NOW_SEND)).toBe(1);
    expect(campaign('old').status).toBe('expired');
    expect(campaign('new').status).toBe('pending_approval');
    expect(recipients((x) => x.id === 'ro')[0].status).toBe('cancelled');
    expect(recipients((x) => x.id === 'rn')[0].status).toBe('pending');
  });
});

describe('expireStale — drafts', () => {
  it('expires a DRAFT older than 7 days (recipients cancelled) and leaves a younger one, and other statuses, alone', async () => {
    seedCampaignRow({ id: 'old-draft', status: 'draft', created_at: daysAgo(7.1) });
    seedCampaignRow({ id: 'new-draft', status: 'draft', created_at: daysAgo(6.5) });
    seedCampaignRow({ id: 'old-approved', status: 'approved', created_at: daysAgo(30) });
    seedCampaignRow({ id: 'old-done', status: 'completed', created_at: daysAgo(30) });
    seedRec({ id: 'rd-old', campaign_id: 'old-draft' });
    seedRec({ id: 'rd-old-h', campaign_id: 'old-draft', arm: 'holdout', status: 'holdout' });
    seedRec({ id: 'rd-new', campaign_id: 'new-draft' });
    seedRec({ id: 'ra', campaign_id: 'old-approved', status: 'queued' });

    expect(await C.expireStale(NOW_SEND)).toBe(1);

    expect(campaign('old-draft').status).toBe('expired');
    expect(campaign('new-draft').status).toBe('draft');
    expect(campaign('old-approved').status).toBe('approved');
    expect(campaign('old-done').status).toBe('completed');
    expect(recipients((x) => x.id === 'rd-old')[0].status).toBe('cancelled');
    expect(recipients((x) => x.id === 'rd-old-h')[0].status).toBe('holdout');
    expect(recipients((x) => x.id === 'rd-new')[0].status).toBe('pending');
    expect(recipients((x) => x.id === 'ra')[0].status).toBe('queued');
  });

  it('counts approvals and drafts together; an approval is still stale after 2 days, a draft only after 7', async () => {
    seedCampaignRow({ id: 'pa', status: 'pending_approval', created_at: daysAgo(2.1) });
    seedCampaignRow({ id: 'dr-3d', status: 'draft', created_at: daysAgo(3) });
    seedCampaignRow({ id: 'dr-9d', status: 'draft', created_at: daysAgo(9) });
    expect(await C.expireStale(NOW_SEND)).toBe(2);
    expect([campaign('pa').status, campaign('dr-3d').status, campaign('dr-9d').status]).toEqual(['expired', 'draft', 'expired']);
  });
});

describe('lists', () => {
  it('filters by status group', async () => {
    for (const [id, status] of [['a', 'draft'], ['b', 'pending_approval'], ['c', 'approved'], ['d', 'sending'], ['e', 'completed'], ['f', 'cancelled'], ['g', 'expired']] as const) {
      seedCampaignRow({ id, status, created_at: daysAgo(10 - id.charCodeAt(0) + 96) });
    }
    const ids = async (f: 'pending_approval' | 'active' | 'history') => (await C.listCampaigns(f, NOW_SEND)).map((c) => c.id).sort();
    expect(await ids('pending_approval')).toEqual(['a', 'b']);
    expect(await ids('active')).toEqual(['c', 'd']);
    expect(await ids('history')).toEqual(['e', 'f', 'g']);
  });

  it('is newest first, and samples appear only on campaigns awaiting a decision', async () => {
    seedCampaignRow({ id: 'older', status: 'pending_approval', created_at: daysAgo(2) });
    seedCampaignRow({ id: 'newer', status: 'draft', created_at: daysAgo(1) });
    seedRec({ id: 'x1', campaign_id: 'older' });
    const list = await C.listCampaigns('pending_approval', NOW_SEND);
    expect(list.map((c) => c.id)).toEqual(['newer', 'older']);
    expect(list[1].samples).toHaveLength(1);
    seedCampaignRow({ id: 'run', status: 'approved' });
    seedRec({ id: 'x2', campaign_id: 'run', status: 'queued' });
    expect((await C.listCampaigns('active', NOW_SEND))[0].samples).toEqual([]);
  });
});

describe('totals and lift', () => {
  it('aggregates cumulatively along sent ⊇ delivered ⊇ read, and never counts the holdout as sent', () => {
    const a = C.aggregateRecipients([
      { arm: 'treatment', status: 'sent', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 1.02, sent_at: '2026-10-01T05:00:00.000Z' },
      { arm: 'treatment', status: 'delivered', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 1.02, sent_at: '2026-10-02T05:00:00.000Z' },
      { arm: 'treatment', status: 'read', clicked_at: '2026-10-02T06:00:00.000Z', converted_at: '2026-10-03T05:00:00.000Z', conversion_revenue_inr: 300, cost_inr: 1.02, sent_at: '2026-10-01T05:00:00.000Z' },
      { arm: 'treatment', status: 'failed', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 0, sent_at: null },
      { arm: 'treatment', status: 'skipped', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 0, sent_at: null },
      { arm: 'treatment', status: 'queued', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 0, sent_at: null },
      { arm: 'holdout', status: 'holdout', clicked_at: null, converted_at: '2026-10-03T05:00:00.000Z', conversion_revenue_inr: 250, cost_inr: 0, sent_at: null },
      { arm: 'holdout', status: 'holdout', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 0, sent_at: null },
    ]);
    expect(C.totalsOf(a)).toEqual({ sent: 3, delivered: 2, read: 1, clicked: 1, failed: 1, skipped: 1, returned: 1, revenue_inr: 300, spend_inr: 3.06 });
    expect(a).toMatchObject({ in_flight: 1, treated_converted: 1, holdout_n: 2, holdout_converted: 1 });
    expect(a.last_sent_ms).toBe(Date.parse('2026-10-02T05:00:00.000Z'));
  });

  it('the detail shows measured lift once the holdout is big enough, and "not enough data" below 20', async () => {
    const seed = (holdoutN: number) => {
      db().tables.marketing_campaigns = [];
      db().tables.marketing_recipients = [];
      seedCampaignRow({ id: 'camp', status: 'completed', started_at: daysAgo(3), treated_count: 100, holdout_count: holdoutN });
      // 100 delivered, 20 converted (20%)…
      for (let i = 0; i < 100; i++) seedRec({ status: 'delivered', sent_at: daysAgo(3), converted_at: i < 20 ? daysAgo(2) : null, conversion_revenue_inr: i < 20 ? 300 : 0, cost_inr: 1.02 });
      // …vs a holdout converting at 10%.
      for (let i = 0; i < holdoutN; i++) seedRec({ arm: 'holdout', status: 'holdout', converted_at: i < holdoutN / 10 ? daysAgo(2) : null });
    };

    seed(40);
    let d = (await C.getCampaignDetail('camp', 1, NOW_SEND))!;
    expect(d.results).toMatchObject({ treated_delivered: 100, treated_converted: 20, holdout_n: 40, holdout_converted: 4, holdout_big_enough: true });
    expect(d.results.treated_rate).toBeCloseTo(0.2);
    expect(d.results.holdout_rate).toBeCloseTo(0.1);
    expect(d.results.lift_pp).toBeCloseTo(10);
    expect(d.results.incremental_orders).toBeCloseTo(10);
    expect(d.lift_pp).toBeCloseTo(10);

    seed(10);
    d = (await C.getCampaignDetail('camp', 1, NOW_SEND))!;
    expect(d.results).toMatchObject({ holdout_big_enough: false, lift_pp: null, incremental_orders: null });
    expect(d.lift_pp).toBeNull();
  });

  it('lift is null for a campaign that has not started sending', async () => {
    seedCampaignRow({ id: 'camp', started_at: null });
    for (let i = 0; i < 30; i++) seedRec({ arm: 'holdout', status: 'holdout' });
    expect((await C.getCampaignDetail('camp', 1, NOW_SEND))!.lift_pp).toBeNull();
  });
});

describe('the detail page', () => {
  it('pages recipients 50 at a time and reports the total', async () => {
    seedCampaignRow({ id: 'camp', status: 'sending', started_at: daysAgo(1) });
    for (let i = 0; i < 120; i++) seedRec({ status: 'queued' });

    const p1 = (await C.getCampaignDetail('camp', 1, NOW_SEND))!;
    const p2 = (await C.getCampaignDetail('camp', 2, NOW_SEND))!;
    const p3 = (await C.getCampaignDetail('camp', 3, NOW_SEND))!;
    expect([p1.recipients.length, p2.recipients.length, p3.recipients.length]).toEqual([50, 50, 20]);
    expect(p1).toMatchObject({ page: 1, recipients_total: 120 });
    expect(new Set([...p1.recipients, ...p2.recipients, ...p3.recipients].map((r) => r.id)).size).toBe(120);
    // A nonsense page is page 1.
    expect((await C.getCampaignDetail('camp', -4, NOW_SEND))!.page).toBe(1);
  });

  it('exposes what the owner needs to read a recipient, and the window in which returns still count', async () => {
    seedCampaignRow({ id: 'camp', status: 'sending', started_at: '2026-10-04T06:00:00.000Z' });
    seedRec({ id: 'r1', status: 'failed', error: '(#131049) not delivered', error_code: '131049', phone: '+919876500001' });
    seedRec({ id: 'r2', status: 'sent', sent_at: '2026-10-04T06:00:00.000Z', cost_inr: 1.02, coupon_code: 'WBABCDEF' });
    const d = (await C.getCampaignDetail('camp', 1, NOW_SEND))!;
    expect(d.recipients[0]).toMatchObject({ id: 'r1', phone: '+919876500001', status: 'failed', error_code: '131049', cost_inr: 0 });
    expect(d.recipients[1]).toMatchObject({ coupon_code: 'WBABCDEF', cost_inr: 1.02 });
    // 7 days after the LAST message went out.
    expect(d.results.window_closes_at).toBe('2026-10-11T06:00:00.000Z');
    expect(d.results.attribution_open).toBe(true);
    expect(d).not.toHaveProperty('recipients.0.vars');
  });

  it('returns null for an unknown campaign', async () => {
    expect(await C.getCampaignDetail('nope', 1, NOW_SEND)).toBeNull();
  });

  it('fills the contract for a row that predates the projection column', async () => {
    seedCampaignRow({ id: 'camp', projection: {} });
    const d = (await C.getCampaignDetail('camp', 1, NOW_SEND))!;
    expect(d.projection).toMatchObject({ eligible: 0, treated: 0, roi: null, break_even_rate: null });
  });
});

describe('insertCampaign', () => {
  const stats = (i: number) => ({ phone: phone(i), user_id: null, first_name: 'A' }) as never;
  const base = {
    kind: 'manual' as const, playbook_key: null, name: 'x', status: 'draft' as const, planned_for: '2026-10-05', send_after: null, audience: {},
    offer: { type: 'none' as const }, template: TEMPLATE as never, projection: {} as never, guardrail_flags: [], priority: 10, created_by: null,
  };

  it('draws the SAME holdout for the same campaign id', async () => {
    const people = Array.from({ length: 30 }, (_, i) => ({ stats: stats(i), vars: {} }));
    const draw = async (id: string) => {
      db().tables.marketing_campaigns = [];
      db().tables.marketing_recipients = [];
      await C.insertCampaign(db().client as never, { ...base, id }, people, 'pending', 20);
      return recipients((r) => r.arm === 'holdout').map((r) => r.phone).sort();
    };
    const a1 = await draw('campaign-a');
    const a2 = await draw('campaign-a');
    const b = await draw('campaign-b');
    expect(a1).toHaveLength(6);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  describe('recipients that do not all land', () => {
    const people = (n: number) => Array.from({ length: n }, (_, i) => ({ stats: stats(i), vars: {} }));

    it('removes the campaign AND the rows that did land when a later chunk fails', async () => {
      db().failNext('insert marketing_recipients', undefined, 1); // 600 rows = chunks of 500 + 100
      const r = await C.insertCampaign(db().client as never, { ...base, id: 'half' }, people(600), 'pending', 10);
      expect(r).toMatchObject({ ok: false, duplicate: false });
      expect(rowsOf(db(), 'marketing_campaigns')).toEqual([]);
      expect(recipients()).toEqual([]);
    });

    it('cancels the campaign (and its unsent rows) when even the delete fails', async () => {
      db().failNext('insert marketing_recipients', undefined, 1);
      db().failNext('delete marketing_campaigns');
      const r = await C.insertCampaign(db().client as never, { ...base, id: 'stuck' }, people(600), 'pending', 10);
      expect(r).toMatchObject({ ok: false });
      expect(campaign('stuck').status).toBe('cancelled');
      expect(recipients().every((x) => x.status === 'cancelled' || x.status === 'holdout')).toBe(true);
    });

    it('sets treated_count / holdout_count from the rows that actually landed, and reports those', async () => {
      // A write that is acknowledged but stores fewer rows than it was given (only 3 of the 10 land).
      const inner = db().client;
      db().client = {
        ...inner,
        from: (t: string) => {
          const q = inner.from(t) as { insert: (rows: unknown[]) => unknown };
          if (t !== 'marketing_recipients') return q;
          const insert = q.insert.bind(q);
          return Object.assign(q, { insert: (rows: Row[]) => insert(rows.slice(0, 3)) });
        },
      };
      const r = await C.insertCampaign(db().client as never, { ...base, id: 'short' }, people(10), 'pending', 20);
      const landed = recipients();
      expect(landed).toHaveLength(3);
      expect(r).toMatchObject({ ok: true, treated: landed.filter((x) => x.arm === 'treatment').length, holdout: landed.filter((x) => x.arm === 'holdout').length });
      expect(campaign('short')).toMatchObject({
        treated_count: landed.filter((x) => x.arm === 'treatment').length,
        holdout_count: landed.filter((x) => x.arm === 'holdout').length,
      });
    });

    it('leaves the counts alone when every row landed (no needless write)', async () => {
      await C.insertCampaign(db().client as never, { ...base, id: 'whole' }, people(10), 'pending', 20);
      expect(campaign('whole')).toMatchObject({ treated_count: 8, holdout_count: 2 });
      expect(db().log.filter((l) => l === 'update marketing_campaigns')).toEqual([]);
    });
  });

  it('holds out round(N × pct / 100) — the same count the projection promised', async () => {
    for (const [n, pct, want] of [[5, 10, 1], [4, 10, 0], [30, 50, 15], [3, 0, 0]] as const) {
      db().tables.marketing_campaigns = [];
      db().tables.marketing_recipients = [];
      const people = Array.from({ length: n }, (_, i) => ({ stats: stats(i), vars: {} }));
      const r = await C.insertCampaign(db().client as never, { ...base, id: `c-${n}-${pct}` }, people, 'pending', pct);
      expect(r).toMatchObject({ ok: true, holdout: want, treated: n - want });
    }
  });
});
