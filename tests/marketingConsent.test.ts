import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/marketingDb';
import { NOW_SEND, newDb, rowsOf } from './helpers/marketingWorld';

// Marketing consent (spec §2). The ledger, the shared opt-out table the feedback cron
// honours, the profile checkbox and the pending queue must move together — and an
// opt-out must be total. These run the REAL lib/marketing/server/consent.ts against an
// in-memory database.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));

const { isOptInKeyword, isStopPromotionsButton, loadConsentState, recordOptIn, recordOptOut } = await import(
  '@/lib/marketing/server/consent'
);

const PHONE = '+919876543210';

beforeEach(() => {
  h.db = newDb();
  h.db.tables.profiles = [
    { id: 'u1', phone: PHONE, phone_verified: true, marketing_consent: false, role: 'customer' },
    // An UNVERIFIED account typing the same number must never be touched.
    { id: 'u2', phone: PHONE, phone_verified: false, marketing_consent: false, role: 'customer' },
  ];
});

describe('keyword recognition', () => {
  it.each(['START', 'start', ' Subscribe ', 'OFFERS', 'unstop', '\nUNSTOP\t'])('%j opts in', (text) => {
    expect(isOptInKeyword(text)).toBe(true);
  });

  it.each(['please start my order', 'starts', 'START please', '', 'stop', null, undefined])('%j does not', (text) => {
    expect(isOptInKeyword(text as string)).toBe(false);
  });

  it('matches Meta\'s marketing opt-out button by its label, case-insensitively', () => {
    expect(isStopPromotionsButton('Stop promotions')).toBe(true);
    expect(isStopPromotionsButton('  STOP PROMOTIONS ')).toBe(true);
    expect(isStopPromotionsButton('Stop')).toBe(false);
    expect(isStopPromotionsButton('Loved it')).toBe(false);
    expect(isStopPromotionsButton(undefined)).toBe(false);
  });
});

describe('recordOptIn', () => {
  it('writes the ledger, clears the opt-out, mirrors the verified profile and logs an event', async () => {
    h.db.tables.whatsapp_opt_outs = [{ phone: PHONE, source: 'stop_keyword' }];
    h.db.tables.marketing_consent = [{ phone: PHONE, status: 'opted_out', source: 'stop_keyword', withdrawn_at: '2026-09-01T00:00:00.000Z' }];

    const r = await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword', now: NOW_SEND });

    expect(r).toMatchObject({ ok: true, changed: true, warnings: [] });
    const [ledger] = rowsOf(h.db, 'marketing_consent');
    expect(ledger).toMatchObject({ phone: PHONE, status: 'opted_in', source: 'whatsapp_keyword', consented_at: NOW_SEND.toISOString(), withdrawn_at: null });
    // The customer asked back in: the legacy opt-out (which the feedback cron honours) must go.
    expect(rowsOf(h.db, 'whatsapp_opt_outs')).toEqual([]);
    // Only the VERIFIED profile with that phone.
    expect(rowsOf(h.db, 'profiles', (p) => p.id === 'u1')[0].marketing_consent).toBe(true);
    expect(rowsOf(h.db, 'profiles', (p) => p.id === 'u2')[0].marketing_consent).toBe(false);
    const [event] = rowsOf(h.db, 'marketing_consent_events');
    expect(event).toMatchObject({ phone: PHONE, action: 'opt_in', source: 'whatsapp_keyword', user_id: 'u1' });
  });

  it('finds the account behind the phone when the caller does not name one', async () => {
    await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    expect(rowsOf(h.db, 'marketing_consent')[0].user_id).toBe('u1');
  });

  it('does not wipe an existing user link when the account is unknown', async () => {
    h.db.tables.profiles = [];
    h.db.tables.marketing_consent = [{ phone: PHONE, user_id: 'u9', status: 'opted_out', source: 'x' }];
    await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    expect(rowsOf(h.db, 'marketing_consent')[0]).toMatchObject({ user_id: 'u9', status: 'opted_in' });
  });

  it('normalises any recognisable phone to E.164', async () => {
    await recordOptIn({ phone: '98765 43210', source: 'profile', userId: 'u1', actor: 'u1' });
    expect(rowsOf(h.db, 'marketing_consent')[0].phone).toBe(PHONE);
    expect(rowsOf(h.db, 'marketing_consent_events')[0]).toMatchObject({ actor: 'u1', source: 'profile' });
  });

  it('refuses a phone that cannot be a number, writing nothing', async () => {
    const r = await recordOptIn({ phone: 'not a phone', source: 'profile' });
    expect(r).toEqual({ ok: false, migration_missing: false, error: 'invalid phone' });
    expect(rowsOf(h.db, 'marketing_consent')).toEqual([]);
  });

  it('reports a missing migration as such, and throws nothing', async () => {
    h.db.setMissing('marketing_consent', true);
    const r = await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    expect(r).toMatchObject({ ok: false, migration_missing: true });
  });

  it('keeps the opt-in when a side effect fails, and says which one', async () => {
    h.db.failNext('delete whatsapp_opt_outs');
    const r = await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(' ')).toMatch(/whatsapp_opt_outs delete/);
    expect(rowsOf(h.db, 'marketing_consent')[0].status).toBe('opted_in');
  });
});

describe('START clears every stored spelling of THIS number\'s opt-out', () => {
  it('the E.164, the same without its plus, and the bare ten digits — older rows kept those', async () => {
    h.db.tables.whatsapp_opt_outs = [
      { phone: '+919876543210', source: 'stop_keyword' },
      { phone: '919876543210', source: 'legacy' },
      { phone: '9876543210', source: 'legacy' },
    ];
    await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    expect(rowsOf(h.db, 'whatsapp_opt_outs')).toEqual([]);
  });

  it('leaves a neighbour alone: only the exact same number is cleared', async () => {
    h.db.tables.whatsapp_opt_outs = [
      { phone: '9876543210', source: 'legacy' },
      { phone: '9876543211', source: 'legacy' }, // one digit off
      { phone: '+919876543211', source: 'stop_keyword' },
      { phone: '919876543212', source: 'legacy' },
    ];
    await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    expect(rowsOf(h.db, 'whatsapp_opt_outs').map((r) => r.phone).sort()).toEqual(['+919876543211', '919876543212', '9876543211']);
  });

  it('the plan-time audience read and the send-time read agree about a legacy bare-digit opt-out', async () => {
    h.db.tables.marketing_consent = [{ phone: PHONE, status: 'opted_in' }];
    h.db.tables.whatsapp_opt_outs = [{ phone: '9876543210', source: 'legacy' }];
    // Blocked while it stands…
    expect((await loadConsentState(h.db.client as never, PHONE)).opt_out_listed).toBe(true);
    // …and gone after START.
    await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    expect((await loadConsentState(h.db.client as never, PHONE)).opt_out_listed).toBe(false);
  });
});

// CONSENT LEAK: a foreign number whose digits are ten long and start 6–9 used to be read as the
// Indian mobile with the same digits, so its START/STOP moved an unrelated Indian customer's consent.
describe('a foreign number is never an Indian customer', () => {
  const SG = '+6581234567';
  const IN = '+916581234567'; // the Indian number that shares Singapore's ten digits

  beforeEach(() => {
    h.db.tables.profiles = [{ id: 'u-in', phone: IN, phone_verified: true, marketing_consent: false, role: 'customer' }];
    h.db.tables.marketing_consent = [{ phone: IN, user_id: 'u-in', status: 'opted_out', source: 'stop_keyword', withdrawn_at: '2026-09-01T00:00:00.000Z' }];
    h.db.tables.whatsapp_opt_outs = [
      { phone: IN, source: 'stop_keyword' },
      { phone: '6581234567', source: 'legacy' }, // the Indian number's legacy bare spelling
    ];
  });

  it('START from +65… opts in +65… and does not touch the Indian number\'s ledger, opt-outs or profile', async () => {
    const r = await recordOptIn({ phone: SG, source: 'whatsapp_keyword', now: NOW_SEND });

    expect(r).toMatchObject({ ok: true, changed: true });
    const ledger = rowsOf(h.db, 'marketing_consent');
    expect(ledger.find((l) => l.phone === SG)).toMatchObject({ status: 'opted_in', source: 'whatsapp_keyword' });
    expect(ledger.find((l) => l.phone === IN)).toMatchObject({ status: 'opted_out', source: 'stop_keyword', withdrawn_at: '2026-09-01T00:00:00.000Z' });
    // Both of the Indian number's opt-out rows survive.
    expect(rowsOf(h.db, 'whatsapp_opt_outs').map((x) => x.phone).sort()).toEqual(['+916581234567', '6581234567']);
    // The Indian customer's checkbox was not flipped, and no event names their number.
    expect(rowsOf(h.db, 'profiles', (p) => p.id === 'u-in')[0].marketing_consent).toBe(false);
    expect(rowsOf(h.db, 'marketing_consent_events').map((e) => e.phone)).toEqual([SG]);
  });

  it('STOP from +65… opts out +65… and leaves the Indian customer opted in, queued and checked', async () => {
    h.db.tables.marketing_consent = [{ phone: IN, user_id: 'u-in', status: 'opted_in', source: 'profile' }];
    h.db.tables.whatsapp_opt_outs = [];
    h.db.tables.profiles[0].marketing_consent = true;
    h.db.tables.marketing_recipients = [{ id: 'r-in', phone: IN, status: 'queued', campaign_id: 'c1' }];

    await recordOptOut({ phone: SG, source: 'stop_keyword', now: NOW_SEND });

    expect(rowsOf(h.db, 'marketing_consent').find((l) => l.phone === IN)).toMatchObject({ status: 'opted_in' });
    expect(rowsOf(h.db, 'whatsapp_opt_outs').map((x) => x.phone)).toEqual([SG]);
    expect(rowsOf(h.db, 'profiles', (p) => p.id === 'u-in')[0].marketing_consent).toBe(true);
    expect(rowsOf(h.db, 'marketing_recipients', (x) => x.id === 'r-in')[0].status).toBe('queued');
  });

  it('the send-time consent read of the Indian number is not answered by the foreign number\'s rows', async () => {
    h.db.tables.marketing_consent = [{ phone: SG, status: 'opted_in' }];
    h.db.tables.whatsapp_opt_outs = [];
    expect(await loadConsentState(h.db.client as never, IN)).toEqual({ opted_in: false, opt_out_listed: false });
    expect(await loadConsentState(h.db.client as never, SG)).toEqual({ opted_in: true, opt_out_listed: false });
  });
});

describe('meta_resume', () => {
  it('is NOT consent to us when there is no earlier opt-in of ours', async () => {
    const r = await recordOptIn({ phone: PHONE, source: 'meta_resume' });
    expect(r).toMatchObject({ ok: true, changed: false, skipped: 'no_prior_opt_in' });
    expect(rowsOf(h.db, 'marketing_consent')).toEqual([]);
    expect(rowsOf(h.db, 'marketing_consent_events')).toEqual([]);
  });

  it('resumes an earlier opt-in', async () => {
    h.db.tables.marketing_consent_events = [{ id: 'e1', phone: PHONE, action: 'opt_in', source: 'profile' }];
    h.db.tables.marketing_consent = [{ phone: PHONE, status: 'opted_out', source: 'meta_stop' }];
    const r = await recordOptIn({ phone: PHONE, source: 'meta_resume' });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(rowsOf(h.db, 'marketing_consent')[0]).toMatchObject({ status: 'opted_in', source: 'meta_resume' });
  });

  it('an earlier opt-OUT alone is not an opt-in to resume', async () => {
    h.db.tables.marketing_consent_events = [{ id: 'e1', phone: PHONE, action: 'opt_out', source: 'stop_keyword' }];
    const r = await recordOptIn({ phone: PHONE, source: 'meta_resume' });
    expect(r).toMatchObject({ ok: true, changed: false });
  });

  it("another phone's earlier opt-in does not count", async () => {
    h.db.tables.marketing_consent_events = [{ id: 'e1', phone: '+919999999999', action: 'opt_in', source: 'profile' }];
    const r = await recordOptIn({ phone: PHONE, source: 'meta_resume' });
    expect(r).toMatchObject({ changed: false });
  });
});

describe('recordOptOut', () => {
  beforeEach(() => {
    h.db.tables.marketing_consent = [{ phone: PHONE, user_id: 'u1', status: 'opted_in', source: 'profile', consented_at: '2026-09-01T00:00:00.000Z' }];
    h.db.tables.marketing_recipients = [
      { id: 'r-pending', phone: PHONE, status: 'pending', campaign_id: 'c1' },
      { id: 'r-queued', phone: PHONE, status: 'queued', campaign_id: 'c2' },
      { id: 'r-sending', phone: PHONE, status: 'sending', campaign_id: 'c3' },
      { id: 'r-sent', phone: PHONE, status: 'sent', campaign_id: 'c0' },
      { id: 'r-other', phone: '+919999999999', status: 'queued', campaign_id: 'c1' },
    ];
    h.db.tables.profiles[0].marketing_consent = true;
  });

  it('is total: ledger, shared opt-out table, checkbox, queue and audit log', async () => {
    const r = await recordOptOut({ phone: PHONE, source: 'stop_keyword', now: NOW_SEND });

    expect(r).toMatchObject({ ok: true, changed: true, warnings: [] });
    expect(rowsOf(h.db, 'marketing_consent')[0]).toMatchObject({ status: 'opted_out', source: 'stop_keyword', withdrawn_at: NOW_SEND.toISOString() });
    // The consented_at of the earlier opt-in is history, not something an opt-out erases.
    expect(rowsOf(h.db, 'marketing_consent')[0].consented_at).toBe('2026-09-01T00:00:00.000Z');
    expect(rowsOf(h.db, 'whatsapp_opt_outs')).toEqual([{ id: expect.any(String), created_at: expect.any(String), phone: PHONE, source: 'marketing:stop_keyword' }]);
    expect(rowsOf(h.db, 'profiles', (p) => p.id === 'u1')[0].marketing_consent).toBe(false);
    expect(rowsOf(h.db, 'marketing_consent_events')[0]).toMatchObject({ phone: PHONE, action: 'opt_out', source: 'stop_keyword', user_id: 'u1' });
  });

  it('cancels the phone\'s pending and queued messages — and only those', async () => {
    await recordOptOut({ phone: PHONE, source: 'owner', actor: 'owner-1' });

    const status = (id: string) => rowsOf(h.db, 'marketing_recipients', (r) => r.id === id)[0];
    expect(status('r-pending')).toMatchObject({ status: 'cancelled', skip_reason: 'opted_out' });
    expect(status('r-queued')).toMatchObject({ status: 'cancelled', skip_reason: 'opted_out' });
    // Already claimed by the sender (which re-reads consent itself) / already gone / someone else's.
    expect(status('r-sending').status).toBe('sending');
    expect(status('r-sent').status).toBe('sent');
    expect(status('r-other').status).toBe('queued');
    expect(rowsOf(h.db, 'marketing_consent_events')[0]).toMatchObject({ actor: 'owner-1', source: 'owner' });
  });

  it('upserts over an existing opt-out row instead of failing on it', async () => {
    h.db.tables.whatsapp_opt_outs = [{ phone: PHONE, source: 'stop_keyword' }];
    const r = await recordOptOut({ phone: PHONE, source: 'meta_stop' });
    expect(r.ok).toBe(true);
    expect(rowsOf(h.db, 'whatsapp_opt_outs')).toHaveLength(1);
  });

  it('a later opt-in undoes it completely (the round trip)', async () => {
    await recordOptOut({ phone: PHONE, source: 'stop_keyword' });
    await recordOptIn({ phone: PHONE, source: 'whatsapp_keyword' });
    expect(rowsOf(h.db, 'marketing_consent')[0]).toMatchObject({ status: 'opted_in', withdrawn_at: null });
    expect(rowsOf(h.db, 'whatsapp_opt_outs')).toEqual([]);
    expect(rowsOf(h.db, 'marketing_consent_events').map((e) => e.action)).toEqual(['opt_out', 'opt_in']);
  });

  it('reports a missing migration and does not pretend it worked', async () => {
    h.db.setMissing('marketing_consent', true);
    const r = await recordOptOut({ phone: PHONE, source: 'owner' });
    expect(r).toMatchObject({ ok: false, migration_missing: true });
    // The queue is left alone: without the ledger there is no opt-out to honour yet.
    expect(rowsOf(h.db, 'marketing_recipients', (x) => x.id === 'r-queued')[0].status).toBe('queued');
  });

  it('keeps the opt-out when cancelling the queue fails, and says so', async () => {
    h.db.failNext('update marketing_recipients');
    const r = await recordOptOut({ phone: PHONE, source: 'owner' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(' ')).toMatch(/marketing_recipients cancel/);
    expect(rowsOf(h.db, 'marketing_consent')[0].status).toBe('opted_out');
  });
});

describe('loadConsentState', () => {
  it('reads opted-in, opted-out and listed states fresh', async () => {
    h.db.tables.marketing_consent = [{ phone: PHONE, status: 'opted_in' }];
    expect(await loadConsentState(h.db.client as never, PHONE)).toEqual({ opted_in: true, opt_out_listed: false });

    h.db.tables.whatsapp_opt_outs = [{ phone: PHONE }];
    expect(await loadConsentState(h.db.client as never, PHONE)).toEqual({ opted_in: true, opt_out_listed: true });

    expect(await loadConsentState(h.db.client as never, '+919111111111')).toEqual({ opted_in: false, opt_out_listed: false });
  });

  it('sees a legacy opt-out stored without its plus sign', async () => {
    h.db.tables.marketing_consent = [{ phone: PHONE, status: 'opted_in' }];
    h.db.tables.whatsapp_opt_outs = [{ phone: PHONE.slice(1) }];
    expect((await loadConsentState(h.db.client as never, PHONE)).opt_out_listed).toBe(true);
  });

  it('throws on a failed read rather than answering "yes"', async () => {
    h.db.failNext('select marketing_consent');
    await expect(loadConsentState(h.db.client as never, PHONE)).rejects.toThrow();
  });
});
