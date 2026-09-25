import { beforeEach, describe, expect, it, vi } from 'vitest';

// PRN-8 — getStaffPrintOrder's loyalty augmentation. The receipt usually
// prints at payment/settle, well before an order reaches 'completed' (the
// status transition that actually posts the 'earn' ledger row — see
// earnForOrder in lib/loyalty/ledger.ts). Until that row exists,
// getStaffPrintOrder PROJECTS what the order is about to earn — same
// formula as earnForOrder (computeEarnedPoints), so the receipt still shows
// a real number instead of nothing, and rolls that projection into the
// balance shown too. This mocks getOrderWithCoupon, the admin Supabase
// client (for the loyalty_transactions lookup) and getBalance/
// getLoyaltyConfig (keeping the real, pure computeEarnedPoints via
// importActual) so the projection/no-double-count logic is exercised
// directly, without a live DB.

const state: {
  order: Record<string, unknown> | null;
  txRows: { type: string; points: number }[] | null;
  txError: unknown;
  config: { points_per_inr: number } | null;
  balance: number | null;
} = { order: null, txRows: [], txError: null, config: { points_per_inr: 1 }, balance: 0 };

vi.mock('@/lib/orders/getOrder', () => ({
  getOrderWithCoupon: () => Promise.resolve(state.order),
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => Promise.resolve({ data: state.txRows, error: state.txError }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/loyalty/ledger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/loyalty/ledger')>('@/lib/loyalty/ledger');
  return {
    ...actual,
    getLoyaltyConfig: () => Promise.resolve(state.config),
    getBalance: () => Promise.resolve(state.balance),
  };
});

const { getStaffPrintOrder } = await import('@/lib/orders/getStaffPrintOrder');

function baseOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    order_number: 1042,
    status: 'accepted',
    payment_status: 'paid',
    total_inr: 250,
    subtotal_inr: 240,
    user_id: 'user-1',
    customer_user_id: null,
    coupon_code: null,
    items: [],
    ...overrides,
  };
}

beforeEach(() => {
  state.order = null;
  state.txRows = [];
  state.txError = null;
  state.config = { points_per_inr: 1 };
  state.balance = 100;
});

describe('getStaffPrintOrder — loyalty points (PRN-8)', () => {
  it('projects points earned when no earn row exists yet, and rolls it into the balance shown', () => {
    state.order = baseOrder({ status: 'accepted', payment_status: 'paid', total_inr: 250 });
    state.txRows = []; // no earn row yet — receipt printed before order completion
    state.balance = 100;
    return getStaffPrintOrder('order-1').then((result) => {
      expect(result?.points_earned).toBe(250); // floor(250 * 1)
      expect(result?.points_redeemed).toBeNull();
      expect(result?.points_balance).toBe(350); // 100 (ledger) + 250 (projected)
    });
  });

  it('uses the real ledger earn row when one already exists, and does NOT double-add it to the balance', () => {
    state.order = baseOrder({ status: 'completed', payment_status: 'paid', total_inr: 250 });
    state.txRows = [{ type: 'earn', points: 250 }]; // already posted by earnForOrder
    state.balance = 350; // ledger balance already reflects the 250 earned
    return getStaffPrintOrder('order-1').then((result) => {
      expect(result?.points_earned).toBe(250);
      expect(result?.points_balance).toBe(350); // NOT 600 — no projection added on top
    });
  });

  it('does not project points earned for an unpaid order', () => {
    state.order = baseOrder({ status: 'accepted', payment_status: 'unpaid', total_inr: 250 });
    state.txRows = [];
    state.balance = 100;
    return getStaffPrintOrder('order-1').then((result) => {
      expect(result?.points_earned).toBeNull();
      expect(result?.points_balance).toBe(100); // just the ledger balance, nothing projected
    });
  });

  it('does not project points earned for a cancelled order even if it was paid', () => {
    state.order = baseOrder({ status: 'cancelled', payment_status: 'paid', total_inr: 250 });
    state.txRows = [];
    state.balance = 100;
    return getStaffPrintOrder('order-1').then((result) => {
      expect(result?.points_earned).toBeNull();
      expect(result?.points_balance).toBe(100);
    });
  });

  it('does not project points earned for a rejected order', () => {
    state.order = baseOrder({ status: 'rejected', payment_status: 'paid', total_inr: 250 });
    state.txRows = [];
    return getStaffPrintOrder('order-1').then((result) => {
      expect(result?.points_earned).toBeNull();
    });
  });

  it('shows nothing loyalty-related for a guest order with no linked account', () => {
    state.order = baseOrder({ status: 'accepted', payment_status: 'paid', total_inr: 250, user_id: null, customer_user_id: null });
    state.txRows = [];
    state.balance = 999; // must never be fetched/shown for a guest
    return getStaffPrintOrder('order-1').then((result) => {
      expect(result?.points_earned).toBeNull();
      expect(result?.points_redeemed).toBeNull();
      expect(result?.points_balance).toBeNull();
    });
  });

  it('reports points redeemed independently of the earn projection', () => {
    state.order = baseOrder({ status: 'accepted', payment_status: 'paid', total_inr: 250 });
    state.txRows = [{ type: 'redeem', points: -40 }]; // stored negative
    state.balance = 60;
    return getStaffPrintOrder('order-1').then((result) => {
      expect(result?.points_redeemed).toBe(40);
      expect(result?.points_earned).toBe(250); // still projected — no earn row yet
      expect(result?.points_balance).toBe(310); // 60 + 250 projected
    });
  });

  it('is non-fatal when the loyalty config lookup fails — the order still prints', () => {
    state.order = baseOrder({ status: 'accepted', payment_status: 'paid', total_inr: 250 });
    state.txRows = [];
    state.config = null; // getLoyaltyConfig failed/unset
    state.balance = 100;
    return getStaffPrintOrder('order-1').then((result) => {
      expect(result).not.toBeNull();
      expect(result?.points_earned).toBeNull(); // can't project without config
      expect(result?.points_balance).toBe(100);
    });
  });

  it('is non-fatal when the loyalty_transactions lookup errors — the order still prints', () => {
    state.order = baseOrder({ status: 'accepted', payment_status: 'paid', total_inr: 250 });
    state.txRows = null;
    state.txError = { message: 'connection reset' };
    state.balance = 100;
    return getStaffPrintOrder('order-1').then((result) => {
      expect(result).not.toBeNull();
      // No rows read (errored) means no confirmed earn row — falls back to projection.
      expect(result?.points_earned).toBe(250);
      expect(result?.points_redeemed).toBeNull();
    });
  });
});
