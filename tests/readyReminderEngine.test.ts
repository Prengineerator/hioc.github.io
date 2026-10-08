import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The pickup reminder re-sends the 'ready' WhatsApp past the per-(order, event,
// channel) idempotency guard — and ONLY through sendReadyReminder. The ordinary
// lifecycle send (sendOrderNotification) must keep treating a logged 'ready' as
// already sent.

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

import { sendOrderNotification, sendReadyReminder } from '@/lib/notifications/engine';

const ENV_KEYS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'NOTIFY_PROVIDER'];
const saved: Record<string, string | undefined> = {};

const order = {
  id: 'order-1',
  order_number: 1001,
  customer_name: 'Asha Rao',
  customer_phone: '+919876543210',
  order_type: 'takeaway',
} as never;

const fetchMock = vi.fn();

beforeEach(() => {
  state.existing = { id: 'n1', status: 'sent', attempts: 1, provider_ref: 'wamid.1' };
  state.upserts = [];
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ messages: [{ id: 'wamid.2' }] }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('sendReadyReminder', () => {
  it('re-sends over WhatsApp even though a ready message is already logged as sent', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    const res = await sendReadyReminder(order);
    expect(res.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.template.name).toBe('order_ready_1');
    expect(state.upserts[0]).toMatchObject({ event: 'ready', channel: 'whatsapp', status: 'sent' });
  });

  it('does not use the log stub: without credentials it refuses instead of faking a send', async () => {
    const res = await sendReadyReminder(order);
    expect(res).toEqual({ sent: false, skipped: 'not_configured:WHATSAPP_TOKEN,WHATSAPP_PHONE_ID' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.upserts).toHaveLength(0);
  });

  it('refuses an order with no phone', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    const res = await sendReadyReminder({ ...(order as object), customer_phone: '' } as never);
    expect(res).toEqual({ sent: false, skipped: 'no_phone' });
  });

  it('reports a provider rejection as not sent, with the reason', async () => {
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { message: 'Template paused' } }),
    });
    const res = await sendReadyReminder(order);
    expect(res.sent).toBe(false);
    expect(res.error).toContain('Template paused');
  });
});

describe('sendOrderNotification — normal idempotency is unchanged', () => {
  it('a second automatic ready send is still a no-op', async () => {
    process.env.NOTIFY_PROVIDER = 'whatsapp';
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    const res = await sendOrderNotification(order, 'ready');
    expect(res).toMatchObject({ sent: true, skipped: 'already_sent' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendOrderNotification — dine-in ready (D7)', () => {
  it('suppresses ready for a dine-in served at a table', async () => {
    const atTable = { ...(order as object), order_type: 'dine_in', table_id: 'table-1' } as never;
    expect(await sendOrderNotification(atTable, 'ready')).toEqual({ sent: false, skipped: 'dine_in_ready_suppressed' });
  });

  it('does not suppress it for a website dine-in (no table): the customer collects it', async () => {
    process.env.NOTIFY_PROVIDER = 'whatsapp';
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    const webDineIn = { ...(order as object), order_type: 'dine_in', table_id: null } as never;
    // Reaches the normal send path (here: the idempotency guard), not the D7 skip.
    expect(await sendOrderNotification(webDineIn, 'ready')).toMatchObject({ skipped: 'already_sent' });
  });
});
