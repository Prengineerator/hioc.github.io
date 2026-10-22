import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERRUPTED, type SettlementStore } from '@/lib/online-settlements/ingest';
import type { SavedReport } from '@/lib/online-settlements/reprocess';
import { buildZomatoWorkbook } from './helpers/zomatoSettlementFixture';

// The online-reports routes: the cron fails closed without CRON_SECRET and is a
// quiet no-op while email isn't set up; the owner routes refuse non-owners,
// say plainly when email isn't set up, an upload runs the real pipeline
// (against an in-memory store), and "Re-read saved reports" feeds the saved
// files of the loaded reports through it.

const auth: { owner: { id: string } | null } = { owner: null };
const saved: {
  orders: Record<string, unknown>[];
  updates: { id: string; patch: Record<string, unknown> }[];
  files: Map<string, Uint8Array>;
  seen: { id: string; status: string } | null;
  loadArgs: Record<string, unknown>[];
  rows: SavedReport[];
  left: number;
} = { orders: [], updates: [], files: new Map(), seen: null, loadArgs: [], rows: [], left: 0 };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({}),
}));
vi.mock('@/lib/api/auth', () => ({
  getOwnerUser: () => Promise.resolve(auth.owner),
}));
vi.mock('@/lib/online-settlements/store', () => ({
  supabaseSettlementStore: (): SettlementStore => ({
    findReportByHash: async () => saved.seen,
    saveFile: async () => true,
    readFile: async (path) => saved.files.get(path) ?? null,
    insertReport: async () => 'report-1',
    updateReport: async (id, patch) => {
      saved.updates.push({ id, patch });
    },
    orderPeriods: async () => new Map(),
    upsertOrders: async (rows) => {
      saved.orders.push(...rows);
    },
    deductionPeriods: async () => new Map(),
    upsertDeductions: async () => undefined,
  }),
  loadRereadableReports: async (_admin: unknown, opts: Record<string, unknown>) => {
    saved.loadArgs.push(opts);
    return { rows: saved.rows, left: saved.left };
  },
}));

const { GET: CRON } = await import('@/app/api/cron/online-reports/route');
const { POST: SYNC } = await import('@/app/api/owner/online-reports/sync/route');
const { POST: UPLOAD } = await import('@/app/api/owner/online-reports/upload/route');
const { POST: REPROCESS } = await import('@/app/api/owner/online-reports/reprocess/route');

const ENV_KEYS = ['CRON_SECRET', 'ONLINE_REPORTS_IMAP_USER', 'ONLINE_REPORTS_IMAP_PASSWORD'] as const;
let envBefore: Record<string, string | undefined>;

beforeEach(() => {
  envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  auth.owner = null;
  saved.orders = [];
  saved.updates = [];
  saved.files = new Map();
  saved.seen = null;
  saved.loadArgs = [];
  saved.rows = [];
  saved.left = 0;
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

describe('POST /api/owner/online-reports/reprocess', () => {
  const post = (body?: unknown) => new Request('http://t/api/owner/online-reports/reprocess', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  const savedRow = (over: Partial<SavedReport>): SavedReport => ({
    id: '11111111-1111-4111-8111-111111111111',
    platform: 'zomato',
    source: 'email',
    file_name: 'Zomato_Settlement_Report_20788341_22_Sep_2026_28_Sep_2026.xlsx',
    storage_path: 'zomato/ab/saved.xlsx',
    status: 'failed',
    email_message_id: '<m1>',
    email_from: 'reports@zomato.com',
    email_subject: 'Weekly report',
    email_received_at: '2026-09-30T04:00:00.000Z',
    ...over,
  });

  it('is owner only', async () => {
    expect((await REPROCESS(post())).status).toBe(401);
    expect(saved.loadArgs).toEqual([]);
  });

  it('refuses a bad platform or a bad cursor', async () => {
    auth.owner = { id: 'owner-1' };
    expect((await REPROCESS(post({ platform: 'ubereats' }))).status).toBe(400);
    expect((await REPROCESS(post({ after: 'not-a-report-id' }))).status).toBe(400);
    expect(saved.loadArgs).toEqual([]);
  });

  it('says so when there is nothing to re-read', async () => {
    auth.owner = { id: 'owner-1' };
    const res = await REPROCESS(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: { checked: 0, read: 0, stillUnsupported: 0, failed: 0, missingFile: 0, notReached: 0, files: [] },
      left: 0,
      next: null,
    });
    expect(saved.loadArgs).toEqual([{ platform: null, afterId: null, limit: 100 }]);
  });

  it('re-reads the saved files of the loaded reports and says how many are left', async () => {
    auth.owner = { id: 'owner-1' };
    const bytes = await buildZomatoWorkbook({
      period: '22 Sep 2026 - 28 Sep 2026',
      orders: [{ id: '9000000001', date: '2026-09-28 13:00:00', subtotal: 300, payout: 150 }],
    });
    saved.files.set('zomato/ab/saved.xlsx', bytes);
    saved.seen = { id: 'report-7', status: 'failed' };
    saved.rows = [savedRow({}), savedRow({ id: '22222222-2222-4222-8222-222222222222', file_name: 'gone.xlsx', storage_path: 'zomato/cd/gone.xlsx' })];
    saved.left = 3;

    const after = '00000000-0000-4000-8000-000000000000';
    const res = await REPROCESS(post({ platform: 'zomato', after }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toMatchObject({ checked: 2, read: 1, missingFile: 1, failed: 0 });
    expect(body.result.files.map((f: { status: string }) => f.status)).toEqual(['read', 'missingFile']);
    expect(body.left).toBe(3);
    expect(body.next).toBe('22222222-2222-4222-8222-222222222222');
    expect(saved.loadArgs).toEqual([{ platform: 'zomato', afterId: after, limit: 100 }]);
    // The same report row is updated, with the email details it arrived with: unfinished while the rows are written, read at the end.
    expect(saved.updates[0]).toMatchObject({ id: 'report-7', patch: { status: 'failed', error: INTERRUPTED, email_message_id: '<m1>', source: 'email' } });
    expect(saved.updates[saved.updates.length - 1]).toMatchObject({ id: 'report-7', patch: { status: 'read', error: null, orders_count: 1 } });
    expect(saved.orders).toEqual([expect.objectContaining({ order_id: '9000000001', report_id: 'report-7', payout_inr: 150 })]);
  });
});
