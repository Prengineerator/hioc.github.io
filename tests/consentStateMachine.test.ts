import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FakeDb } from './helpers/marketingDb';
import { NOW_SEND, newDb, rowsOf } from './helpers/marketingWorld';

// Marketing consent as an explicit machine (lib/marketing/consentState.ts), the ONE
// "opted out?" predicate, write ordering that errs towards not messaging, and the
// webhook paths that go through it: STOP via consent.ts, the marketing receipt ladder
// on the shared notifications ladder, and a reply reopening a resolved feedback thread.

const APP_SECRET = 'app-secret-for-tests';
const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, send: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/notifications/adapters', () => ({ whatsappAdapter: { send: h.send } }));
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve({ google_review_url: 'https://g.page/r/test/review' }) }));

const cs = await import('@/lib/marketing/consentState');
const { recordOptIn, recordOptOut, loadOptedOutPhones } = await import('@/lib/marketing/server/consent');
const { evaluateContact } = await import('@/lib/marketing/eligibility');
const { POST } = await import('@/app/api/webhooks/whatsapp/route');

const PHONE = '+919876543210';
const WA = '919876543210';
const db = () => h.db;
const ledger = () => rowsOf(db(), 'marketing_consent', (r) => r.phone === PHONE)[0];
const optOuts = () => rowsOf(db(), 'whatsapp_opt_outs');
const events = () => rowsOf(db(), 'marketing_consent_events');

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  h.db = newDb({ startMs: NOW_SEND.getTime() });
  h.db.tables.profiles = [{ id: 'u1', phone: PHONE, phone_verified: true, marketing_consent: false }];
  h.send.mockReset();
  h.send.mockResolvedValue({ ok: true, providerRef: 'wamid.REPLY', error: '' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
describe('the composite state and its one predicate', () => {
  it.each([
    [{ ledger: 'opted_in', optOutListed: false }, 'opted_in'],
    [{ ledger: 'opted_in', optOutListed: true }, 'opted_out'],
    [{ ledger: 'opted_out', optOutListed: false }, 'opted_out'],
    [{ ledger: 'none', optOutListed: true }, 'opted_out'],
    [{ ledger: null, optOutListed: false }, 'no_consent'],
  ] as const)('%j → %s', (facts, want) => {
    expect(cs.compositeConsent(facts)).toBe(want);
    expect(cs.isOptedOut(facts)).toBe(want === 'opted_out');
    expect(cs.mayMarketTo(facts)).toBe(want === 'opted_in');
  });

  it("is exactly evaluateContact's rule 1 (so the marketing gate and this predicate cannot drift)", () => {
    const ctx = {
      now: NOW_SEND,
      settings: { min_days_between: 7, max_per_30_days: 4, pause_after_unread: 3, attribution_days: 7 },
      receipts_connected: false,
    };
    for (const consent_opted_in of [true, false]) {
      for (const opt_out_listed of [true, false]) {
        const contact = { phone: PHONE, role: 'customer', consent_opted_in, opt_out_listed };
        const r = evaluateContact(contact, [], ctx);
        const blockedByConsent = !r.eligible && r.reason === 'not_opted_in';
        expect(blockedByConsent).toBe(!cs.mayMarketTo(cs.factsFromContact(contact)));
      }
    }
  });
});

describe('the ledger transition table', () => {
  it('only the customer\'s own acts opt in; the owner may only opt out', () => {
    expect(cs.sourceAllowedFor('opt_in', 'owner')).toBe(false);
    expect(cs.sourceAllowedFor('opt_in', 'stop_keyword')).toBe(false);
    expect(cs.sourceAllowedFor('opt_out', 'owner')).toBe(true);
    expect(cs.sourceAllowedFor('opt_out', 'whatsapp_keyword')).toBe(false);
    for (const s of ['profile', 'whatsapp_keyword', 'meta_resume'] as const) expect(cs.sourceAllowedFor('opt_in', s)).toBe(true);
  });

  it('a repeat opt-in is flagged as a repeat; a re-opt-in after an opt-out is not', () => {
    expect(cs.canTransitionConsent('opted_in', 'opt_in', { source: 'profile' })).toEqual({ ok: true, to: 'opted_in', repeat: true });
    expect(cs.canTransitionConsent('opted_out', 'opt_in', { source: 'profile' })).toEqual({ ok: true, to: 'opted_in', repeat: false });
    expect(cs.canTransitionConsent('none', 'opt_in', { source: 'meta_resume' })).toMatchObject({ ok: false, code: 'no_prior_opt_in' });
    for (const from of ['none', 'opted_in', 'opted_out'] as const) {
      expect(cs.canTransitionConsent(from, 'opt_out', { source: 'stop_keyword' })).toMatchObject({ ok: true, to: 'opted_out' });
    }
  });
});

// ---------------------------------------------------------------------------
describe('recordOptIn', () => {
  it('a repeat opt-in keeps the consent in force: consented_at and source unchanged, no second event', async () => {
    db().tables.marketing_consent = [{ phone: PHONE, user_id: 'u1', status: 'opted_in', source: 'profile', consented_at: '2026-09-01T00:00:00.000Z', withdrawn_at: null }];
    const r = await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword', now: NOW_SEND });
    expect(r).toMatchObject({ ok: true, changed: false, skipped: 'already_opted_in' });
    expect(ledger()).toMatchObject({ status: 'opted_in', source: 'profile', consented_at: '2026-09-01T00:00:00.000Z' });
    expect(events()).toEqual([]);
  });

  it('a re-opt-in after an opt-out IS a new consent: consented_at moves', async () => {
    db().tables.marketing_consent = [{ phone: PHONE, status: 'opted_out', source: 'stop_keyword', consented_at: '2026-09-01T00:00:00.000Z' }];
    await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword', now: NOW_SEND });
    expect(ledger()).toMatchObject({ status: 'opted_in', source: 'whatsapp_keyword', consented_at: NOW_SEND.toISOString() });
    expect(events().map((e) => e.action)).toEqual(['opt_in']);
  });

  it('refuses an opt-out-only source and writes nothing', async () => {
    const r = await recordOptIn({ phone: PHONE, source: 'owner' });
    expect(r).toMatchObject({ ok: false, migration_missing: false });
    expect(db().log).toEqual([]);
  });

  it('clears the opt-out LAST: every other write comes first', async () => {
    db().tables.whatsapp_opt_outs = [{ phone: PHONE, source: 'stop_keyword' }];
    await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    expect(db().log[db().log.length - 1]).toBe('delete whatsapp_opt_outs');
  });

  it('a STOP that races a START (lands between its ledger write and its opt-out delete) still wins', async () => {
    db().tables.marketing_consent = [{ phone: PHONE, status: 'opted_out', source: 'stop_keyword' }];
    db().tables.whatsapp_opt_outs = [{ phone: PHONE, source: 'stop_keyword' }];
    // The STOP's own writes complete just before the START deletes the opt-out row.
    db().beforeNext('delete whatsapp_opt_outs', () => {
      ledger().status = 'opted_out';
    });
    await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    // The START deleted the opt-out row — but the ledger says stop, and that is enough.
    expect(optOuts()).toEqual([]);
    expect(await loadOptedOutPhones(db().client as never, [PHONE])).toEqual(new Set([PHONE]));
  });
});

describe('recordOptOut', () => {
  it('writes the shared opt-out table FIRST', async () => {
    db().tables.marketing_consent = [{ phone: PHONE, status: 'opted_in', source: 'profile' }];
    await recordOptOut({ phone: PHONE, source: 'stop_keyword' });
    expect(db().log[0]).toBe('upsert whatsapp_opt_outs');
    expect(db().log.indexOf('upsert whatsapp_opt_outs')).toBeLessThan(db().log.indexOf('upsert marketing_consent'));
  });

  it('a failed ledger write still leaves the phone opted out', async () => {
    db().tables.marketing_consent = [{ phone: PHONE, status: 'opted_in', source: 'profile' }];
    db().failNext('upsert marketing_consent');
    const r = await recordOptOut({ phone: PHONE, source: 'stop_keyword' });
    expect(r.ok).toBe(false);
    expect(ledger().status).toBe('opted_in');
    expect(await loadOptedOutPhones(db().client as never, [PHONE])).toEqual(new Set([PHONE]));
  });

  it('refuses an opt-in-only source', async () => {
    expect(await recordOptOut({ phone: PHONE, source: 'whatsapp_keyword' })).toMatchObject({ ok: false });
    expect(db().log).toEqual([]);
  });
});

describe('loadOptedOutPhones — the feedback cron\'s check', () => {
  it('a STOP that survives only in the ledger counts (the cron used to read only the opt-out table)', async () => {
    db().tables.marketing_consent = [{ phone: PHONE, status: 'opted_out' }];
    expect(await loadOptedOutPhones(db().client as never, [PHONE, '+919111111111'])).toEqual(new Set([PHONE]));
  });

  it('a legacy opt-out stored without its plus, or as the bare number, counts', async () => {
    db().tables.whatsapp_opt_outs = [{ phone: '9876543210', source: 'legacy' }];
    expect(await loadOptedOutPhones(db().client as never, [PHONE])).toEqual(new Set([PHONE]));
  });

  it('an opted-in ledger with no opt-out row is not opted out', async () => {
    db().tables.marketing_consent = [{ phone: PHONE, status: 'opted_in' }];
    expect(await loadOptedOutPhones(db().client as never, [PHONE])).toEqual(new Set());
  });

  it('with the marketing ledger missing it falls back to the opt-out table alone', async () => {
    db().setMissing('marketing_consent', true);
    db().tables.whatsapp_opt_outs = [{ phone: PHONE, source: 'stop_keyword' }];
    expect(await loadOptedOutPhones(db().client as never, [PHONE, '+919111111111'])).toEqual(new Set([PHONE]));
  });

  it('throws when the opt-out table cannot be read, so the caller messages nobody it could not check', async () => {
    db().failNext('select whatsapp_opt_outs');
    await expect(loadOptedOutPhones(db().client as never, [PHONE])).rejects.toThrow(/whatsapp_opt_outs/);
  });
});

// ---------------------------------------------------------------------------
const wrap = (value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1' }, ...value } }] }],
});
const text = (id: string, body: string) => wrap({ messages: [{ id, from: WA, type: 'text', text: { body } }] });
const statuses = (...s: { id: string; status: string; errors?: unknown[] }[]) =>
  wrap({ statuses: s.map((x) => ({ timestamp: '1759650000', recipient_id: WA, ...x })) });
function post(body: unknown) {
  const raw = JSON.stringify(body);
  const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex')}`;
  return POST(new Request('http://t/api/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw }));
}

describe('webhook — STOP goes through consent.ts', () => {
  it('writes the opt-out row exactly once, before the ledger, with the source it always had', async () => {
    db().tables.marketing_consent = [{ phone: PHONE, status: 'opted_in', source: 'profile' }];
    await post(text('wamid.STOP-A', 'STOP'));
    expect(db().log.filter((l) => l === 'upsert whatsapp_opt_outs')).toHaveLength(1);
    expect(db().log.indexOf('upsert whatsapp_opt_outs')).toBeLessThan(db().log.indexOf('upsert marketing_consent'));
    expect(optOuts()).toEqual([expect.objectContaining({ phone: PHONE, source: 'stop_keyword' })]);
    expect(ledger()).toMatchObject({ status: 'opted_out', source: 'stop_keyword' });
  });
});

describe('webhook — marketing receipts climb the SHARED ladder', () => {
  const REF = 'wamid.MKT-1';
  const recipient = () => rowsOf(db(), 'marketing_recipients', (r) => r.id === 'r1')[0];
  const seed = (status: string) => {
    db().tables.marketing_recipients = [
      { id: 'r1', campaign_id: 'c1', phone: PHONE, user_id: 'u1', status, provider_ref: REF, delivered_at: null, read_at: null, cost_inr: 0, error: '131026: Undeliverable', error_code: '131026' },
    ];
  };

  it("a 'delivered' after a 'failed' is applied — proof of delivery beats a claim it could not be sent (as for notifications)", async () => {
    seed('failed');
    const res = await post(statuses({ id: REF, status: 'delivered' }));
    expect(await res.json()).toMatchObject({ applied: 1 });
    expect(recipient()).toMatchObject({ status: 'delivered', delivered_at: expect.any(String), error: '131026: Undeliverable' });
  });

  it("a 'failed' still never overwrites delivered/read, and 'sent' stays the sender's to record", async () => {
    seed('delivered');
    expect(await (await post(statuses({ id: REF, status: 'failed', errors: [{ code: 1, title: 'x' }] }))).json()).toMatchObject({ ignored: 1 });
    seed('sending');
    expect(await (await post(statuses({ id: REF, status: 'sent' }))).json()).toMatchObject({ ignored: 1 });
    expect(recipient().status).toBe('sending');
  });

  it('a pre-send recipient (approved, waiting) is never moved by a receipt', async () => {
    seed('queued');
    await post(statuses({ id: REF, status: 'delivered' }));
    expect(recipient().status).toBe('queued');
  });
});

describe('webhook — a reply on a resolved feedback thread reopens it', () => {
  it('typed text after "resolved" puts the thread back in the attention view', async () => {
    db().tables.feedback_requests = [
      { id: 'req-1', order_id: 'order-1', phone: PHONE, thread_status: 'resolved', unread: false, last_inbound_at: null, created_at: '2026-10-01T00:00:00.000Z' },
    ];
    await post(text('wamid.TXT-1', 'actually the coffee was cold'));
    expect(rowsOf(db(), 'feedback_requests')[0]).toMatchObject({ thread_status: 'open', unread: true });
  });
});
