import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH /api/menu/[id] and inventory auto-hide (docs/INVENTORY-SPEC.md).
// A person switching an item on or off takes it out of stock's hands, so the
// route clears menu_items.stock_out_auto — and, because the inventory flag
// can be on before the migration is applied, a database without that column
// must still save the toggle.

const ITEM = '00000000-0000-4000-8000-0000000000c1';

const state: {
  flag: boolean;
  missingColumn: boolean;
  updates: Record<string, unknown>[];
} = { flag: true, missingColumn: false, updates: [] };

vi.mock('@/lib/flags', () => ({
  flags: new Proxy({}, { get: (_t, key) => (key === 'inventory' ? state.flag : true) }),
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve({ user: { id: 'staff-1' }, role: 'staff', via: 'device' }),
}));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: () => {
      let patch: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        update: (p: Record<string, unknown>) => {
          patch = { ...p };
          return chain;
        },
        maybeSingle: () => {
          if (patch) {
            state.updates.push(patch);
            if (state.missingColumn && 'stock_out_auto' in patch) {
              return Promise.resolve({
                data: null,
                error: { code: 'PGRST204', message: "Could not find the 'stock_out_auto' column of 'menu_items' in the schema cache" },
              });
            }
            return Promise.resolve({ data: { id: ITEM }, error: null });
          }
          return Promise.resolve({
            data: { id: ITEM, name: 'Latte', is_available: true, menu_item_variants: [], menu_item_addon_groups: [] },
            error: null,
          });
        },
      });
      return chain;
    },
  }),
}));

const { PATCH } = await import('@/app/api/menu/[id]/route');

function patch(body: unknown) {
  return PATCH(
    new Request(`http://t/api/menu/${ITEM}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: ITEM } },
  );
}

beforeEach(() => {
  state.flag = true;
  state.missingColumn = false;
  state.updates = [];
});

describe('PATCH /api/menu/[id] — stock_out_auto', () => {
  it('clears the auto-hide mark when a person toggles availability', async () => {
    expect((await patch({ is_available: true })).status).toBe(200);
    expect(state.updates).toEqual([{ is_available: true, stock_out_auto: false }]);
  });

  it('leaves it alone for any other edit', async () => {
    expect((await patch({ name: 'Latte' })).status).toBe(200);
    expect(state.updates).toEqual([{ name: 'Latte' }]);
  });

  it('does not touch it while inventory is off', async () => {
    state.flag = false;
    await patch({ is_available: false });
    expect(state.updates).toEqual([{ is_available: false }]);
  });

  it('still saves the toggle on a database without the column', async () => {
    state.missingColumn = true;
    expect((await patch({ is_available: false })).status).toBe(200);
    expect(state.updates).toEqual([{ is_available: false, stock_out_auto: false }, { is_available: false }]);
  });
});
