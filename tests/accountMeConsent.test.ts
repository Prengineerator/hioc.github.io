import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/marketingDb';
import { newDb, rowsOf } from './helpers/marketingWorld';

// PATCH /api/account/me and marketing consent (spec §2, table row 1): toggling the profile
// checkbox also records opt-in / opt-out in the consent ledger — but only for a VERIFIED
// phone, and a ledger failure (migration not applied, a transient error) is logged and
// must never fail the customer's own profile update.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  user: { id: 'u1', phone: '919876543210' } as { id: string; phone?: string } | null,
  recordOptIn: vi.fn(),
  recordOptOut: vi.fn(),
}));

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/api/auth', () => ({ getAuthUser: () => Promise.resolve(h.user) }));
vi.mock('@/lib/marketing/server/consent', () => ({ recordOptIn: h.recordOptIn, recordOptOut: h.recordOptOut }));

const { PATCH } = await import('@/app/api/account/me/route');

const patch = (body: unknown) =>
  PATCH(new Request('http://t/api/account/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

const PHONE = '+919876543210';

beforeEach(() => {
  h.db = newDb();
  h.db.tables.profiles = [{ id: 'u1', name: 'Asha', phone: PHONE, phone_verified: true, marketing_consent: false, prefs: {}, date_of_birth: null, date_of_anniversary: null }];
  h.user = { id: 'u1', phone: '919876543210' };
  h.recordOptIn.mockReset();
  h.recordOptOut.mockReset();
  h.recordOptIn.mockResolvedValue({ ok: true, changed: true, warnings: [] });
  h.recordOptOut.mockResolvedValue({ ok: true, changed: true, warnings: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('marketing_consent on the profile → the consent ledger', () => {
  it('ticking the box records an opt-in for the verified phone, sourced "profile", by the customer themselves', async () => {
    const res = await patch({ marketing_consent: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ marketing_consent: true, phone: PHONE, phone_verified: true });
    expect(h.recordOptIn).toHaveBeenCalledTimes(1);
    expect(h.recordOptIn).toHaveBeenCalledWith({ phone: PHONE, userId: 'u1', source: 'profile', actor: 'u1' });
    expect(h.recordOptOut).not.toHaveBeenCalled();
  });

  it('unticking it records an opt-out', async () => {
    h.db.tables.profiles[0].marketing_consent = true;
    const res = await patch({ marketing_consent: false });
    expect(res.status).toBe(200);
    expect(h.recordOptOut).toHaveBeenCalledWith({ phone: PHONE, userId: 'u1', source: 'profile', actor: 'u1' });
    expect(h.recordOptIn).not.toHaveBeenCalled();
  });

  it('records nothing for an UNVERIFIED phone — we cannot message a number nobody proved', async () => {
    h.db.tables.profiles[0].phone_verified = false;
    const res = await patch({ marketing_consent: true });
    expect(res.status).toBe(200);
    expect(rowsOf(h.db, 'profiles')[0].marketing_consent).toBe(true); // the checkbox itself still saves
    expect(h.recordOptIn).not.toHaveBeenCalled();
  });

  it('records nothing when there is no phone on the profile', async () => {
    h.db.tables.profiles[0].phone = '';
    await patch({ marketing_consent: true });
    expect(h.recordOptIn).not.toHaveBeenCalled();
  });

  it('does not touch the ledger when the patch is about something else', async () => {
    await patch({ name: 'Asha K' });
    await patch({ default_order_type: 'takeaway' });
    expect(h.recordOptIn).not.toHaveBeenCalled();
    expect(h.recordOptOut).not.toHaveBeenCalled();
  });

  it('uses the phone the profile holds AFTER the update (a phone and the consent verified together)', async () => {
    h.db.tables.profiles[0].phone = '';
    h.db.tables.profiles[0].phone_verified = false;
    h.user = { id: 'u1', phone: '919812345678' };
    const res = await patch({ phone: '9812345678', marketing_consent: true });
    expect(res.status).toBe(200);
    expect(h.recordOptIn).toHaveBeenCalledWith(expect.objectContaining({ phone: '+919812345678' }));
  });
});

describe('a consent-ledger failure never fails the PATCH', () => {
  it('a ledger that reports failure (e.g. the migration is not applied): logged, PATCH still 200', async () => {
    h.recordOptIn.mockResolvedValue({ ok: false, migration_missing: true, error: 'marketing migration not applied (marketing_consent write)' });
    const res = await patch({ marketing_consent: true });
    expect(res.status).toBe(200);
    expect((await res.json()).marketing_consent).toBe(true);
    expect(console.error).toHaveBeenCalledWith('account/me: consent ledger not updated', expect.stringContaining('migration'));
  });

  it('a ledger that THROWS: logged, PATCH still 200', async () => {
    h.recordOptOut.mockRejectedValue(new Error('connection reset'));
    const res = await patch({ marketing_consent: false });
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith('account/me: consent ledger threw', expect.any(Error));
  });

  it('the profile row is saved before the ledger is even tried', async () => {
    h.recordOptIn.mockImplementation(async () => {
      expect(rowsOf(h.db, 'profiles')[0].marketing_consent).toBe(true);
      return { ok: true, changed: true, warnings: [] };
    });
    await patch({ marketing_consent: true });
    expect(h.recordOptIn).toHaveBeenCalled();
  });
});

describe('unchanged behaviour', () => {
  it('401s an anonymous caller and touches nothing', async () => {
    h.user = null;
    expect((await patch({ marketing_consent: true })).status).toBe(401);
    expect(h.recordOptIn).not.toHaveBeenCalled();
  });

  it('a non-boolean marketing_consent is still a 400, before anything is written', async () => {
    expect((await patch({ marketing_consent: 'yes' })).status).toBe(400);
    expect(h.recordOptIn).not.toHaveBeenCalled();
    expect(rowsOf(h.db, 'profiles')[0].marketing_consent).toBe(false);
  });

  it('a failed profile update is still a 500 and records no consent', async () => {
    h.db.failNext('update profiles');
    const res = await patch({ marketing_consent: true });
    expect(res.status).toBe(500);
    expect(h.recordOptIn).not.toHaveBeenCalled();
  });

  it('a phone already verified on another account is still a 409', async () => {
    h.db.failNext('update profiles', { code: '23505', message: 'duplicate' });
    h.user = { id: 'u1', phone: '919812345678' };
    const res = await patch({ phone: '9812345678', marketing_consent: true });
    expect(res.status).toBe(409);
    expect(h.recordOptIn).not.toHaveBeenCalled();
  });
});
