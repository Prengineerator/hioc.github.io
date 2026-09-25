import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — GET /api/print/ticket/[id]/[type], the desktop shell's native
// ESC/POS driver source (PRN-3). This is the route printing breaks on if it
// still required a classic session: the shell calls it directly against an
// enrolled, PIN-switched counter with nobody signed in classically.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  order: Record<string, unknown> | null;
} = { actor: null, order: { id: 'order-1' } };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/orders/getStaffPrintOrder', () => ({ getStaffPrintOrder: () => Promise.resolve(state.order) }));
vi.mock('@/lib/print/ticketModel', () => ({ buildTicketDoc: (order: unknown, type: string) => ({ order, type }) }));

const { GET } = await import('@/app/api/print/ticket/[id]/[type]/route');

const ORDER_ID = '11111111-1111-1111-1111-111111111111';
function ctx(type = 'kot') {
  return { params: { id: ORDER_ID, type } };
}

beforeEach(() => {
  state.actor = null;
  state.order = { id: 'order-1' };
});

describe('GET /api/print/ticket/[id]/[type]', () => {
  it('401s with no session and no operator', async () => {
    const res = await GET(new Request('https://x'), ctx());
    expect(res.status).toBe(401);
  });

  it('serves the ticket doc for a classic staff session', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    const res = await GET(new Request('https://x'), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).doc).toEqual({ order: state.order, type: 'kot' });
  });

  it('PIN-3: an enrolled-device operator (no classic session) can still print — the whole point of this route', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const res = await GET(new Request('https://x'), ctx('receipt'));
    expect(res.status).toBe(200);
  });

  it('404s an unknown print type', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    const res = await GET(new Request('https://x'), ctx('bogus'));
    expect(res.status).toBe(404);
  });

  it('404s when the order does not exist', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.order = null;
    const res = await GET(new Request('https://x'), ctx());
    expect(res.status).toBe(404);
  });
});
