import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettlementStore } from '@/lib/online-settlements/ingest';
import { buildZomatoWorkbook } from './helpers/zomatoSettlementFixture';

// The online-reports routes: the cron fails closed without CRON_SECRET and is a
// quiet no-op while email isn't set up; the owner routes refuse non-owners,
// say plainly when email isn't set up, and an upload runs the real pipeline
// (against an in-memory store).

const auth: { owner: { id: string } | null } = { owner: null };
const saved: { orders: Record<string, unknown>[] } = { orders: [] };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({}),
}));
vi.mock('@/lib/api/auth', () => ({
  getOwnerUser: () => Promise.resolve(auth.owner),
}));
vi.mock('@/lib/online-settlements/store', () => ({
  supabaseSettlementStore: (): SettlementStore => ({
    findReportByHash: async () => null,
    saveFile: async () => true,
    insertReport: async () => 'report-1',
    updateReport: async () => undefined,
    orderPeriods: async () => new Map(),
    upsertOrders: async (rows) => {
      saved.orders.push(...rows);
    },
    deductionPeriods: async () => new Map(),
    upsertDeductions: async () => undefined,
  }),
}));

const { GET: CRON } = await import('@/app/api/cron/online-reports/route');
const { POST: SYNC } = await import('@/app/api/owner/online-reports/sync/route');
const { POST: UPLOAD } = await import('@/app/api/owner/online-reports/upload/route');

const ENV_KEYS = ['CRON_SECRET', 'ONLINE_REPORTS_IMAP_USER', 'ONLINE_REPORTS_IMAP_PASSWORD'] as const;
let envBefore: Record<string, string | undefined>;

beforeEach(() => {
  envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  auth.owner = null;
  saved.orders = [];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
});

function uploadReq(file: File | null, platform?: string) {
  const form = new FormData();
  if (file) form.append('file', file);
  if (platform !== undefined) form.append('platform', platform);
  return new Request('http://t/api/owner/online-reports/upload', { method: 'POST', body: form });
}

describe('GET /api/cron/online-reports', () => {
  it('fails closed without CRON_SECRET, and with a wrong one', async () => {
    expect((await CRON(new Request('http://t/api/cron/online-reports'))).status).toBe(401);
    process.env.CRON_SECRET = 'right';
    const wrong = new Request('http://t/api/cron/online-reports', { headers: { authorization: 'Bearer wrong' } });
    expect((await CRON(wrong)).status).toBe(401);
  });

  it('answers 200 with a note while email is not set up', async () => {
    process.env.CRON_SECRET = 'right';
    const res = await CRON(new Request('http://t/api/cron/online-reports', { headers: { authorization: 'Bearer right' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, note: expect.stringMatching(/ONLINE_REPORTS_IMAP_USER/) });
  });
});

describe('POST /api/owner/online-reports/sync', () => {
  it('is owner only', async () => {
    expect((await SYNC(new Request('http://t', { method: 'POST' }))).status).toBe(401);
  });

  it('says email is not set up, and validates the look-back', async () => {
    auth.owner = { id: 'owner-1' };
    const res = await SYNC(new Request('http://t', { method: 'POST', body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not set up/);
    const bad = await SYNC(new Request('http://t', { method: 'POST', body: JSON.stringify({ lookbackDays: 0 }) }));
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/owner/online-reports/upload', () => {
  it('is owner only', async () => {
    expect((await UPLOAD(uploadReq(new File(['x'], 'a.xlsx')))).status).toBe(401);
  });

  it('refuses a missing file, a bad platform and a non-spreadsheet', async () => {
    auth.owner = { id: 'owner-1' };
    expect((await UPLOAD(uploadReq(null))).status).toBe(400);
    expect((await UPLOAD(uploadReq(new File(['x'], 'a.xlsx'), 'ubereats'))).status).toBe(400);
    const pdf = await UPLOAD(uploadReq(new File(['%PDF'], 'invoice.pdf')));
    expect(pdf.status).toBe(422);
    expect((await pdf.json()).error).toMatch(/Not a spreadsheet/);
  });

  it('reads a Zomato report into orders', async () => {
    auth.owner = { id: 'owner-1' };
    const bytes = await buildZomatoWorkbook({
      period: '22 Sep 2026 - 28 Sep 2026',
      orders: [{ id: '9000000001', date: '2026-09-28 13:00:00', subtotal: 300, payout: 150 }],
    });
    const file = new File([bytes as unknown as BlobPart], 'Zomato_Settlement_Report_20788341_22_Sep_2026_28_Sep_2026.xlsx');
    const res = await UPLOAD(uploadReq(file));
    expect(res.status).toBe(201);
    expect((await res.json()).outcome).toMatchObject({ status: 'read', platform: 'zomato', orders: 1, periodEnd: '2026-09-28' });
    expect(saved.orders).toEqual([expect.objectContaining({ order_id: '9000000001', payout_inr: 150 })]);
  });
});
