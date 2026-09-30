import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// /staff-print/[id]/[type] — the page the print dock's hidden iframe (and the
// desktop shell's fallback window) loads. HIOC Ritual: the SALE of a pass is a
// payment, not food, so a KOT (or a pickup token) for it is refused here exactly
// as the JSON route refuses it: the dock shows a failed job, and no phantom order
// reaches the kitchen's rail. Its receipt prints as usual.

const state: { actor: unknown; order: Record<string, unknown> | null } = { actor: { user: { id: 'u1' } }, order: null };

class NotFound extends Error {}
class Redirect extends Error {}

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound('not found');
  },
  redirect: () => {
    throw new Redirect('redirect');
  },
}));
vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/orders/getStaffPrintOrder', () => ({ getStaffPrintOrder: () => Promise.resolve(state.order) }));
vi.mock('@/components/print/StaffTickets', () => ({
  KotTicket: () => null,
  ReceiptTicket: () => null,
  TokenSlip: () => null,
}));
vi.mock('@/components/print/AutoPrint', () => ({ AutoPrint: () => null }));
vi.mock('@/app/staff-print/[id]/[type]/PrintOnLoad', () => ({ PrintOnLoad: () => null }));

const { default: StaffPrintPage } = await import('@/app/staff-print/[id]/[type]/page');

const ID = '11111111-1111-1111-1111-111111111111';
const page = (type: string) => StaffPrintPage({ params: { id: ID, type }, searchParams: {} });

beforeEach(() => {
  state.actor = { user: { id: 'u1' } };
  state.order = { id: 'order-1', order_kind: 'coffee_pass', items: [] };
});

describe('/staff-print for a HIOC Ritual sale', () => {
  it.each(['kot', 'token'])('has no %s: not found', async (type) => {
    await expect(page(type)).rejects.toBeInstanceOf(NotFound);
  });

  it('prints its receipt', async () => {
    const element = await page('receipt');
    expect(() => renderToStaticMarkup(element as never)).not.toThrow();
  });

  it('leaves an ordinary order’s KOT and token alone', async () => {
    state.order = { id: 'order-1', order_kind: 'menu', items: [] };
    for (const type of ['kot', 'token', 'receipt']) {
      await expect(page(type)).resolves.toBeTruthy();
    }
  });

  it('treats a row with no order_kind (read before the migration) as an ordinary order', async () => {
    state.order = { id: 'order-1', items: [] };
    await expect(page('kot')).resolves.toBeTruthy();
  });

  it('still sends a signed-out visitor to the staff login before anything else', async () => {
    state.actor = null;
    await expect(page('kot')).rejects.toBeInstanceOf(Redirect);
  });
});
