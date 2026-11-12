import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationsLogState } from './helpers/notificationsLog';

// The notification engine's writes as an explicit machine (lib/notifications/status.ts)
// and the bugs the implicit one had:
//   1. two automatic sends for the same (order, event, channel) — the bill at settle AND
//      on 'completed' — could BOTH reach Meta: check → send → upsert had no claim;
//   2. a skip could stamp 'skipped' over a 'sent' that landed after its read;
//   3. a forced resend that FAILED wrote 'failed' (receipts cleared) over a row the
//      customer had demonstrably read.

const state: NotificationsLogState = { existing: null, upserts: [], beforeNextWrite: null };

vi.mock('@/lib/supabase-server', async () => {
  const { notificationsLogClient } = await import('./helpers/notificationsLog');
  return { createAdminSupabaseClient: () => notificationsLogClient(state) };
});
vi.mock('@/lib/flags', () => ({ flags: { notifications: true } }));

const { sendBillNotification } = await import('@/lib/notifications/engine');
const { resetWarnOnceForTests } = await import('@/lib/notifications/health');
const { putRow, storedRow } = await import('./helpers/notificationsLog');
const status = await import('@/lib/notifications/status');

const ENV_KEYS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TPL_BILL', 'RESEND_API_KEY', 'RESEND_FROM'];
const saved: Record<string, string | undefined> = {};

const order = {
  id: 'order-1',
  order_number: 1001,
  customer_name: 'Asha',
  customer_phone: '+919876543210',
  customer_email: null,
  total_inr: 480,
  subtotal_inr: 450,
  payment_method: 'cash',
  items: [{ id: 'i1' }],
} as never;

const WA_KEY = { order_id: 'order-1', event: 'bill', channel: 'whatsapp' };
const waRow = () => storedRow(state, WA_KEY);
const ok = (id = 'wamid.NEW') => ({ ok: true, status: 200, json: () => Promise.resolve({ messages: [{ id }] }) });
const rejected = (message = 'Template paused') => ({ ok: false, status: 400, json: () => Promise.resolve({ error: { message } }) });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.existing = null;
  state.upserts = [];
  state.beforeNextWrite = null;
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.WHATSAPP_TOKEN = 'tok';
  process.env.WHATSAPP_PHONE_ID = '123';
  process.env.WHATSAPP_TPL_BILL = 'order_bill_1';
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  resetWarnOnceForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock = vi.fn(() => Promise.resolve(ok()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const ctx = { nowMs: NOW, maxAttempts: 2 };
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

// ---------------------------------------------------------------------------
describe('the transition table (lib/notifications/status.ts)', () => {
  it('an automatic send claims a missing, skipped, failed-with-budget or stale-queued row — nothing else', () => {
    expect(status.sendDecision(null, ctx)).toEqual({ kind: 'claim' });
    expect(status.sendDecision({ status: 'skipped', attempts: 0 }, ctx)).toEqual({ kind: 'claim' });
    expect(status.sendDecision({ status: 'failed', attempts: 1 }, ctx)).toEqual({ kind: 'claim' });
    expect(status.sendDecision({ status: 'queued', sent_at: minutesAgo(11) }, ctx)).toEqual({ kind: 'claim' });
    // A queued row with no claim time (written before claims existed) is not anybody's live claim.
    expect(status.sendDecision({ status: 'queued', sent_at: null }, ctx)).toEqual({ kind: 'claim' });

    for (const s of ['sent', 'delivered', 'read']) {
      expect(status.sendDecision({ status: s, attempts: 9 }, ctx)).toEqual({ kind: 'skip', reason: 'already_sent' });
    }
    expect(status.sendDecision({ status: 'failed', attempts: 2 }, ctx)).toEqual({ kind: 'skip', reason: 'attempts_exhausted' });
    expect(status.sendDecision({ status: 'queued', sent_at: minutesAgo(1) }, ctx)).toEqual({ kind: 'skip', reason: 'in_flight' });
  });

  it('a skip never lands on a send, or on a send in flight', () => {
    expect(status.skipMayReplace(null, NOW)).toBe(true);
    expect(status.skipMayReplace({ status: 'skipped' }, NOW)).toBe(true);
    expect(status.skipMayReplace({ status: 'failed' }, NOW)).toBe(true);
    expect(status.skipMayReplace({ status: 'queued', sent_at: minutesAgo(30) }, NOW)).toBe(true);
    expect(status.skipMayReplace({ status: 'queued', sent_at: minutesAgo(2) }, NOW)).toBe(false);
    for (const s of ['sent', 'delivered', 'read']) expect(status.skipMayReplace({ status: s }, NOW)).toBe(false);
  });

  it('a failed forced resend only becomes "failed" over a row that never recorded a send', () => {
    for (const s of ['sent', 'delivered', 'read']) expect(status.failedResendMayReplace({ status: s }, NOW)).toBe(false);
    for (const s of ['failed', 'skipped']) expect(status.failedResendMayReplace({ status: s }, NOW)).toBe(true);
    expect(status.failedResendMayReplace({ status: 'queued', sent_at: minutesAgo(30) }, NOW)).toBe(true);
    // …and not over an automatic send's live claim: its holder's verdict is about to land.
    expect(status.failedResendMayReplace({ status: 'queued', sent_at: minutesAgo(1) }, NOW)).toBe(false);
    expect(status.failedResendMayReplace(null, NOW)).toBe(true);
  });

  it('the claim holder may only finish its own claim', () => {
    expect(status.canWrite('finish', { status: 'queued' }, 'sent', ctx).ok).toBe(true);
    expect(status.canWrite('finish', { status: 'queued' }, 'failed', ctx).ok).toBe(true);
    expect(status.canWrite('finish', { status: 'sent' }, 'failed', ctx)).toMatchObject({ ok: false, code: 'illegal_transition' });
    expect(status.canWrite('finish', null, 'sent', ctx).ok).toBe(false);
  });

  it('receipts follow the ladder, generated from replaceableBy', () => {
    expect(status.canWrite('receipt', { status: 'failed' }, 'delivered', ctx).ok).toBe(true);
    expect(status.canWrite('receipt', { status: 'read' }, 'delivered', ctx).ok).toBe(false);
    expect(status.canWrite('receipt', { status: 'skipped' }, 'sent', ctx).ok).toBe(false);
  });

  it('replaceableVia maps a foreign vocabulary onto the same ladder, off-ladder statuses never move', () => {
    const rungs = { pending: null, queued: null, sending: 'queued', sent: 'sent', failed: 'failed', delivered: 'delivered', read: 'read', cancelled: null } as const;
    expect(status.replaceableVia(rungs, 'delivered').sort()).toEqual(['failed', 'sending', 'sent']);
    expect(status.replaceableVia(rungs, 'read').sort()).toEqual(['delivered', 'failed', 'sending', 'sent']);
    expect(status.replaceableVia(rungs, 'failed').sort()).toEqual(['sending', 'sent']);
    // A recipient's 'queued' is "approved, waiting" — NOT the notifications claim — so it is never a receipt's target.
    for (const next of ['sent', 'delivered', 'read', 'failed'] as const) {
      expect(status.replaceableVia(rungs, next)).not.toContain('queued');
      expect(status.replaceableVia(rungs, next)).not.toContain('pending');
    }
    expect(status.replaceableIn(status.STATUS_RANK, 'failed')).toEqual(status.replaceableBy('failed'));
  });
});

// ---------------------------------------------------------------------------
describe('bug 1 — two automatic sends cannot both reach Meta', () => {
  it('concurrent bill sends for the same order: one message, the other is told it is in flight', async () => {
    const [a, b] = await Promise.all([sendBillNotification(order), sendBillNotification(order)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const results = [a, b].map((r) => (r.whatsapp ? 'sent' : r.reasons.whatsapp)).sort();
    expect(results).toEqual(['in_flight', 'sent']);
    expect(waRow()).toMatchObject({ status: 'sent', provider_ref: 'wamid.NEW' });
  });

  it('claims the row as queued BEFORE the provider is contacted', async () => {
    let atSend: unknown = null;
    fetchMock.mockImplementation(() => {
      atSend = waRow()?.status;
      return Promise.resolve(ok());
    });
    await sendBillNotification(order);
    expect(atSend).toBe('queued');
  });

  it('a fresh claim held by another caller is respected: no send', async () => {
    state.existing = null;
    putRow(state, { ...WA_KEY, status: 'queued', sent_at: new Date().toISOString(), attempts: 0 });
    const r = await sendBillNotification(order);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ whatsapp: false, reasons: { whatsapp: 'in_flight' } });
  });

  it('a stale claim (its run died mid-send) is taken over, so a crash cannot strand the bill', async () => {
    putRow(state, { ...WA_KEY, status: 'queued', sent_at: new Date(Date.now() - 11 * 60_000).toISOString(), attempts: 0 });
    const r = await sendBillNotification(order);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.whatsapp).toBe(true);
    expect(waRow()).toMatchObject({ status: 'sent' });
  });

  it('only the claim holder writes the verdict: a forced resend that replaced the claim keeps its record', async () => {
    fetchMock.mockImplementation(() => {
      // A staff "Resend bill" lands while this send is in flight and records its own message.
      Object.assign(waRow() as object, { status: 'sent', provider_ref: 'wamid.STAFF', sent_at: '2026-11-12T09:59:00.000Z' });
      return Promise.resolve(ok('wamid.AUTO'));
    });
    await sendBillNotification(order);
    expect(waRow()).toMatchObject({ status: 'sent', provider_ref: 'wamid.STAFF' });
  });
});

// ---------------------------------------------------------------------------
describe('bug 2 — a skip never overwrites a send that landed after its read', () => {
  // With the WhatsApp bill channel dormant, sendBillNotification makes two writes: the
  // email channel's skip (no address), then WhatsApp's. `onWrite(2, …)` lands another
  // caller's write immediately before the second.
  const onWrite = (n: number, fn: (op: string, row: Record<string, unknown> | null) => void) => {
    let seen = 0;
    const hook = (op: string, row: Record<string, unknown> | null) => {
      seen += 1;
      if (seen === n) return fn(op, row);
      state.beforeNextWrite = hook;
    };
    state.beforeNextWrite = hook;
  };

  beforeEach(() => {
    delete process.env.WHATSAPP_TPL_BILL;
  });

  it("a send recorded between the skip's read (no row) and its insert wins", async () => {
    onWrite(2, (op) => {
      expect(op).toBe('insert');
      putRow(state, { ...WA_KEY, status: 'sent', provider_ref: 'wamid.RACED', attempts: 1 });
    });
    await sendBillNotification(order);
    expect(waRow()).toMatchObject({ status: 'sent', provider_ref: 'wamid.RACED' });
  });

  it("a send recorded between the skip's read (skipped) and its update wins", async () => {
    putRow(state, { ...WA_KEY, status: 'skipped', skip_reason: 'no_phone', attempts: 0 });
    onWrite(2, (op, row) => {
      expect(op).toBe('update');
      Object.assign(row as object, { status: 'sent', provider_ref: 'wamid.RACED' });
    });
    await sendBillNotification(order);
    expect(waRow()).toMatchObject({ status: 'sent', provider_ref: 'wamid.RACED' });
  });

  it('with nothing racing, the skip is recorded with its reason', async () => {
    await sendBillNotification(order);
    expect(waRow()).toMatchObject({ status: 'skipped', skip_reason: 'not_configured:WHATSAPP_TPL_BILL' });
  });
});

// ---------------------------------------------------------------------------
describe('bug 3 — a failed forced resend never steps a sent/delivered/read row back', () => {
  it.each(['sent', 'delivered', 'read'])('over a %s row: status, message id and receipts stay; the failure is recorded', async (s) => {
    putRow(state, {
      ...WA_KEY,
      status: s,
      provider_ref: 'wamid.OLD',
      sent_at: '2026-11-12T08:00:00.000Z',
      delivered_at: s === 'sent' ? null : '2026-11-12T08:00:05.000Z',
      read_at: s === 'read' ? '2026-11-12T08:01:00.000Z' : null,
      attempts: 1,
      error: '',
    });
    fetchMock.mockResolvedValue(rejected('Template paused'));

    const r = await sendBillNotification(order, { force: true });

    expect(r.whatsapp).toBe(false);
    expect(r.errors.whatsapp).toBe('Template paused');
    const row = waRow();
    expect(row).toMatchObject({ status: s, provider_ref: 'wamid.OLD', sent_at: '2026-11-12T08:00:00.000Z' });
    if (s !== 'sent') expect(row?.delivered_at).toBe('2026-11-12T08:00:05.000Z');
    expect(row?.error).toBe('Resend failed: Template paused');
    expect(row?.attempts).toBe(2);
  });

  it('over a failed row it is an ordinary failure', async () => {
    putRow(state, { ...WA_KEY, status: 'failed', provider_ref: '', attempts: 2, error: 'old reason' });
    fetchMock.mockResolvedValue(rejected('Session has expired'));
    await sendBillNotification(order, { force: true });
    expect(waRow()).toMatchObject({ status: 'failed', error: 'Session has expired', attempts: 2 });
  });

  it('a forced resend that goes out still replaces the row (a new message, its receipts start empty)', async () => {
    putRow(state, { ...WA_KEY, status: 'read', provider_ref: 'wamid.OLD', delivered_at: 'x', read_at: 'y', attempts: 1 });
    await sendBillNotification(order, { force: true });
    expect(waRow()).toMatchObject({ status: 'sent', provider_ref: 'wamid.NEW', delivered_at: null, read_at: null });
  });
});

describe('an unwritable log never stops a send', () => {
  it("when even the claim is refused (the owner test send's order has no row), the bill still goes and is upserted", async () => {
    // Writes: the email skip, then the WhatsApp claim — refused with a foreign-key error.
    state.beforeNextWrite = () => {
      state.beforeNextWrite = (op) => (op === 'insert' ? { code: '23503', message: 'violates foreign key constraint' } : undefined);
    };
    const r = await sendBillNotification(order);
    expect(r.whatsapp).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.upserts).toContainEqual(expect.objectContaining({ channel: 'whatsapp', status: 'sent', provider_ref: 'wamid.NEW' }));
  });
});
