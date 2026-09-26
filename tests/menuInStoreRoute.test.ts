import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/menu and in-store-only items. The customer menus (website, table
// QR) call this route; only the POS and the menu editor may see water bottles,
// and asking for them in the URL is not enough without a counter sign-in.

const state: { actor: { user: { id: string }; role: string; via: string } | null } = { actor: null };

const rows = [
  {
    id: 'latte',
    name: 'Latte',
    category: 'Coffee',
    is_available: true,
    in_store_only: false,
    menu_item_variants: [],
    menu_item_addon_groups: [],
  },
  {
    id: 'water',
    name: 'Water Bottle',
    category: 'In-store',
    is_available: true,
    in_store_only: true,
    menu_item_variants: [],
    menu_item_addon_groups: [],
  },
];

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({}),
  createServerSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        order: () => chain,
        eq: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
      });
      return chain;
    },
  }),
}));

const { GET } = await import('@/app/api/menu/route');

async function names(query: string): Promise<string[]> {
  const res = await GET(new Request(`http://t/api/menu${query}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: { name: string }[] }).items.map((i) => i.name);
}

beforeEach(() => {
  state.actor = null;
});

describe('GET /api/menu — in-store-only items', () => {
  it('hides them from a customer', async () => {
    expect(await names('?includeUnavailable=true')).toEqual(['Latte']);
  });

  it('still hides them when a customer adds includeInStore=true', async () => {
    expect(await names('?includeUnavailable=true&includeInStore=true')).toEqual(['Latte']);
  });

  it('shows them to a signed-in counter that asks for them', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'device' };
    expect(await names('?includeUnavailable=true&includeInStore=true')).toEqual(['Latte', 'Water Bottle']);
  });

  it('a signed-in counter browsing the customer menu (no flag) sees the customer view', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    expect(await names('?includeUnavailable=true')).toEqual(['Latte']);
  });
});
