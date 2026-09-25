import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/owner/feedback/[id]/reply — owner-only, the 24h customer-service
// window rule. Meta only allows free-text OUTSIDE a template within 24h of
// the customer's most recent inbound message; this route must enforce that
// server-side (the UI disabling the box is not a security boundary).

const state: {
  owner: { id: string } | null;
  request: Record<string, unknown> | null;
  lastInboundAt: string | null;
  sendResult: { ok: boolean; providerRef: string; error: string };
  inserted: Record<string, unknown>[];
} = { owner: { id: 'owner-1' }, request: null, lastInboundAt: null, sendResult: { ok: true, providerRef: 'wamid.OUT', error: '' }, inserted: [] };

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(true) }));

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('@/lib/notifications/adapters', () => ({ whatsappAdapter: { send: sendMock } }));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const filters: { col: string; val: unknown }[] = [];
      let order: string | null = null;
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push({ col, val });
          return chain;
        },
        order: () => {
          order = 'created_at';
          return chain;
        },
        limit: () => chain,
        maybeSingle: () => {
          if (table === 'feedback_requests') {
            return Promise.resolve({ data: state.request, error: null });
          }
          if (table === 'feedback_messages') {
            void order;
            return Promise.resolve({
              data: state.lastInboundAt ? { created_at: state.lastInboundAt } : null,
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert: (row: Record<string, unknown>) => {
          state.inserted.push(row);
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: { id: 'msg-1', ...row }, error: null }),
            }),
          };
        },
      });
      return chain;
    },
  }),
}));

const { POST } = await import('@/app/api/owner/feedback/[id]/reply/route');

function req(body: unknown) {
  return new Request('http://t', { method: 'POST', body: JSON.stringify(body) });
}
const params = { params: { id: '11111111-1111-1111-1111-111111111111' } };

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.request = {
    id: params.params.id,
    order_id: 'order-1',
    phone: '+919876543210',
    customer_name: 'Priya',
  };
  state.lastInboundAt = null;
  state.inserted = [];
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ok: true, providerRef: 'wamid.OUT', error: '' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/owner/feedback/[id]/reply', () => {
  it('requires an owner session', async () => {
    state.owner = null;
    const res = await POST(req({ body: 'hi' }), params);
    expect(res.status).toBe(403);
  });

  it('requires a non-empty body', async () => {
    const res = await POST(req({ body: '   ' }), params);
    expect(res.status).toBe(400);
  });

  it('404s an unknown thread', async () => {
    state.request = null;
    const res = await POST(req({ body: 'hello' }), params);
    expect(res.status).toBe(404);
  });

  it('sends within the 24h window and logs the outbound message', async () => {
    state.lastInboundAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const res = await POST(req({ body: 'Thanks for the feedback!' }), params);
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+919876543210', body: 'Thanks for the feedback!' }),
    );
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ direction: 'out', sent_by: 'owner-1', status: 'sent' });
  });

  it('refuses to send OUTSIDE the 24h window, with a clear reason, and never calls the adapter', async () => {
    state.lastInboundAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const res = await POST(req({ body: 'Thanks for the feedback!' }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/24-hour/i);
    expect(sendMock).not.toHaveBeenCalled();
    expect(state.inserted).toEqual([]);
  });

  it('refuses to send when the customer has NEVER messaged (no inbound at all)', async () => {
    state.lastInboundAt = null;
    const res = await POST(req({ body: 'hi' }), params);
    expect(res.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('is allowed right at the boundary — just under 24h', async () => {
    state.lastInboundAt = new Date(Date.now() - 23.9 * 60 * 60 * 1000).toISOString();
    const res = await POST(req({ body: 'hi' }), params);
    expect(res.status).toBe(200);
  });

  it('surfaces an adapter failure as a 502 but still logs the attempted message', async () => {
    state.lastInboundAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    sendMock.mockResolvedValue({ ok: false, providerRef: '', error: 'Meta rejected it' });
    const res = await POST(req({ body: 'hi' }), params);
    expect(res.status).toBe(502);
    expect(state.inserted[0]).toMatchObject({ direction: 'out', status: 'failed', error: 'Meta rejected it' });
  });
});
