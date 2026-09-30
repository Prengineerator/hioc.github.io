import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb, Row } from './helpers/marketingDb';
import { DAY, NOW_NIGHT, NOW_SEND, daysAgo, newDb, rowsOf, seedSettings } from './helpers/marketingWorld';

// The sender (spec §6 "Sender algorithm") — the one place money and consent meet. These run
// the REAL runSendBatch against an in-memory database with the WhatsApp adapter mocked, and
// pin every rule that keeps it from messaging someone it should not, twice, or for free.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, send: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/notifications/adapters', () => ({ whatsappAdapter: { send: h.send } }));

const { runSendBatch, parseMetaErrorCode } = await import('@/lib/marketing/server/sender');

// A frozen clock: a run's timestamps are then exactly `now`, so they can be asserted.
const run = (now: Date = NOW_SEND, opts: { clock?: () => number } = {}) => runSendBatch(now, { clock: () => 0, ...opts });

const WINBACK_TEMPLATE = {
  name: 'hioc_winback_1',
  lang: 'en',
  vars: ['first_name', 'offer_text', 'code', 'valid_till'],
  url_button: true,
  body_preview: 'Hi {{1}}, {{2}}. Use code {{3}}, valid till {{4}}.',
};
const POINTS_TEMPLATE = {
  name: 'hioc_points_balance_1',
  lang: 'en',
  vars: ['first_name', 'points', 'points_value_inr'],
  url_button: true,
  body_preview: 'Hi {{1}}, you have {{2}} points worth ₹{{3}}.',
};
const PERCENT = { type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 };

let seq = 0;
const ph = (n: number) => `+9198765${String(10000 + n)}`;

function seedCampaign(db: FakeDb, over: Row = {}): Row {
  const row: Row = {
    id: 'camp-1',
    kind: 'playbook',
    playbook_key: 'winback_1',
    name: 'Win-back stage 1',
    status: 'approved',
    planned_for: '2026-10-05',
    send_after: null,
    audience: {},
    offer: PERCENT,
    template: WINBACK_TEMPLATE,
    projection: {},
    guardrail_flags: [],
    priority: 4,
    treated_count: 0,
    holdout_count: 0,
    started_at: null,
    completed_at: null,
    created_at: daysAgo(0),
    ...over,
  };
  (db.tables.marketing_campaigns ??= []).push(row);
  return row;
}

/** A queued treated recipient, opted in by default. */
function queue(db: FakeDb, phone: string, over: Row = {}, opts: { consent?: 'opted_in' | 'opted_out' | 'none' } = {}): Row {
  const n = ++seq;
  const row: Row = {
    id: `rec-${n}`,
    campaign_id: 'camp-1',
    phone,
    user_id: null,
    first_name: 'Asha',
    arm: 'treatment',
    status: 'queued',
    skip_reason: '',
    vars: { first_name: 'Asha', offer_text: '10% off (up to ₹60) on orders above ₹150', points: '120', points_value_inr: '120' },
    coupon_id: null,
    coupon_code: '',
    click_token: `tok${String(n).padStart(9, '0')}`,
    provider_ref: '',
    error: '',
    error_code: '',
    cost_inr: 0,
    attempts: 0,
    claimed_at: null,
    sent_at: null,
    created_at: new Date(NOW_SEND.getTime() - 60_000 + n).toISOString(),
    ...over,
  };
  (db.tables.marketing_recipients ??= []).push(row);
  const consent = opts.consent ?? 'opted_in';
  if (consent !== 'none' && !(db.tables.marketing_consent ?? []).some((c) => c.phone === phone)) {
    (db.tables.marketing_consent ??= []).push({ phone, status: consent, source: 'profile' });
  }
  return row;
}

const rec = (id: unknown) => rowsOf(h.db, 'marketing_recipients', (r) => r.id === id)[0];
const db = () => h.db;

beforeEach(() => {
  seq = 0;
  h.db = newDb();
  seedSettings(h.db);
  seedCampaign(h.db);
  h.send.mockReset();
  h.send.mockResolvedValue({ ok: true, providerRef: 'wamid.OK', error: '' });
  process.env.WHATSAPP_TOKEN = 'token';
  process.env.WHATSAPP_PHONE_ID = 'phone-id';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kill switch, window, interrupted rows', () => {
  it('does nothing at all with sending OFF', async () => {
    seedSettings(db(), { enabled: false });
    queue(db(), ph(1));
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ enabled: false, claimed: 0, sent: 0 });
    expect(h.send).not.toHaveBeenCalled();
    expect(rec('rec-1').status).toBe('queued');
  });

  it('does nothing when the settings row is missing', async () => {
    db().tables.marketing_settings = [];
    queue(db(), ph(1));
    expect(await run(NOW_SEND)).toMatchObject({ enabled: false, claimed: 0 });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('never sends outside the IST window, but still closes out stale sends', async () => {
    queue(db(), ph(1));
    queue(db(), ph(2), { status: 'sending', claimed_at: daysAgo(1, NOW_NIGHT) });
    const r = await run(NOW_NIGHT);
    expect(r).toMatchObject({ enabled: true, outside_window: true, claimed: 0, sent: 0, interrupted: 1 });
    expect(h.send).not.toHaveBeenCalled();
    expect(rec('rec-1').status).toBe('queued');
    expect(rec('rec-2').status).toBe('failed');
  });

  it('the window is IST: 10:59 is out, 11:00 is in, 19:59 is in, 20:00 is out', async () => {
    const at = (iso: string) => new Date(iso);
    queue(db(), ph(1));
    // 10:59 IST = 05:29 UTC
    expect(await run(at('2026-10-05T05:29:00.000Z'))).toMatchObject({ outside_window: true });
    // 20:00 IST = 14:30 UTC
    expect(await run(at('2026-10-05T14:30:00.000Z'))).toMatchObject({ outside_window: true });
    expect(h.send).not.toHaveBeenCalled();
    // 11:00 IST = 05:30 UTC
    expect(await run(at('2026-10-05T05:30:00.000Z'))).toMatchObject({ sent: 1 });
  });

  it('marks a stale sending row failed/interrupted — and never re-sends it', async () => {
    queue(db(), ph(1), { status: 'sending', claimed_at: new Date(NOW_SEND.getTime() - 16 * 60_000).toISOString(), attempts: 1 });
    queue(db(), ph(2), { status: 'sending', claimed_at: new Date(NOW_SEND.getTime() - 5 * 60_000).toISOString(), attempts: 1 });

    const r = await run(NOW_SEND);

    expect(r.interrupted).toBe(1);
    expect(rec('rec-1')).toMatchObject({ status: 'failed', error: 'interrupted', cost_inr: 0 });
    // Still within its 15 minutes: another run may be mid-send. Untouched.
    expect(rec('rec-2').status).toBe('sending');
    // The message may already be with Meta: it must NEVER be claimed again.
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a migration that is not applied is a no-op, not an error', async () => {
    db().setMissing('marketing_settings', true);
    expect(await run(NOW_SEND)).toEqual({ enabled: false, migration_missing: true, claimed: 0, sent: 0, skipped: 0, failed: 0, interrupted: 0 });
  });
});

describe('a successful send', () => {
  it('sends the frozen template with the recipient\'s values and records everything', async () => {
    queue(db(), ph(1), { vars: { first_name: 'Asha', offer_text: '10% off (up to ₹60) on orders above ₹150' } });

    const r = await run(NOW_SEND);

    expect(r).toMatchObject({ enabled: true, claimed: 1, sent: 1, skipped: 0, failed: 0, interrupted: 0 });
    expect(h.send).toHaveBeenCalledTimes(1);
    const input = h.send.mock.calls[0][0];
    expect(input).toMatchObject({ to: ph(1), channel: 'whatsapp', templateName: 'hioc_winback_1', templateLang: 'en' });
    // {{1}} name, {{2}} offer, {{3}} the coupon issued a moment ago, {{4}} its last day (IST): 10 days from 5 Oct.
    expect(input.templateVars[0]).toBe('Asha');
    expect(input.templateVars[1]).toBe('10% off (up to ₹60) on orders above ₹150');
    expect(input.templateVars[2]).toMatch(/^WB[A-HJ-NP-Z2-9]{6}$/);
    expect(input.templateVars[3]).toBe('15 Oct');
    // The URL button carries the recipient's own click token.
    expect(input.templateButtons).toEqual([{ index: 0, text: rec('rec-1').click_token }]);
    expect(input.body).toContain('Hi Asha');

    expect(rec('rec-1')).toMatchObject({
      status: 'sent',
      sent_at: NOW_SEND.toISOString(),
      // The attribution clock starts when the message left.
      reference_at: NOW_SEND.toISOString(),
      provider_ref: 'wamid.OK',
      cost_inr: 1.02,
      attempts: 1,
    });
  });

  it('omits the URL button when the template has none', async () => {
    seedCampaign(db(), { id: 'camp-2', template: { ...WINBACK_TEMPLATE, url_button: false } });
    db().tables.marketing_campaigns = db().tables.marketing_campaigns.filter((c) => c.id !== 'camp-1');
    queue(db(), ph(1), { campaign_id: 'camp-2' });
    await run(NOW_SEND);
    expect(h.send.mock.calls[0][0].templateButtons).toBeUndefined();
  });

  it('fails a recipient with no template name rather than sending a blank', async () => {
    db().tables.marketing_campaigns[0].template = { ...WINBACK_TEMPLATE, name: '' };
    queue(db(), ph(1));
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(rec('rec-1')).toMatchObject({ status: 'failed', error: 'no_template' });
    expect(h.send).not.toHaveBeenCalled();
    expect(rowsOf(db(), 'coupons')).toEqual([]);
  });
});

describe('monthly budget', () => {
  it('claims no more than the month can afford', async () => {
    seedSettings(db(), { monthly_budget_inr: 5 });
    // ₹3.06 already spent this IST month → ₹1.94 left → floor(1.94 / 1.02) = 1 message.
    for (let i = 0; i < 3; i++) queue(db(), ph(100 + i), { status: 'sent', sent_at: daysAgo(1), cost_inr: 1.02, campaign_id: 'old' });
    for (let i = 0; i < 4; i++) queue(db(), ph(i));

    const r = await run(NOW_SEND);

    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(rowsOf(db(), 'marketing_recipients', (x) => x.status === 'queued')).toHaveLength(3);
  });

  it('stops entirely, and says so, once the budget is spent', async () => {
    seedSettings(db(), { monthly_budget_inr: 3 });
    for (let i = 0; i < 3; i++) queue(db(), ph(100 + i), { status: 'sent', sent_at: daysAgo(1), cost_inr: 1.02, campaign_id: 'old' });
    queue(db(), ph(1));
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ claimed: 0, sent: 0, budget_exhausted: true });
    expect(h.send).not.toHaveBeenCalled();
    expect(rec('rec-4').status).toBe('queued');
  });

  it('last month\'s spend (IST) does not count against this month', async () => {
    seedSettings(db(), { monthly_budget_inr: 3 });
    // 23:30 IST on 30 Sep = 18:00 UTC — still September in India, so not October's money.
    for (let i = 0; i < 3; i++) queue(db(), ph(100 + i), { status: 'sent', sent_at: '2026-09-30T18:00:00.000Z', cost_inr: 1.02, campaign_id: 'old' });
    queue(db(), ph(1));
    expect(await run(NOW_SEND)).toMatchObject({ sent: 1 });
  });

  it('failed sends cost nothing against the budget', async () => {
    seedSettings(db(), { monthly_budget_inr: 3 });
    for (let i = 0; i < 5; i++) queue(db(), ph(100 + i), { status: 'failed', cost_inr: 0, campaign_id: 'old' });
    queue(db(), ph(1));
    expect(await run(NOW_SEND)).toMatchObject({ sent: 1 });
  });

  it('a message cost of 0 means the budget never binds', async () => {
    seedSettings(db(), { message_cost_inr: 0, monthly_budget_inr: 0 });
    queue(db(), ph(1));
    expect(await run(NOW_SEND)).toMatchObject({ sent: 1 });
  });
});

describe('daily cap', () => {
  it('sends only what is left of today\'s cap (IST day)', async () => {
    seedSettings(db(), { daily_send_cap: 3 });
    // Two sent today (after IST midnight = 18:30 UTC the day before)…
    queue(db(), ph(100), { status: 'sent', sent_at: '2026-10-04T19:00:00.000Z', cost_inr: 1.02, campaign_id: 'old' });
    queue(db(), ph(101), { status: 'delivered', sent_at: daysAgo(0.1), cost_inr: 1.02, campaign_id: 'old' });
    // …and one at 23:59 IST yesterday, which is yesterday's cap.
    queue(db(), ph(102), { status: 'sent', sent_at: '2026-10-04T18:29:00.000Z', cost_inr: 1.02, campaign_id: 'old' });
    for (let i = 0; i < 4; i++) queue(db(), ph(i));

    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
  });

  it('sends nothing once the cap is reached', async () => {
    seedSettings(db(), { daily_send_cap: 1 });
    queue(db(), ph(100), { status: 'sent', sent_at: daysAgo(0.1), cost_inr: 1.02, campaign_id: 'old' });
    queue(db(), ph(1));
    expect(await run(NOW_SEND)).toMatchObject({ claimed: 0 });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a batch is at most 50 messages', async () => {
    seedSettings(db(), { daily_send_cap: 10000, monthly_budget_inr: 100000 });
    for (let i = 0; i < 60; i++) queue(db(), ph(i));
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ claimed: 50, sent: 50 });
    expect(rowsOf(db(), 'marketing_recipients', (x) => x.status === 'queued')).toHaveLength(10);
  });

  it('never leaves claimed rows stranded when it runs out of time: unclaimed rows just wait', async () => {
    seedSettings(db(), { daily_send_cap: 10000, monthly_budget_inr: 100000 });
    for (let i = 0; i < 30; i++) queue(db(), ph(i));
    let t = 0;
    const r = await run(NOW_SEND, { clock: () => (t += 20_000) });
    expect(r.claimed).toBeLessThan(30);
    expect(rowsOf(db(), 'marketing_recipients', (x) => x.status === 'sending')).toEqual([]);
    expect(r.claimed).toBe(r.sent);
    expect(rowsOf(db(), 'marketing_recipients', (x) => x.status === 'queued')).toHaveLength(30 - r.claimed);
  });
});

describe('long runs and overlapping runs', () => {
  it('re-reads the budget before every chunk, so an overlapping run\'s sends are seen', async () => {
    seedSettings(db(), { monthly_budget_inr: 20, daily_send_cap: 1000 });
    for (let i = 0; i < 30; i++) queue(db(), ph(i));
    let calls = 0;
    h.send.mockImplementation(async () => {
      // The 10th send finishes the first chunk. Meanwhile ANOTHER run spends nearly everything that is left.
      if (++calls === 10) queue(db(), ph(900), { status: 'sent', sent_at: daysAgo(0.01), cost_inr: 9.5, campaign_id: 'other-run' });
      return { ok: true, providerRef: `wamid.${calls}`, error: '' };
    });
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ claimed: 10, sent: 10, budget_exhausted: true });
    expect(rowsOf(db(), 'marketing_recipients', (x) => x.status === 'queued')).toHaveLength(20);
  });

  it('re-reads the daily cap before every chunk too', async () => {
    seedSettings(db(), { daily_send_cap: 12, monthly_budget_inr: 100000 });
    for (let i = 0; i < 30; i++) queue(db(), ph(i));
    let calls = 0;
    h.send.mockImplementation(async () => {
      if (++calls === 10) {
        queue(db(), ph(900), { status: 'sent', sent_at: daysAgo(0.01), cost_inr: 1.02, campaign_id: 'other-run' });
        queue(db(), ph(901), { status: 'sent', sent_at: daysAgo(0.01), cost_inr: 1.02, campaign_id: 'other-run' });
      }
      return { ok: true, providerRef: `wamid.${calls}`, error: '' };
    });
    const r = await run(NOW_SEND);
    // 10 sent by this run + 2 by the other = 12: the cap is reached, the second chunk claims nothing.
    expect(r).toMatchObject({ claimed: 10, sent: 10 });
  });

  it('does not carry a long run past the end of its send window', async () => {
    seedSettings(db(), { daily_send_cap: 1000, monthly_budget_inr: 100000 });
    for (let i = 0; i < 30; i++) queue(db(), ph(i));
    // 19:59:55 IST; the run's own clock advances 1 s per read, so the first chunk ends after 20:00.
    let t = 0;
    const r = await run(new Date('2026-10-05T14:29:55.000Z'), { clock: () => (t += 1000) });
    expect(r.claimed).toBe(10);
    expect(rowsOf(db(), 'marketing_recipients', (x) => x.status === 'queued')).toHaveLength(20);
  });
});

describe('consent and rules are re-checked at SEND time', () => {
  it('skips a customer who withdrew consent after approval — no coupon, no message', async () => {
    queue(db(), ph(1), {}, { consent: 'opted_out' });
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(rec('rec-1')).toMatchObject({ status: 'skipped', skip_reason: 'not_opted_in' });
    expect(h.send).not.toHaveBeenCalled();
    expect(rowsOf(db(), 'coupons')).toEqual([]);
  });

  it('skips a phone that has no consent row at all', async () => {
    queue(db(), ph(1), {}, { consent: 'none' });
    await run(NOW_SEND);
    expect(rec('rec-1')).toMatchObject({ status: 'skipped', skip_reason: 'not_opted_in' });
  });

  it('a whatsapp_opt_outs row beats an opted-in ledger', async () => {
    queue(db(), ph(1));
    (db().tables.whatsapp_opt_outs ??= []).push({ phone: ph(1), source: 'stop_keyword' });
    await run(NOW_SEND);
    expect(rec('rec-1')).toMatchObject({ status: 'skipped', skip_reason: 'not_opted_in' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('skips a number that is not a valid Indian mobile', async () => {
    queue(db(), '+4479460958', {});
    await run(NOW_SEND);
    expect(rec('rec-1')).toMatchObject({ status: 'skipped', skip_reason: 'invalid_phone' });
  });

  it('skips a phone messaged within min_days_between (too_soon)', async () => {
    queue(db(), ph(1), { status: 'delivered', sent_at: daysAgo(2), campaign_id: 'old' });
    queue(db(), ph(1));
    await run(NOW_SEND);
    expect(rec('rec-2')).toMatchObject({ status: 'skipped', skip_reason: 'too_soon' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a message exactly min_days_between ago no longer counts', async () => {
    queue(db(), ph(1), { status: 'sent', sent_at: daysAgo(7), campaign_id: 'old' });
    queue(db(), ph(1));
    expect(await run(NOW_SEND)).toMatchObject({ sent: 1 });
  });

  it('skips a phone at its 30-day limit (monthly_cap)', async () => {
    for (const [i, days] of [8, 15, 22, 29].entries()) queue(db(), ph(1), { status: 'sent', sent_at: daysAgo(days), campaign_id: `old-${i}` });
    queue(db(), ph(1));
    await run(NOW_SEND);
    expect(rec('rec-5')).toMatchObject({ status: 'skipped', skip_reason: 'monthly_cap' });
  });

  it('two queued messages to one phone in the same batch: the second sees the first (too_soon)', async () => {
    seedCampaign(db(), { id: 'camp-2', priority: 5 });
    queue(db(), ph(1), { campaign_id: 'camp-1' });
    queue(db(), ph(1), { campaign_id: 'camp-2' });
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ claimed: 2, sent: 1, skipped: 1 });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(rec('rec-2')).toMatchObject({ status: 'skipped', skip_reason: 'too_soon' });
  });

  it('a campaign cancelled between claim and send does not send', async () => {
    queue(db(), ph(1));
    // The owner cancels while the batch is running: the campaign changes right after the claim.
    const realRpc = h.db.client.rpc.bind(h.db.client);
    h.db.client.rpc = async (name: string, args?: Row) => {
      const res = await realRpc(name, args);
      h.db.tables.marketing_campaigns[0].status = 'cancelled';
      return res;
    };
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(h.send).not.toHaveBeenCalled();
    expect(rec('rec-1').status).toBe('cancelled');
    expect(rowsOf(db(), 'coupons')).toEqual([]);
  });

  it('a queued recipient of a CANCELLED campaign is never claimed', async () => {
    db().tables.marketing_campaigns[0].status = 'cancelled';
    queue(db(), ph(1));
    expect(await run(NOW_SEND)).toMatchObject({ claimed: 0 });
  });

  it('honours send_after: nothing is claimed before it', async () => {
    db().tables.marketing_campaigns[0].send_after = new Date(NOW_SEND.getTime() + DAY).toISOString();
    queue(db(), ph(1));
    expect(await run(NOW_SEND)).toMatchObject({ claimed: 0 });
  });

  it('puts a row back in the queue when consent cannot be read, instead of guessing', async () => {
    queue(db(), ph(1));
    db().failNext('select marketing_consent');
    const r = await run(NOW_SEND);
    expect(r.sent).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(rec('rec-1').status).toBe('queued');
  });

  it('gives up on a row whose consent check keeps failing', async () => {
    queue(db(), ph(1), { attempts: 2 });
    db().failNext('select marketing_consent');
    await run(NOW_SEND);
    expect(rec('rec-1')).toMatchObject({ status: 'failed', error: 'consent_check_failed' });
  });
});

describe('WhatsApp not configured', () => {
  it('skips with not_configured — never sends, never issues a coupon', async () => {
    delete process.env.WHATSAPP_TOKEN;
    queue(db(), ph(1));
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(rec('rec-1')).toMatchObject({ status: 'skipped', skip_reason: 'not_configured' });
    expect(h.send).not.toHaveBeenCalled();
    expect(rowsOf(db(), 'coupons')).toEqual([]);
  });

  it('needs the phone id too', async () => {
    delete process.env.WHATSAPP_PHONE_ID;
    queue(db(), ph(1));
    await run(NOW_SEND);
    expect(rec('rec-1').skip_reason).toBe('not_configured');
  });
});

describe('coupons: issued at send, locked to the phone, deactivated on failure', () => {
  it('issues one single-use phone-locked coupon only when it sends', async () => {
    queue(db(), ph(1));
    await run(NOW_SEND);

    const [c] = rowsOf(db(), 'coupons');
    expect(c).toMatchObject({
      discount_type: 'percent',
      discount_value: 10,
      max_discount_inr: 60,
      min_order_inr: 150,
      scope: {},
      usage_limit: 1,
      per_user_limit: 1,
      is_auto: false,
      active: true,
      campaign_id: 'camp-1',
      assigned_phone: ph(1),
      description: 'Marketing: Win-back stage 1',
      valid_from: NOW_SEND.toISOString(),
    });
    expect(c.code).toMatch(/^WB[A-HJ-NP-Z2-9]{6}$/);
    // Valid through the end of the IST day 10 days out: 15 Oct 23:59:59.999 IST = 18:29:59.999 UTC.
    expect(c.valid_to).toBe('2026-10-15T18:29:59.999Z');
    expect(rec('rec-1')).toMatchObject({ coupon_id: c.id, coupon_code: c.code });
  });

  it('gives every recipient a DIFFERENT code', async () => {
    for (let i = 0; i < 6; i++) queue(db(), ph(i));
    await run(NOW_SEND);
    const codes = rowsOf(db(), 'coupons').map((c) => c.code);
    expect(codes).toHaveLength(6);
    expect(new Set(codes).size).toBe(6);
  });

  it('uses the manual prefix for a manual campaign and none at all for a points campaign', async () => {
    db().tables.marketing_campaigns = [];
    seedCampaign(db(), { id: 'manual-1', kind: 'manual', playbook_key: null });
    seedCampaign(db(), { id: 'points-1', playbook_key: 'points_balance', offer: { type: 'none' }, template: POINTS_TEMPLATE });
    queue(db(), ph(1), { campaign_id: 'manual-1' });
    queue(db(), ph(2), { campaign_id: 'points-1' });
    await run(NOW_SEND);
    const coupons = rowsOf(db(), 'coupons');
    expect(coupons).toHaveLength(1);
    expect(coupons[0].code).toMatch(/^OF/);
    expect(coupons[0].assigned_phone).toBe(ph(1));
    // The points reminder went out with no code and no coupon.
    const pointsCall = h.send.mock.calls.find((c) => c[0].to === ph(2))![0];
    expect(pointsCall.templateName).toBe('hioc_points_balance_1');
    expect(pointsCall.templateVars).toEqual(['Asha', '120', '120']);
  });

  it('a free item becomes a flat coupon for its price, scoped to the item, minimum INCLUDING the item', async () => {
    db().tables.marketing_campaigns[0].offer = {
      type: 'free_item', item_id: 'item-1', variant_id: 'var-1', max_item_price: 250, min_order_inr: 200, validity_days: 10,
      item_name: 'Cold Coffee', variant_label: 'Regular', price_inr: 180, cost_inr: 45,
    };
    queue(db(), ph(1), { vars: { first_name: 'Asha', offer_text: 'a FREE Cold Coffee with any order above ₹200' } });
    await run(NOW_SEND);
    expect(rowsOf(db(), 'coupons')[0]).toMatchObject({
      discount_type: 'flat', discount_value: 180, max_discount_inr: 180, min_order_inr: 380, scope: { item_ids: ['item-1'] },
    });
  });

  it('fails a recipient whose offer cannot be issued (an unresolved free item) — no coupon, no message', async () => {
    db().tables.marketing_campaigns[0].offer = { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 };
    queue(db(), ph(1));
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(rec('rec-1')).toMatchObject({ status: 'failed', error: 'offer_not_issuable' });
    expect(h.send).not.toHaveBeenCalled();
    expect(rowsOf(db(), 'coupons')).toEqual([]);
  });

  it('retries a code collision with a fresh code', async () => {
    queue(db(), ph(1));
    db().failNext('insert coupons', { code: '23505', message: 'duplicate key' });
    db().failNext('insert coupons', { code: '23505', message: 'duplicate key' });
    expect(await run(NOW_SEND)).toMatchObject({ sent: 1 });
    expect(rowsOf(db(), 'coupons')).toHaveLength(1);
  });

  it('gives up after 3 collisions, failing the recipient without a message', async () => {
    queue(db(), ph(1));
    for (let i = 0; i < 3; i++) db().failNext('insert coupons', { code: '23505', message: 'duplicate key' });
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(rec('rec-1').status).toBe('failed');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('never issues an UNLOCKED coupon: without the assigned_phone column the recipient fails', async () => {
    h.db = newDb({ missingColumns: { coupons: ['assigned_phone'] } });
    seedSettings(h.db);
    seedCampaign(h.db);
    queue(h.db, ph(1));
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(rowsOf(h.db, 'coupons')).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('DEACTIVATES the coupon when the send fails, so no live code outlasts a message nobody got', async () => {
    h.send.mockResolvedValue({ ok: false, providerRef: '', error: '(#132001) Template name does not exist in the translation' });
    queue(db(), ph(1));
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(rowsOf(db(), 'coupons')[0].active).toBe(false);
    expect(rec('rec-1')).toMatchObject({ status: 'failed', error_code: '132001', cost_inr: 0 });
  });

  it('deactivates the coupon when the adapter throws', async () => {
    h.send.mockRejectedValue(new Error('socket hang up'));
    queue(db(), ph(1));
    await run(NOW_SEND);
    expect(rowsOf(db(), 'coupons')[0].active).toBe(false);
    expect(rec('rec-1')).toMatchObject({ status: 'failed', error: 'socket hang up' });
  });
});

describe('unexpected exceptions', () => {
  /** Makes an `update` on `table` throw when its payload satisfies `when` — a stand-in for a dropped connection. */
  function throwOnUpdate(table: string, when: (patch: Row) => boolean) {
    const realFrom = h.db.client.from.bind(h.db.client);
    h.db.client.from = (t: string) => {
      const chain = realFrom(t) as { update: (p: Row) => unknown };
      if (t === table) {
        const update = chain.update.bind(chain);
        chain.update = (patch: Row) => {
          if (when(patch)) throw new Error('connection reset');
          return update(patch);
        };
      }
      return chain;
    };
  }

  it('a failure BEFORE the message leaves deactivates the coupon it had just issued, and sends nothing', async () => {
    queue(db(), ph(1));
    throwOnUpdate('marketing_recipients', (p) => 'coupon_id' in p);
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(h.send).not.toHaveBeenCalled();
    expect(rowsOf(db(), 'coupons')[0].active).toBe(false);
    expect(rec('rec-1')).toMatchObject({ status: 'failed', error: 'connection reset' });
  });

  it('a failure AFTER the message left (campaign bookkeeping) never turns a sent message into a failed one', async () => {
    queue(db(), ph(1));
    throwOnUpdate('marketing_campaigns', (p) => 'started_at' in p);
    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(rec('rec-1').status).toBe('sent');
    // The coupon it carried is live: the customer has the code.
    expect(rowsOf(db(), 'coupons')[0].active).toBe(true);
  });
});

describe('Meta failures', () => {
  it('parses the code out of Meta\'s message', () => {
    expect(parseMetaErrorCode('(#131049) This message was not delivered to maintain healthy ecosystem engagement')).toBe('131049');
    expect(parseMetaErrorCode('(#131050) User opted out of marketing')).toBe('131050');
    expect(parseMetaErrorCode('Invalid OAuth token')).toBe('');
    expect(parseMetaErrorCode('')).toBe('');
  });

  it('131049 (Meta\'s per-user marketing cap): failed, cost 0, and never retried', async () => {
    h.send.mockResolvedValue({ ok: false, providerRef: '', error: '(#131049) This message was not delivered to maintain healthy ecosystem engagement' });
    queue(db(), ph(1));

    const r = await run(NOW_SEND);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(rec('rec-1')).toMatchObject({ status: 'failed', error_code: '131049', cost_inr: 0, sent_at: null });

    // A later run must not pick it up again.
    await run(NOW_SEND);
    expect(h.send).toHaveBeenCalledTimes(1);
    // …and it is not an opt-out: the customer did not ask for anything.
    expect(rowsOf(db(), 'marketing_consent')[0].status).toBe('opted_in');
  });

  it('131050 (the customer tapped "Stop promotions") also OPTS THEM OUT and cancels their other queued messages', async () => {
    h.send.mockResolvedValue({ ok: false, providerRef: '', error: '(#131050) The user has chosen to stop receiving marketing messages' });
    seedCampaign(db(), { id: 'camp-2' });
    queue(db(), ph(1), { campaign_id: 'camp-1', user_id: 'u1' });
    queue(db(), ph(1), { campaign_id: 'camp-2' });

    const r = await run(NOW_SEND);

    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(rowsOf(db(), 'marketing_consent')[0]).toMatchObject({ phone: ph(1), status: 'opted_out', source: 'meta_131050' });
    expect(rowsOf(db(), 'whatsapp_opt_outs')[0]).toMatchObject({ phone: ph(1), source: 'marketing:meta_131050' });
    expect(rowsOf(db(), 'marketing_consent_events')[0]).toMatchObject({ action: 'opt_out', source: 'meta_131050' });
    // Its second queued message never goes out (cancelled by the opt-out, or skipped at send).
    expect(['cancelled', 'skipped']).toContain(rec('rec-2').status);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('other Meta errors are plain failures: cost 0, code kept, no opt-out', async () => {
    h.send.mockResolvedValue({ ok: false, providerRef: '', error: '(#131026) Message undeliverable' });
    queue(db(), ph(1));
    await run(NOW_SEND);
    expect(rec('rec-1')).toMatchObject({ status: 'failed', error_code: '131026', cost_inr: 0 });
    expect(rowsOf(db(), 'marketing_consent')[0].status).toBe('opted_in');
  });
});

describe('campaign lifecycle', () => {
  it('the first send starts the campaign and starts the holdout\'s attribution clock', async () => {
    queue(db(), ph(1));
    queue(db(), ph(2), { arm: 'holdout', status: 'holdout', click_token: null });
    queue(db(), ph(3));

    await run(NOW_SEND);

    const c = db().tables.marketing_campaigns[0];
    expect(c.started_at).toBe(NOW_SEND.toISOString());
    // Both sent, nothing left to send → completed in the same run.
    expect(c.status).toBe('completed');
    expect(c.completed_at).toBe(NOW_SEND.toISOString());
    expect(rec('rec-2')).toMatchObject({ status: 'holdout', reference_at: NOW_SEND.toISOString() });
  });

  it('stays "sending" while recipients remain, and does not restart the clock later', async () => {
    seedSettings(db(), { daily_send_cap: 1 });
    queue(db(), ph(1));
    queue(db(), ph(2));
    await run(NOW_SEND);
    const c = db().tables.marketing_campaigns[0];
    expect(c).toMatchObject({ status: 'sending', started_at: NOW_SEND.toISOString(), completed_at: null });

    // Next day the cap resets; the second message goes and the campaign completes.
    seedSettings(db(), { daily_send_cap: 5 });
    const later = new Date(NOW_SEND.getTime() + DAY);
    db().tables.marketing_recipients[0].sent_at = daysAgo(1, later); // (already outside "today")
    await run(later);
    expect(c.status).toBe('completed');
    expect(c.started_at).toBe(NOW_SEND.toISOString());
  });

  it('completes an approved campaign whose queue was emptied by opt-outs, even though nothing was sent', async () => {
    db().tables.marketing_recipients = [];
    queue(db(), ph(1), { status: 'cancelled', skip_reason: 'opted_out' });
    await run(NOW_SEND);
    expect(db().tables.marketing_campaigns[0]).toMatchObject({ status: 'completed', started_at: null });
  });

  it('claims recipients of the higher-priority campaign first', async () => {
    seedSettings(db(), { daily_send_cap: 1 });
    seedCampaign(db(), { id: 'camp-hi', priority: 1 });
    queue(db(), ph(1), { campaign_id: 'camp-1' });
    queue(db(), ph(2), { campaign_id: 'camp-hi' });
    await run(NOW_SEND);
    expect(h.send.mock.calls[0][0].to).toBe(ph(2));
  });
});
