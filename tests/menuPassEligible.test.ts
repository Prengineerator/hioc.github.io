import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/menu and menu_items.pass_eligible (HIOC Ritual, docs/COFFEE-PASS-SPEC.md
// CP-D3). The select is `*`, so the column rides along once the migration is
// applied and is simply absent before it; the route shapes it into a boolean
// that is always there, and false for everything while the feature is off.

const flagState = vi.hoisted(() => ({ coffeePass: true }));
vi.mock('@/lib/flags', () => ({ flags: flagState }));

const state: { rows: Record<string, unknown>[] } = { rows: [] };

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  category: 'Coffee',
  is_available: true,
  in_store_only: false,
  menu_item_variants: [{ id: `${id}-v`, menu_item_id: id, label: 'L', price_inr: 120, sort_order: 0 }],
  menu_item_addon_groups: [],
  ...over,
});

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(null) }));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ hidden_categories: [], hidden_variant_labels: [] }),
}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({}),
  createServerSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        order: () => chain,
        eq: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ data: state.rows, error: null }),
      });
      return chain;
    },
  }),
}));

const { GET } = await import('@/app/api/menu/route');

async function eligibility(): Promise<Record<string, unknown>> {
  const res = await GET(new Request('http://t/api/menu'));
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: { id: string; pass_eligible: unknown }[] };
  return Object.fromEntries(items.map((i) => [i.id, i.pass_eligible]));
}

beforeEach(() => {
  flagState.coffeePass = true;
  state.rows = [
    item('capp', { pass_eligible: true }),
    item('sandwich', { pass_eligible: false }),
    item('legacy'), // a row from a database without the column: it is simply absent
  ];
});

describe('GET /api/menu — pass_eligible', () => {
  it('exposes it as a boolean on every item, and false where the column does not exist yet', async () => {
    expect(await eligibility()).toEqual({ capp: true, sandwich: false, legacy: false });
  });

  it('is false for everything while the feature is off, so nothing about HIOC Ritual shows on a menu', async () => {
    flagState.coffeePass = false;
    expect(await eligibility()).toEqual({ capp: false, sandwich: false, legacy: false });
  });
});
