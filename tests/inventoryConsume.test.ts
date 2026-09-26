import { beforeEach, describe, expect, it, vi } from 'vitest';

// consumeStockForOrder (lib/inventory/server.ts) — the order-completion hook.
// Guards: nothing happens with the flag off; an order's lines × recipes
// become one inventory_apply_sale call with per-item totals; and no failure
// ever escapes (the order is already complete — stock must never fail it).

const state: {
  flag: boolean;
  orderLines: unknown[];
  recipe: unknown[];
  addonRecipe: unknown[];
  recipeError: { message: string } | null;
  rpc: { name: string; args: Record<string, unknown> }[];
  throwOnFrom: boolean;
} = { flag: true, orderLines: [], recipe: [], addonRecipe: [], recipeError: null, rpc: [], throwOnFrom: false };

vi.mock('@/lib/flags', () => ({
  flags: new Proxy({}, { get: (_t, key) => (key === 'inventory' ? state.flag : true) }),
}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpc.push({ name, args });
      return Promise.resolve({ data: 1, error: null });
    },
    from: (table: string) => {
      if (state.throwOnFrom) throw new Error('boom');
      const result =
        table === 'order_items'
          ? { data: state.orderLines, error: null }
          : table === 'addon_recipe_lines'
            ? { data: state.addonRecipe, error: null }
            : { data: state.recipeError ? null : state.recipe, error: state.recipeError };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        then: (resolve: (v: unknown) => void) => resolve(result),
      };
      return chain;
    },
  }),
}));

const { consumeStockForOrder } = await import('@/lib/inventory/server');

beforeEach(() => {
  state.flag = true;
  state.orderLines = [
    { menu_item_id: 'latte', variant_label_snapshot: 'Large', quantity: 2, order_item_addons: [{ addon_option_id: 'shot' }] },
    { menu_item_id: 'latte', variant_label_snapshot: 'Regular', quantity: 1, order_item_addons: [] },
    { menu_item_id: 'cookie', variant_label_snapshot: 'Regular', quantity: 4, order_item_addons: null },
  ];
  state.recipe = [
    { menu_item_id: 'latte', size_label: '', item_id: 'milk', qty: '0.200' },
    { menu_item_id: 'latte', size_label: 'Large', item_id: 'milk', qty: '0.300' },
    { menu_item_id: 'latte', size_label: '', item_id: 'cup', qty: 1 },
  ];
  state.addonRecipe = [{ addon_option_id: 'shot', item_id: 'beans', qty: '9.000' }];
  state.recipeError = null;
  state.rpc = [];
  state.throwOnFrom = false;
});

describe('consumeStockForOrder', () => {
  it('does nothing while the inventory flag is off', async () => {
    state.flag = false;
    await consumeStockForOrder('order-1', 'staff-1');
    expect(state.rpc).toEqual([]);
  });

  it('takes lines × recipes (and add-ons) off stock in one call', async () => {
    await consumeStockForOrder('order-1', 'staff-1');
    // Large uses its own recipe (no cup line), Regular the base one; the
    // extra shot on the two Large lattes is used twice.
    expect(state.rpc).toEqual([
      {
        name: 'inventory_apply_sale',
        args: {
          p_order_id: 'order-1',
          p_actor: 'staff-1',
          p_lines: [
            { item_id: 'milk', qty: 0.8 },
            { item_id: 'beans', qty: 18 },
            { item_id: 'cup', qty: 1 },
          ],
        },
      },
    ]);
  });

  it('skips the call when nothing ordered has a recipe', async () => {
    state.recipe = [];
    state.addonRecipe = [];
    await consumeStockForOrder('order-1', 'staff-1');
    expect(state.rpc).toEqual([]);
  });

  it('never throws — not on a missing table, not on anything', async () => {
    state.recipeError = { message: 'relation "recipe_lines" does not exist' };
    await expect(consumeStockForOrder('order-1', 'staff-1')).resolves.toBeUndefined();
    state.throwOnFrom = true;
    await expect(consumeStockForOrder('order-1', 'staff-1')).resolves.toBeUndefined();
    expect(state.rpc).toEqual([]);
  });
});
