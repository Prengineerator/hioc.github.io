import { beforeEach, describe, expect, it, vi } from 'vitest';

// consumeStockForOrder (lib/inventory/server.ts) — the order-completion hook.
// Guards: nothing happens with the flag off; an order's lines × recipes
// become one inventory_apply_sale call with per-item totals; an add-on uses
// the recipe scoped to the ordered item and size when it has one; a voided
// line takes nothing; and no failure ever escapes (the order is already
// complete — stock must never fail it).

const state: {
  flag: boolean;
  orderLines: unknown[];
  recipe: unknown[];
  addonRecipe: unknown[];
  recipeError: { message: string } | null;
  rpc: { name: string; args: Record<string, unknown> }[];
  /** [table, columns] of every .select(), so a test can see what was asked for. */
  selects: [string, string][];
  throwOnFrom: boolean;
} = { flag: true, orderLines: [], recipe: [], addonRecipe: [], recipeError: null, rpc: [], selects: [], throwOnFrom: false };

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
      // order_items honours .eq filters (so a voided line is really left out
      // of the result, as in the database); the recipe tables ignore filters.
      const eqs: [string, unknown][] = [];
      const result = () =>
        table === 'order_items'
          ? { data: (state.orderLines as Record<string, unknown>[]).filter((row) => eqs.every(([col, val]) => row[col] === val)), error: null }
          : table === 'addon_recipe_lines'
            ? { data: state.addonRecipe, error: null }
            : { data: state.recipeError ? null : state.recipe, error: state.recipeError };
      const chain: Record<string, unknown> = {
        select: (cols: string) => {
          state.selects.push([table, cols]);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          eqs.push([col, val]);
          return chain;
        },
        in: () => chain,
        then: (resolve: (v: unknown) => void) => resolve(result()),
      };
      return chain;
    },
  }),
}));

const { consumeStockForOrder } = await import('@/lib/inventory/server');

beforeEach(() => {
  state.flag = true;
  state.orderLines = [
    { order_id: 'order-1', voided: false, menu_item_id: 'latte', variant_label_snapshot: 'Large', quantity: 2, order_item_addons: [{ addon_option_id: 'shot' }] },
    { order_id: 'order-1', voided: false, menu_item_id: 'latte', variant_label_snapshot: 'Regular', quantity: 1, order_item_addons: [] },
    { order_id: 'order-1', voided: false, menu_item_id: 'cookie', variant_label_snapshot: 'Regular', quantity: 4, order_item_addons: null },
  ];
  state.recipe = [
    { menu_item_id: 'latte', size_label: '', item_id: 'milk', qty: '0.200' },
    { menu_item_id: 'latte', size_label: 'Large', item_id: 'milk', qty: '0.300' },
    { menu_item_id: 'latte', size_label: '', item_id: 'cup', qty: 1 },
  ];
  state.addonRecipe = [{ addon_option_id: 'shot', item_id: 'beans', qty: '9.000' }];
  state.recipeError = null;
  state.rpc = [];
  state.selects = [];
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

  it('uses the add-on recipe scoped to the ordered item and size, not the general one', async () => {
    state.orderLines = [
      { order_id: 'order-1', voided: false, menu_item_id: 'latte', variant_label_snapshot: 'Extra Large', quantity: 2, order_item_addons: [{ addon_option_id: 'sugar' }] },
      { order_id: 'order-1', voided: false, menu_item_id: 'latte', variant_label_snapshot: 'Large', quantity: 1, order_item_addons: [{ addon_option_id: 'sugar' }] },
      { order_id: 'order-1', voided: false, menu_item_id: 'espresso', variant_label_snapshot: 'Regular', quantity: 3, order_item_addons: [{ addon_option_id: 'sugar' }] },
    ];
    state.recipe = [{ menu_item_id: 'latte', size_label: '', item_id: 'milk', qty: '0.200' }];
    state.addonRecipe = [
      { addon_option_id: 'sugar', menu_item_id: null, size_label: '', item_id: 'sugar-g', qty: '20.000' },
      { addon_option_id: 'sugar', menu_item_id: 'espresso', size_label: '', item_id: 'sugar-g', qty: '10.000' },
      { addon_option_id: 'sugar', menu_item_id: 'latte', size_label: 'Extra Large', item_id: 'sugar-g', qty: '25.000' },
    ];
    await consumeStockForOrder('order-1', 'staff-1');
    // 2 Latte Extra Large × 25 + 1 Latte Large × 20 (general) + 3 Espresso × 10.
    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0].args.p_lines).toEqual([
      { item_id: 'milk', qty: 0.6 },
      { item_id: 'sugar-g', qty: 100 },
    ]);
  });

  it('asks the database for each add-on line’s scope (item and size), not just its amount', async () => {
    await consumeStockForOrder('order-1', 'staff-1');
    const cols = state.selects.find(([table]) => table === 'addon_recipe_lines')?.[1] ?? '';
    expect(cols.split(',').map((c) => c.trim())).toEqual(
      expect.arrayContaining(['addon_option_id', 'item_id', 'qty', 'menu_item_id', 'size_label']),
    );
  });

  it('leaves a voided line off stock — its recipe and its add-ons', async () => {
    // A second Large latte with an extra shot was rung up, then voided at the
    // counter: it was never made, so only the two live Large lattes count.
    state.orderLines.push({
      order_id: 'order-1',
      voided: true,
      menu_item_id: 'latte',
      variant_label_snapshot: 'Large',
      quantity: 5,
      order_item_addons: [{ addon_option_id: 'shot' }],
    });
    await consumeStockForOrder('order-1', 'staff-1');
    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0].args.p_lines).toEqual([
      { item_id: 'milk', qty: 0.8 },
      { item_id: 'beans', qty: 18 },
      { item_id: 'cup', qty: 1 },
    ]);
  });

  it('takes nothing when every line of the order was voided', async () => {
    for (const line of state.orderLines as { voided: boolean }[]) line.voided = true;
    await consumeStockForOrder('order-1', 'staff-1');
    expect(state.rpc).toEqual([]);
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
