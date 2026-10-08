import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/orders/[id]/remind — staff "Send pickup reminder". Mocks the admin
// client (order load + the conditional claim UPDATE), the auth gate and the
// engine, so the route's own decisions are what's under test: the gates, the
// 5-minute cooldown, the atomic claim, and rolling the stamp back on a failed
// send.

const VALID_ID = '11111111-1111-1111-1111-111111111111';
const NOW = Date.parse('2026-09-29T10:00:00.000Z');

interface RecordedUpdate {
  patch: Record<string, unknown>;
  filters: [string, unknown][];
  or?: string;
}

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  order: Record<string, unknown> | null;
  claimRow: { id: string } | null; // what the conditional UPDATE ... RETURNING gives back
  claimError: { message: string } | null;
  updates: RecordedUpdate[];
  send: { sent: boolean; skipped?: string; error?: string };
} = {
  actor: null,
  order: null,
  claimRow: null,
  claimError: null,
  updates: [],
  send: { sent: true },
};

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      let update: RecordedUpdate | null = null;
      const chain: Record<string, unknown> = {
        // Awaiting the chain directly (the rollback UPDATE has no .select()).
        then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
      };
      Object.assign(chain, {
        select: () => chain,
        update: (patch: Record<string, unknown>) => {
          update = { patch, filters: [] };
          state.updates.push(update);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          update?.filters.push([col, val]);
          return chain;
        },
        or: (expr: string) => {
          if (update) update.or = expr;
          return chain;
        },
        maybeSingle: () =>
          Promise.resolve(
            update ? { data: state.claimRow, error: state.claimError } : { data: state.order, error: null },
          ),
      });
      return chain;
    },
  }),
}));
const sendReadyReminder = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notifications/engine', () => ({ sendReadyReminder }));

const { POST } = await import('@/app/api/orders/[id]/remind/route');

const ctx = (id: string) => ({ params: { id } });
const call = (id = VALID_ID) => POST(new Request('https://x', { method: 'POST' }), ctx(id));

const readyOrder = (over: Record<string, unknown> = {}) => ({
  id: VALID_ID,
  status: 'ready',
  order_type: 'takeaway',
  customer_phone: '+919999999999',
  customer_name: 'Asha',
  order_number: 42,
  pickup_reminded_at: null,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
  state.order = readyOrder();
  state.claimRow = { id: VALID_ID };
  state.claimError = null;
  state.updates = [];
  state.send = { sent: true };
  sendReadyReminder.mockReset();
  sendReadyReminder.mockImplementation(() => Promise.resolve(state.send));
});

describe('POST /api/orders/[id]/remind', () => {
  it('401s with no session and no operator', async () => {
    state.actor = null;
    expect((await call()).status).toBe(401);
    expect(sendReadyReminder).not.toHaveBeenCalled();
  });

  it('404s a malformed id and an unknown order', async () => {
    expect((await call('nope')).status).toBe(404);
    state.order = null;
    expect((await call()).status).toBe(404);
  });

  it('409s unless the order is Ready', async () => {
    for (const status of ['received', 'accepted', 'preparing', 'completed', 'cancelled']) {
      state.order = readyOrder({ status });
      expect((await call()).status).toBe(409);
    }
    expect(sendReadyReminder).not.toHaveBeenCalled();
  });

  it('409s with no customer phone', async () => {
    state.order = readyOrder({ customer_phone: '' });
    expect((await call()).status).toBe(409);
    expect(sendReadyReminder).not.toHaveBeenCalled();
  });

  it('409s a dine-in order served at a table', async () => {
    state.order = readyOrder({ order_type: 'dine_in', table_id: 'table-1' });
    expect((await call()).status).toBe(409);
  });

  it('reminds a website dine-in (no table): it is collected at the counter', async () => {
    state.order = readyOrder({ order_type: 'dine_in', table_id: null });
    expect((await call()).status).toBe(200);
    expect(sendReadyReminder).toHaveBeenCalledTimes(1);
  });

  it('429s with retry_after_seconds inside the 5-minute cooldown, sending nothing', async () => {
    state.order = readyOrder({ pickup_reminded_at: new Date(NOW - 120_000).toISOString() });
    const res = await call();
    expect(res.status).toBe(429);
    expect((await res.json()).retry_after_seconds).toBe(180);
    expect(res.headers.get('Retry-After')).toBe('180');
    expect(sendReadyReminder).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it('429s when another tap won the conditional claim (race)', async () => {
    state.claimRow = null;
    const res = await call();
    expect(res.status).toBe(429);
    expect((await res.json()).retry_after_seconds).toBe(300);
    expect(sendReadyReminder).not.toHaveBeenCalled();
  });

  it('sends, stamps pickup_reminded_at, and reports it', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reminded_at: new Date(NOW).toISOString(), delivered: { whatsapp: true } });
    expect(sendReadyReminder).toHaveBeenCalledTimes(1);
    const claim = state.updates[0];
    expect(claim.patch).toEqual({ pickup_reminded_at: new Date(NOW).toISOString() });
    // The claim only succeeds for an order still Ready whose last reminder is
    // null or at least 5 minutes old.
    expect(claim.filters).toContainEqual(['status', 'ready']);
    expect(claim.or).toBe(
      `pickup_reminded_at.is.null,pickup_reminded_at.lte.${new Date(NOW - 300_000).toISOString()}`,
    );
  });

  it('allows a reminder again once the cooldown has passed', async () => {
    state.order = readyOrder({ pickup_reminded_at: new Date(NOW - 300_000).toISOString() });
    expect((await call()).status).toBe(200);
  });

  it('503s when WhatsApp is not configured, and rolls the stamp back', async () => {
    state.send = { sent: false, skipped: 'not_configured:WHATSAPP_TOKEN,WHATSAPP_PHONE_ID' };
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not set up/i);
    const rollback = state.updates[1];
    expect(rollback.patch).toEqual({ pickup_reminded_at: null });
    expect(rollback.filters).toContainEqual(['pickup_reminded_at', new Date(NOW).toISOString()]);
  });

  it('503s when notifications are switched off', async () => {
    state.send = { sent: false, skipped: 'notifications_disabled' };
    expect((await call()).status).toBe(503);
  });

  it('502s when Meta rejects the send, restoring the previous stamp', async () => {
    const previous = new Date(NOW - 900_000).toISOString();
    state.order = readyOrder({ pickup_reminded_at: previous });
    state.send = { sent: false, error: 'Template paused' };
    const res = await call();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('Template paused');
    expect(state.updates[1].patch).toEqual({ pickup_reminded_at: previous });
  });

  it('500s clearly when the column is missing (migration not applied)', async () => {
    state.claimError = { message: 'column "pickup_reminded_at" does not exist' };
    const res = await call();
    expect(res.status).toBe(500);
    expect(sendReadyReminder).not.toHaveBeenCalled();
  });

  it('works for an enrolled-device operator', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    expect((await call()).status).toBe(200);
  });
});
