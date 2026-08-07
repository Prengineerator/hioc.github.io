import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// BILL-3 — a skipped bill must leave a row explaining itself.
//
// The regression: sendBillNotification's channel guards returned early and wrote
// NOTHING, so an order with no bill was indistinguishable from an order whose
// bill vanished. Absence of a row is no longer an acceptable answer.

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

const ENV_KEYS = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_ID',
  'WHATSAPP_TPL_BILL',
  'RESEND_API_KEY',
  'RESEND_FROM',
];
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

beforeEach(() => {
  state.existing = null;
  state.upserts = [];
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetWarnOnceForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const skipRows = () => state.upserts.filter((r) => r.status === 'skipped');
const rowFor = (channel: string) => skipRows().find((r) => r.channel === channel);

describe('sendBillNotification — skip logging (BILL-3)', () => {
  it('logs WHY WhatsApp was skipped when the template name is missing', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    // WHATSAPP_TPL_BILL deliberately unset — the silent-failure case.

    const result = await sendBillNotification(order);

    expect(result.whatsapp).toBe(false);
    expect(result.reasons.whatsapp).toBe('not_configured:WHATSAPP_TPL_BILL');
    expect(rowFor('whatsapp')).toMatchObject({
      order_id: 'order-1',
      event: 'bill',
      status: 'skipped',
      skip_reason: 'not_configured:WHATSAPP_TPL_BILL',
    });
  });

  it('logs no_email when the order carries no address', async () => {
    const result = await sendBillNotification(order);

    expect(result.reasons.email).toBe('no_email');
    expect(rowFor('email')).toMatchObject({ skip_reason: 'no_email', status: 'skipped' });
  });

  it('logs no_phone when the order carries no number', async () => {
    const result = await sendBillNotification({ ...(order as object), customer_phone: null } as never);

    expect(result.reasons.whatsapp).toBe('no_phone');
    expect(rowFor('whatsapp')).toMatchObject({ skip_reason: 'no_phone' });
  });

  it('never downgrades an already-sent bill to skipped', async () => {
    // A bill delivered at placement, then re-evaluated at settle after the
    // channel went dormant, must stay 'sent'.
    state.existing = { status: 'sent' };

    await sendBillNotification(order);

    expect(skipRows()).toHaveLength(0);
  });

  // WA-4 added 'delivered' and 'read' ABOVE 'sent'. Both guards in the engine
  // tested `status === 'sent'` literally, so the two statuses that are the
  // strongest possible proof a bill arrived stopped being protected — a skip at
  // settle would stamp status:'skipped', provider_ref:'', sent_at:null over a
  // bill the customer had demonstrably opened.
  it.each(['delivered', 'read'])('never downgrades a %s bill to skipped', async (status) => {
    state.existing = { status };

    await sendBillNotification(order);

    expect(skipRows()).toHaveLength(0);
  });

  it('reports both channels when notifications are disabled', async () => {
    vi.resetModules();
    vi.doMock('@/lib/flags', () => ({ flags: { notifications: false } }));
    const { sendBillNotification: send } = await import('@/lib/notifications/engine');

    const result = await send(order);

    expect(result.reasons.whatsapp).toBe('notifications_disabled');
    expect(result.reasons.email).toBe('notifications_disabled');
    // Nothing is written when the whole engine is off.
    expect(state.upserts).toHaveLength(0);
    vi.doUnmock('@/lib/flags');
  });
});
