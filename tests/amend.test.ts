import { beforeEach, describe, expect, it, vi } from 'vitest';

// FND3-4 (order corrections — line voids). Two layers:
//  1. Pure money test on lib/orders/amend.ts — no mocks: recomputed subtotal ≡
//     Σ non-voided line totals, dine-in drops packaging (D5), discount clamped
//     to the new subtotal (D8). computeBill runs for real.
//  2. Handler-level integration test for POST /api/orders/[id]/amend against a
//     mocked Supabase admin client + auth + permission matrix + settings, so the
//     route's decision logic — authz gate, preconditions, the guarded totals
//     write, and the order_amendments audit row — is exercised end-to-end.

import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';
import { recomputeOrderTotals } from '@/lib/orders/amend';

// --- Shared, per-test mutable state the route mocks read from. ---------------
const state: {
  user: { id: string } | null;
  canVoid: boolean;
  current: Record<string, unknown> | null; // the loaded order (+ embedded order_items)
  updated: Record<string, unknown> | null; // the guarded totals update result (null = lost race)
  fullOrder: Record<string, unknown> | null; // the reload feeding toOrderResponse
  orderPatch?: Record<string, unknown>; // the guarded totals write payload
  itemUpdate?: Record<string, unknown>; // the order_items void (or rollback) payload
  amendmentRow?: Record<string, unknown>; // the order_amendments audit row
} = { user: null, canVoid: true, current: null, updated: null, fullOrder: null };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          if (table === 'orders') state.orderPatch = p; // guarded totals write
          if (table === 'order_items') state.itemUpdate = p; // void (or rollback)
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'order_amendments') state.amendmentRow = row;
          return Promise.resolve({ error: null });
        },
        eq: () => chain,
        // Order load (isUpdate=false) → current; guarded totals write → updated.
        maybeSingle: () =>
          Promise.resolve(
            ctx.isUpdate ? { data: state.updated, error: null } : { data: state.current, error: null },
          ),
        // The reload (select → eq → single) that feeds toOrderResponse.
        single: () => Promise.resolve({ data: state.fullOrder, error: null }),
        // Makes a bare `.update().eq()` (the order_items void/rollback) awaitable.
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getStaffUser: () => Promise.resolve(state.user),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: () => Promise.resolve(state.canVoid),
}));
// Real computeBill (money is under test) fed by a deterministic settings row.
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () =>
    Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 20 }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));

// Imported after mocks are registered (vi.mock is hoisted).
const { POST } = await import('@/app/api/orders/[id]/amend/route');

const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING_ITEM = '99999999-9999-4999-8999-999999999999';

const params = { params: { id: ORDER_ID } };
function req(body: unknown) {
  return new Request(`http://t/api/orders/${ORDER_ID}/amend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 1. Pure recompute (no mocks) — property-style money checks.
// ---------------------------------------------------------------------------
describe('recomputeOrderTotals (FND3-4 money, no mocks)', () => {
  const settings: StoreSettings = { ...FALLBACK_STORE_SETTINGS, gst_percent: 5, packaging_charge_inr: 20 };

  const itemSets: { voided: boolean; line_total_inr: number }[][] = [
    [{ voided: false, line_total_inr: 200 }, { voided: false, line_total_inr: 100 }],
    [{ voided: true, line_total_inr: 200 }, { voided: false, line_total_inr: 100 }],
    [{ voided: false, line_total_inr: 250 }, { voided: false, line_total_inr: 250 }],
    [{ voided: true, line_total_inr: 500 }, { voided: false, line_total_inr: 80 }],
    [
      { voided: false, line_total_inr: 333 },
      { voided: false, line_total_inr: 167 },
      { voided: true, line_total_inr: 99 },
    ],
  ];
  const discounts = [0, 50, 120, 100000];

  it('subtotal ≡ Σ non-voided line totals; discount clamped to subtotal; total never negative', () => {
    for (const items of itemSets) {
      const expectedSubtotal = items
        .filter((i) => !i.voided)
        .reduce((s, i) => s + i.line_total_inr, 0);
      for (const discountInr of discounts) {
        for (const orderType of ['takeaway', 'dine_in'] as const) {
          const bill = recomputeOrderTotals({ items, settings, orderType, discountInr });
          expect(bill.subtotal_inr).toBe(expectedSubtotal);
          expect(bill.discount_inr).toBe(Math.min(discountInr, expectedSubtotal)); // clamp (D8)
          expect(bill.total_inr).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('dine-in drops packaging to 0; takeaway keeps it', () => {
    const items = [{ voided: false, line_total_inr: 100 }];
    const dine = recomputeOrderTotals({ items, settings, orderType: 'dine_in', discountInr: 0 });
    const take = recomputeOrderTotals({ items, settings, orderType: 'takeaway', discountInr: 0 });
    expect(dine.packaging_inr).toBe(0);
    expect(take.packaging_inr).toBe(20);
    expect(take.total_inr - dine.total_inr).toBe(20); // the dropped packaging
  });

  it('clamps an over-large stored discount to the shrunken subtotal', () => {
    const items = [{ voided: true, line_total_inr: 500 }, { voided: false, line_total_inr: 80 }];
    const bill = recomputeOrderTotals({ items, settings, orderType: 'takeaway', discountInr: 1000 });
    expect(bill.subtotal_inr).toBe(80);
    expect(bill.discount_inr).toBe(80); // clamped, so total can't go negative
  });
});

// ---------------------------------------------------------------------------
// 2. Handler — POST /api/orders/[id]/amend.
// ---------------------------------------------------------------------------
describe('POST /api/orders/[id]/amend', () => {
  beforeEach(() => {
    state.user = { id: 'mgr-1' };
    state.canVoid = true;
    state.current = {
      id: ORDER_ID,
      status: 'preparing',
      version: 5,
      order_type: 'dine_in',
      payment_status: 'unpaid',
      discount_inr: 0,
      order_items: [
        { id: ITEM_A, voided: false, line_total_inr: 200 },
        { id: ITEM_B, voided: false, line_total_inr: 100 },
      ],
    };
    state.updated = { id: ORDER_ID };
    state.fullOrder = { id: ORDER_ID, status: 'preparing', order_items: [] };
    state.orderPatch = undefined;
    state.itemUpdate = undefined;
    state.amendmentRow = undefined;
  });

  it('401s without a staff session', async () => {
    state.user = null;
    const res = await POST(req({ item_id: ITEM_A, reason: 'wrong item' }), params);
    expect(res.status).toBe(401);
  });

  it('403s a staffer without the void_line permission', async () => {
    state.canVoid = false;
    const res = await POST(req({ item_id: ITEM_A, reason: 'wrong item' }), params);
    expect(res.status).toBe(403);
    expect(state.itemUpdate).toBeUndefined();
    expect(state.amendmentRow).toBeUndefined();
  });

  it('400s a bad item_id or an empty reason', async () => {
    const badId = await POST(req({ item_id: 'not-a-uuid', reason: 'wrong' }), params);
    expect(badId.status).toBe(400);
    const noReason = await POST(req({ item_id: ITEM_A, reason: '   ' }), params);
    expect(noReason.status).toBe(400);
  });

  it('404s a missing order', async () => {
    state.current = null;
    const res = await POST(req({ item_id: ITEM_A, reason: 'wrong' }), params);
    expect(res.status).toBe(404);
  });

  it('404s when the item is not a line on this order', async () => {
    const res = await POST(req({ item_id: MISSING_ITEM, reason: 'wrong' }), params);
    expect(res.status).toBe(404);
  });

  it('voids a line, recomputes totals under the version guard, and audits it', async () => {
    const res = await POST(req({ item_id: ITEM_A, reason: 'wrong size' }), params);
    expect(res.status).toBe(200);

    // The line was voided (never deleted), attributed to the acting manager.
    expect(state.itemUpdate?.voided).toBe(true);
    expect(state.itemUpdate?.void_reason).toBe('wrong size');
    expect(state.itemUpdate?.voided_by).toBe('mgr-1');

    // Totals recomputed from the REMAINING line (B = ₹100); dine-in drops
    // packaging (D5): subtotal 100, GST 5, packaging 0, total 105.
    expect(state.orderPatch?.subtotal_inr).toBe(100);
    expect(state.orderPatch?.tax_inr).toBe(5);
    expect(state.orderPatch?.packaging_inr).toBe(0);
    expect(state.orderPatch?.total_inr).toBe(105);
    expect(state.orderPatch?.version).toBe(6); // current.version + 1

    // Audit row written with the voided line's total in the payload.
    expect(state.amendmentRow?.kind).toBe('void_item');
    expect(state.amendmentRow?.staff_id).toBe('mgr-1');
    const payload = state.amendmentRow?.payload as { order_item_id: string; line_total_inr: number };
    expect(payload.order_item_id).toBe(ITEM_A);
    expect(payload.line_total_inr).toBe(200);
  });

  it('409s a paid order (corrections go through the refund path)', async () => {
    state.current = { ...state.current!, payment_status: 'paid' };
    const res = await POST(req({ item_id: ITEM_A, reason: 'wrong' }), params);
    expect(res.status).toBe(409);
    expect(state.itemUpdate).toBeUndefined();
    expect(state.amendmentRow).toBeUndefined();
  });

  it('409s an order that is not open (completed)', async () => {
    state.current = { ...state.current!, status: 'completed' };
    const res = await POST(req({ item_id: ITEM_A, reason: 'wrong' }), params);
    expect(res.status).toBe(409);
    expect(state.itemUpdate).toBeUndefined();
  });

  it('409s voiding the only remaining line (would empty the order)', async () => {
    state.current = {
      ...state.current!,
      order_items: [{ id: ITEM_A, voided: false, line_total_inr: 200 }],
    };
    const res = await POST(req({ item_id: ITEM_A, reason: 'wrong' }), params);
    expect(res.status).toBe(409);
    expect(state.itemUpdate).toBeUndefined();
    expect(state.amendmentRow).toBeUndefined();
  });

  it('409s voiding a line that is already voided', async () => {
    state.current = {
      ...state.current!,
      order_items: [
        { id: ITEM_A, voided: true, line_total_inr: 200 },
        { id: ITEM_B, voided: false, line_total_inr: 100 },
      ],
    };
    const res = await POST(req({ item_id: ITEM_A, reason: 'wrong' }), params);
    expect(res.status).toBe(409);
    expect(state.itemUpdate).toBeUndefined();
  });

  it('409s on a lost version race (guarded update returns no row) and writes no audit', async () => {
    state.updated = null; // guarded totals write matches no row
    const res = await POST(req({ item_id: ITEM_A, reason: 'wrong' }), params);
    expect(res.status).toBe(409);
    expect(state.amendmentRow).toBeUndefined(); // no audit on a failed amend
  });
});
