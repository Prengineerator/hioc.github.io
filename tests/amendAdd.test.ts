import { beforeEach, describe, expect, it, vi } from 'vitest';

// TAB-1 — POST /api/orders/[id]/amend with { op: 'add' }.
//
// The gap this closes: the corrections engine could only VOID, so "two more
// coffees for table 4" created a SECOND order and a second bill. These tests
// cover the safety model that makes adding to a live bill acceptable: the
// open/unpaid preconditions, server-side pricing (never the client's numbers),
// the recompute under the optimistic version guard, and — the important one —
// that a LOST RACE removes the lines it just inserted instead of leaving the
// order half-extended.

const state: {
  user: { id: string } | null;
  permitted: boolean;
  order: Record<string, unknown> | null;
  guarded: Record<string, unknown> | null; // null = lost version race
  menuRows: Record<string, unknown>[];
  orderPatch?: Record<string, unknown>;
  amendmentRow?: Record<string, unknown>;
  insertedItems: Record<string, unknown>[];
  deletedIds: string[];
} = {
  user: null,
  permitted: true,
  order: null,
  guarded: null,
  menuRows: [],
  insertedItems: [],
  deletedIds: [],
};

let itemSeq = 0;

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false, isInsert: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          if (table === 'orders') state.orderPatch = p;
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          ctx.isInsert = true;
          if (table === 'order_amendments') {
            state.amendmentRow = row;
            return Promise.resolve({ error: null });
          }
          if (table === 'order_items') {
            state.insertedItems.push(row);
            return chain; // .select('id').single() follows
          }
          return Promise.resolve({ error: null }); // order_item_addons
        },
        delete: () => {
          ctx.isUpdate = true;
          return chain;
        },
        eq: () => chain,
        in: (_col: string, values: string[]) => {
          // Either the menu load or the rollback delete.
          if (table === 'menu_items') return Promise.resolve({ data: state.menuRows, error: null });
          state.deletedIds.push(...values);
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: () =>
          Promise.resolve(
            ctx.isUpdate ? { data: state.guarded, error: null } : { data: state.order, error: null },
          ),
        single: () =>
          Promise.resolve(
            // order_items insert → the new row's id; otherwise the final reload.
            ctx.isInsert
              ? { data: { id: `new-item-${++itemSeq}` }, error: null }
              : { data: { ...(state.order ?? {}), order_items: [] }, error: null },
          ),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getStaffUser: () => Promise.resolve(state.user) }));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(state.permitted) }));
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () =>
    Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 20 }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));

const { POST } = await import('@/app/api/orders/[id]/amend/route');

const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const LATTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LATTE_REG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const params = { params: { id: ORDER_ID } };
function req(body: unknown) {
  return new Request(`http://t/api/orders/${ORDER_ID}/amend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const addBody = (quantity = 2) => ({
  op: 'add',
  items: [{ menu_item_id: LATTE, variant_id: LATTE_REG, quantity }],
});

beforeEach(() => {
  itemSeq = 0;
  state.user = { id: 'staff-1' };
  state.permitted = true;
  state.insertedItems = [];
  state.deletedIds = [];
  state.orderPatch = undefined;
  state.amendmentRow = undefined;
  state.order = {
    id: ORDER_ID,
    status: 'accepted',
    version: 3,
    order_type: 'dine_in',
    payment_status: 'unpaid',
    discount_inr: 0,
    // One existing ₹200 line on the tab.
    order_items: [{ id: 'existing-1', voided: false, line_total_inr: 200 }],
  };
  state.guarded = { id: ORDER_ID };
  state.menuRows = [
    {
      id: LATTE,
      name: 'Latte',
      category: 'coffee',
      is_veg: true,
      is_available: true,
      unavailable_until: null,
      menu_item_variants: [{ id: LATTE_REG, label: 'Regular', price_inr: 150, sort_order: 0 }],
      menu_item_addon_groups: [],
    },
  ];
});

describe('POST /api/orders/[id]/amend { op: add } — TAB-1', () => {
  it('401s without a staff session', async () => {
    state.user = null;
    expect((await POST(req(addBody()), params)).status).toBe(401);
  });

  it('403s without the pos_order_entry permission', async () => {
    state.permitted = false;
    expect((await POST(req(addBody()), params)).status).toBe(403);
  });

  it('400s an empty or malformed items array', async () => {
    expect((await POST(req({ op: 'add', items: [] }), params)).status).toBe(400);
    expect(
      (await POST(req({ op: 'add', items: [{ menu_item_id: LATTE, variant_id: LATTE_REG, quantity: 0 }] }), params))
        .status,
    ).toBe(400);
  });

  it('adds the lines and recomputes the WHOLE bill server-side', async () => {
    const res = await POST(req(addBody(2)), params);

    expect(res.status).toBe(200);
    // ₹200 already on the tab + 2 × ₹150 = ₹500 subtotal, +5% GST = ₹525.
    // Dine-in drops packaging (D5) even though the store charges ₹20.
    expect(state.orderPatch).toMatchObject({
      subtotal_inr: 500,
      tax_inr: 25,
      packaging_inr: 0,
      total_inr: 525,
      version: 4, // optimistic bump
    });
  });

  it('prices from the menu, ignoring anything the client sends', async () => {
    await POST(
      req({
        op: 'add',
        // A client trying to set its own price/snapshot must have no effect.
        items: [
          {
            menu_item_id: LATTE,
            variant_id: LATTE_REG,
            quantity: 1,
            price_inr_snapshot: 1,
            line_total_inr: 1,
          },
        ],
      }),
      params,
    );

    expect(state.insertedItems[0]).toMatchObject({
      price_inr_snapshot: 150,
      line_total_inr: 150,
      name_snapshot: 'Latte',
      variant_label_snapshot: 'Regular',
    });
  });

  it('rejects an 86’d item', async () => {
    state.menuRows[0].is_available = false;

    const res = await POST(req(addBody()), params);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('unavailable') });
    expect(state.insertedItems).toHaveLength(0);
  });

  it('rejects a variant that is not on the item', async () => {
    const res = await POST(
      req({ op: 'add', items: [{ menu_item_id: LATTE, variant_id: ORDER_ID, quantity: 1 }] }),
      params,
    );
    expect(res.status).toBe(400);
  });

  it('409s a paid order — adding would change what was already paid', async () => {
    (state.order as Record<string, unknown>).payment_status = 'paid';

    const res = await POST(req(addBody()), params);

    expect(res.status).toBe(409);
    expect(state.insertedItems).toHaveLength(0);
  });

  it('409s an order that is no longer open', async () => {
    (state.order as Record<string, unknown>).status = 'completed';
    expect((await POST(req(addBody()), params)).status).toBe(409);
  });

  it('rolls the inserted lines back on a lost version race, and writes no audit', async () => {
    state.guarded = null; // guarded update matched zero rows

    const res = await POST(req(addBody()), params);

    expect(res.status).toBe(409);
    // The critical assertion: the order must not be left half-extended.
    expect(state.deletedIds).toEqual(['new-item-1']);
    expect(state.amendmentRow).toBeUndefined();
  });

  it('audits the add with the lines and the amount', async () => {
    await POST(req(addBody(2)), params);

    expect(state.amendmentRow).toMatchObject({
      order_id: ORDER_ID,
      staff_id: 'staff-1',
      kind: 'add_item',
    });
    const payload = state.amendmentRow!.payload as { added_inr: number; lines: unknown[] };
    expect(payload.added_inr).toBe(300);
    expect(payload.lines).toHaveLength(1);
  });

  it('returns the added ids so only the new lines go to the kitchen', async () => {
    const res = await POST(req(addBody()), params);
    await expect(res.json()).resolves.toMatchObject({ added_item_ids: ['new-item-1'] });
  });

  it('still voids when op is absent (POS-4 contract unchanged)', async () => {
    state.permitted = false; // void_line denied
    const res = await POST(req({ item_id: LATTE, reason: 'Wrong item' }), params);
    // Falls through to the void path's manager gate, not the add path.
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('void') });
  });
});
