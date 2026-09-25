import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for GET /api/cron/feedback-requests.
//
// What these hold, in the order they matter:
//   1. Fails CLOSED without CRON_SECRET / with a wrong Bearer token — same
//      posture as every other /api/cron/* route.
//   2. Only claims + sends rows the claim RPC actually returns ("due
//      selection" + "idempotent claim" both live in that one RPC call, which
//      is mocked here as the atomic boundary it is in production).
//   3. Every skip rule (cancelled/rejected order, no phone, opted-out) is
//      re-checked at send time and recorded on the row instead of sent.
//   4. The whole run is skipped (nothing even claimed) when feedback is
//      toggled off — a temporary toggle must not permanently mark due rows
//      'skipped'.

const state: {
  feedbackEnabled: boolean;
  claimed: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  optedOutPhones: string[];
  updates: { id: string; patch: Record<string, unknown> }[];
} = { feedbackEnabled: true, claimed: [], orders: [], optedOutPhones: [], updates: [] };

const { sendFeedbackTemplate } = vi.hoisted(() => ({
  sendFeedbackTemplate: vi.fn(() => Promise.resolve({ sent: true, reason: '' })),
}));

vi.mock('@/lib/feedback/send', () => ({ sendFeedbackTemplate }));

vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () =>
    Promise.resolve({
      feedback_enabled: state.feedbackEnabled,
      feedback_delay_min: 30,
      google_review_url: '',
    }),
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    rpc: (fn: string, _args: Record<string, unknown>) => {
      if (fn === 'claim_feedback_requests') return Promise.resolve({ data: state.claimed, error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    },
    from: (table: string) => {
      const filters: { col: string; vals: unknown[] }[] = [];
      let op: 'select' | 'update' = 'select';
      let patch: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          op = 'update';
          patch = p;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filters.push({ col, vals: [val] });
          if (op === 'update') {
            state.updates.push({ id: val as string, patch });
            return Promise.resolve({ error: null });
          }
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push({ col, vals });
          if (table === 'orders') {
            return Promise.resolve({ data: state.orders.filter((o) => vals.includes(o.id)), error: null });
          }
          if (table === 'whatsapp_opt_outs') {
            return Promise.resolve({
              data: state.optedOutPhones.filter((p) => vals.includes(p)).map((phone) => ({ phone })),
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        },
      });
      return chain;
    },
  }),
}));

process.env.CRON_SECRET = 'cron_secret';

const { GET, POST } = await import('@/app/api/cron/feedback-requests/route');

const run = (auth = 'Bearer cron_secret') =>
  GET(new Request('http://localhost/api/cron/feedback-requests', { headers: auth ? { authorization: auth } : {} }));

// pg_cron's net.http_post issues a POST, not a GET — this is the method the
// scheduled job actually calls in production.
const runPost = (auth = 'Bearer cron_secret') =>
  POST(
    new Request('http://localhost/api/cron/feedback-requests', {
      method: 'POST',
      headers: auth ? { authorization: auth } : {},
    }),
  );

function claimRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'req-1',
    order_id: 'order-1',
    phone: '+919876543210',
    customer_name: 'Priya',
    status: 'pending',
    ...over,
  };
}

beforeEach(() => {
  state.feedbackEnabled = true;
  state.claimed = [];
  state.orders = [{ id: 'order-1', status: 'completed', order_number: 1089, customer_phone: '+919876543210' }];
  state.optedOutPhones = [];
  state.updates = [];
  sendFeedbackTemplate.mockClear();
  sendFeedbackTemplate.mockResolvedValue({ sent: true, reason: '' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/cron/feedback-requests — auth', () => {
  it('fails CLOSED with no Authorization header', async () => {
    const res = await run('');
    expect(res.status).toBe(401);
    expect(sendFeedbackTemplate).not.toHaveBeenCalled();
  });

  it('fails CLOSED with a wrong bearer token', async () => {
    const res = await run('Bearer wrong');
    expect(res.status).toBe(401);
  });

  it('fails CLOSED when CRON_SECRET itself is unset', async () => {
    const original = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await run('Bearer cron_secret');
      expect(res.status).toBe(401);
    } finally {
      process.env.CRON_SECRET = original;
    }
  });
});

describe('POST /api/cron/feedback-requests — what pg_cron actually calls', () => {
  it('a POST with a valid bearer token works exactly like the GET path', async () => {
    state.claimed = [claimRow({ id: 'req-1', order_id: 'order-1' })];
    const res = await runPost();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, claimed: 1, sent: 1, skipped: 0, failed: 0 });
    expect(sendFeedbackTemplate).toHaveBeenCalledTimes(1);
  });

  it('POST also fails CLOSED without a valid bearer token', async () => {
    const res = await runPost('Bearer wrong');
    expect(res.status).toBe(401);
    expect(sendFeedbackTemplate).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/feedback-requests — feature toggle', () => {
  it('claims nothing when feedback is disabled, rather than skipping due rows', async () => {
    state.feedbackEnabled = false;
    state.claimed = [claimRow()];
    const res = await run();
    const body = await res.json();
    expect(body).toMatchObject({ enabled: false, claimed: 0 });
    expect(sendFeedbackTemplate).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]); // nothing marked 'skipped' — stays pending
  });
});

describe('GET /api/cron/feedback-requests — due selection + claim', () => {
  it('sends every eligible claimed row', async () => {
    state.claimed = [claimRow({ id: 'req-1', order_id: 'order-1' })];
    const res = await run();
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, claimed: 1, sent: 1, skipped: 0, failed: 0 });
    expect(sendFeedbackTemplate).toHaveBeenCalledTimes(1);
    expect(sendFeedbackTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'req-1', order_id: 'order-1' }),
      1089,
      expect.objectContaining({ admin: expect.anything() }),
    );
  });

  it('does nothing when the claim RPC returns no rows', async () => {
    state.claimed = [];
    const res = await run();
    expect(await res.json()).toMatchObject({ enabled: true, claimed: 0, sent: 0, skipped: 0, failed: 0 });
    expect(sendFeedbackTemplate).not.toHaveBeenCalled();
  });

  it('processes a full batch, one send per claimed row', async () => {
    state.claimed = [claimRow({ id: 'req-1' }), claimRow({ id: 'req-2', order_id: 'order-1' })];
    const res = await run();
    expect(await res.json()).toMatchObject({ claimed: 2, sent: 2 });
    expect(sendFeedbackTemplate).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/cron/feedback-requests — skip rules re-checked at send time', () => {
  it('skips a request whose order was cancelled since it was queued', async () => {
    state.orders = [{ id: 'order-1', status: 'cancelled', order_number: 1089, customer_phone: '+919876543210' }];
    state.claimed = [claimRow()];
    const res = await run();
    expect(await res.json()).toMatchObject({ claimed: 1, sent: 0, skipped: 1, failed: 0 });
    expect(sendFeedbackTemplate).not.toHaveBeenCalled();
    expect(state.updates).toEqual([{ id: 'req-1', patch: { status: 'skipped', skip_reason: 'order_cancelled' } }]);
  });

  it('skips a request whose order was rejected', async () => {
    state.orders = [{ id: 'order-1', status: 'rejected', order_number: 1089, customer_phone: '+919876543210' }];
    state.claimed = [claimRow()];
    const res = await run();
    expect(await res.json()).toMatchObject({ skipped: 1 });
    expect(state.updates[0].patch.skip_reason).toBe('order_cancelled');
  });

  it('skips a request with no phone', async () => {
    state.claimed = [claimRow({ phone: '' })];
    const res = await run();
    expect(await res.json()).toMatchObject({ skipped: 1 });
    expect(state.updates[0].patch.skip_reason).toBe('no_phone');
  });

  it('skips a request whose phone opted out', async () => {
    state.optedOutPhones = ['+919876543210'];
    state.claimed = [claimRow()];
    const res = await run();
    expect(await res.json()).toMatchObject({ skipped: 1 });
    expect(state.updates[0].patch.skip_reason).toBe('opted_out');
  });

  it('skips a request whose order can no longer be found', async () => {
    state.orders = [];
    state.claimed = [claimRow()];
    const res = await run();
    expect(await res.json()).toMatchObject({ skipped: 1 });
    expect(state.updates[0].patch.skip_reason).toBe('order_not_found');
  });

  it('counts a failed send separately from a skip', async () => {
    sendFeedbackTemplate.mockResolvedValueOnce({ sent: false, reason: 'send_failed' });
    state.claimed = [claimRow()];
    const res = await run();
    expect(await res.json()).toMatchObject({ sent: 0, skipped: 0, failed: 1 });
  });

  it('counts a not-configured/disabled outcome as a skip, not a failure', async () => {
    sendFeedbackTemplate.mockResolvedValueOnce({ sent: false, reason: 'not_configured:WHATSAPP_TOKEN' });
    state.claimed = [claimRow()];
    const res = await run();
    expect(await res.json()).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
  });
});
