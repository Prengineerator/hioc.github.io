import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WA-4 — the delivery ladder, and the guards that depend on it.
//
// WA-4 widened NotificationStatus from queued/sent/failed/skipped to include
// 'delivered' and 'read'. Every `status === 'sent'` test in the codebase meant
// "has this already been sent?", and each one silently started answering "no"
// for the two statuses that are the STRONGEST evidence that it was. Two of them
// live in lib/notifications/engine.ts and guard against re-firing a billable
// WhatsApp template at a customer who has already read their bill.
//
// These tests exist so the next widening cannot repeat that: they bind the
// engine's behaviour to lib/notifications/status.ts rather than to a literal.

const state: {
  existing: Record<string, unknown> | null;
  upserts: Record<string, unknown>[];
} = { existing: null, upserts: [] };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: state.existing, error: null }),
        upsert: (row: Record<string, unknown>) => {
          state.upserts.push(row);
          return Promise.resolve({ error: null });
        },
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/flags', () => ({ flags: { notifications: true } }));

import { sendBillNotification } from '@/lib/notifications/engine';
import { resetWarnOnceForTests } from '@/lib/notifications/health';
import { STATUS_RANK, SENT_OR_BETTER, hasBeenSent, replaceableBy } from '@/lib/notifications/status';

const ENV_KEYS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TPL_BILL', 'RESEND_API_KEY', 'RESEND_FROM'];
const saved: Record<string, string | undefined> = {};

const order = {
  id: 'order-1',
  order_number: 1001,
  customer_name: 'Ayush',
  customer_phone: '+919876543210',
  customer_email: null,
  total_inr: 480,
  subtotal_inr: 450,
  payment_method: 'cash',
  items: [{ id: 'i1' }, { id: 'i2' }],
} as never;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.existing = null;
  state.upserts = [];
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // A fully live WhatsApp bill channel: the engine will reach the adapter
  // unless a guard stops it, which is exactly what we are measuring.
  process.env.WHATSAPP_TOKEN = 'tok';
  process.env.WHATSAPP_PHONE_ID = '123';
  process.env.WHATSAPP_TPL_BILL = 'order_bill_1';
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  resetWarnOnceForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ messages: [{ id: 'wamid.NEW' }] }),
    }),
  );
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

describe('the ladder itself (lib/notifications/status)', () => {
  it('ranks the two handset-confirmed statuses above every claim we make ourselves', () => {
    expect(STATUS_RANK.read).toBeGreaterThan(STATUS_RANK.delivered);
    expect(STATUS_RANK.delivered).toBeGreaterThan(STATUS_RANK.failed);
    expect(STATUS_RANK.failed).toBeGreaterThan(STATUS_RANK.sent);
    expect(STATUS_RANK.sent).toBeGreaterThan(STATUS_RANK.queued);
    // A deliberate non-attempt is a different fact, not an early rung.
    expect(STATUS_RANK.skipped).toBeLessThan(0);
  });

  it('counts delivered and read as already-sent, not just the literal "sent"', () => {
    expect(SENT_OR_BETTER).toEqual(expect.arrayContaining(['sent', 'delivered', 'read']));
    for (const s of ['sent', 'delivered', 'read']) expect(hasBeenSent(s)).toBe(true);
    for (const s of ['queued', 'failed', 'skipped', '', null, undefined]) expect(hasBeenSent(s)).toBe(false);
  });

  it('never offers skipped as a row a webhook status may overwrite', () => {
    for (const next of ['sent', 'delivered', 'read', 'failed'] as const) {
      expect(replaceableBy(next)).not.toContain('skipped');
    }
    expect(replaceableBy('delivered')).toEqual(expect.arrayContaining(['queued', 'sent', 'failed']));
    expect(replaceableBy('sent')).toEqual(['queued']);
  });
});

describe('sendBillNotification — a delivered bill is not re-sent (WA-4)', () => {
  it('sends when there is no prior row', async () => {
    const result = await sendBillNotification(order);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.whatsapp).toBe(true);
  });

  // The concrete harm: sendBillNotification is called non-forced from order
  // placement, the status route, the payment route and the owner test send, all
  // on the same (order_id,'bill','whatsapp') key. A row Meta's webhook promoted
  // to 'delivered' must short-circuit exactly as 'sent' does, or the second call
  // bills the cafe for a template the customer has already read AND overwrites
  // the receipt that proved it.
  it.each(['sent', 'delivered', 'read'])(
    'does not contact Meta again when the row already reads %s',
    async (status) => {
      state.existing = { status, attempts: 1 };

      const result = await sendBillNotification(order);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.whatsapp).toBe(true);
      // No row is rewritten, so the receipt columns survive untouched.
      expect(state.upserts.filter((r) => r.channel === 'whatsapp')).toHaveLength(0);
    },
  );

  it.each(['queued', 'failed'])('does retry a %s row — those are not sends', async (status) => {
    state.existing = { status, attempts: 0 };

    await sendBillNotification(order);

    expect(fetchMock).toHaveBeenCalled();
  });

  it('a forced resend still re-delivers over a delivered row', async () => {
    state.existing = { status: 'delivered', attempts: 1 };

    const result = await sendBillNotification(order, { force: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.whatsapp).toBe(true);
  });

  // Set-once columns belong to a specific message id. A forced resend mints a
  // new provider_ref, so the previous message's receipts stop being evidence
  // about this row — leaving them renders "delivered" for a message that has
  // not been delivered.
  it('a forced resend clears the previous message’s receipts', async () => {
    state.existing = { status: 'delivered', attempts: 1 };

    await sendBillNotification(order, { force: true });

    const row = state.upserts.find((r) => r.channel === 'whatsapp' && r.status === 'sent');
    expect(row).toBeDefined();
    expect(row?.delivered_at).toBeNull();
    expect(row?.read_at).toBeNull();
    expect(row?.provider_ref).toBe('wamid.NEW');
  });
});

describe('sendBillNotification — the provider’s own error travels with the verdict (WA-3)', () => {
  it("carries Meta's message, not just the token 'send_failed'", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({ error: { code: 190, message: 'Error validating access token: Session has expired' } }),
    });

    const result = await sendBillNotification(order);

    expect(result.whatsapp).toBe(false);
    expect(result.reasons.whatsapp).toBe('send_failed');
    // Without this the owner cannot tell an expired token from a paused
    // template, and the remedies are completely different.
    expect(result.errors.whatsapp).toBe('Error validating access token: Session has expired');
  });

  it('leaves the error blank on a channel that was never attempted', async () => {
    const result = await sendBillNotification(order);

    expect(result.errors.email).toBe('');
    expect(result.reasons.email).toBe('no_email');
  });
});
