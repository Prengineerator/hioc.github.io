import { beforeEach, describe, expect, it, vi } from 'vitest';

// The POS prices an ordinary cart on its own screen (lib/pos/localQuote.ts)
// instead of asking POST /api/orders/quote on every tap. That is only safe if
// the two can never disagree, so every cart here goes through BOTH — the real
// quote route (database mocked) and quoteLocally fed the menu the way
// GET /api/menu?pos=true serves it — and the bills must be identical.

const LATTE = '11111111-1111-4111-8111-111111111111';
const LATTE_R = '11111111-1111-4111-8111-1111111111a1';
const LATTE_L = '11111111-1111-4111-8111-1111111111a2';
const SHOT_GROUP = '11111111-1111-4111-8111-1111111111b1';
const SHOT = '11111111-1111-4111-8111-1111111111c1';
const OAT = '11111111-1111-4111-8111-1111111111c2';
const JAR = '22222222-2222-4222-8222-222222222222';
const JAR_CLASSIC = '22222222-2222-4222-8222-2222222222a1';
const JAR_HAZEL = '22222222-2222-4222-8222-2222222222a2';
const BEANS = '33333333-3333-4333-8333-333333333333';
const BEANS_V = '33333333-3333-4333-8333-3333333333a1';
const WATER = '44444444-4444-4444-8444-444444444444';
const WATER_V = '44444444-4444-4444-8444-4444444444a1';

const now = new Date('2026-10-31T09:00:00Z');

const rows: Record<string, unknown>[] = [
  {
    id: LATTE,
    name: 'Latte',
    category: 'Coffee',
    is_available: true,
    unavailable_until: null,
    menu_item_variants: [
      { id: LATTE_R, label: 'Regular', price_inr: 180, sort_order: 0 },
      { id: LATTE_L, label: 'Large', price_inr: 220, sort_order: 1 },
    ],
    menu_item_addon_groups: [
      {
        addon_groups: {
          id: SHOT_GROUP,
          name: 'extras',
          display_name: 'Extras',
          selection_type: 'multi',
          min_select: 0,
          max_select: 2,
          sort_order: 0,
          options: [
            { id: SHOT, addon_group_id: SHOT_GROUP, name: 'Extra shot', price_inr: 40, sort_order: 0 },
            { id: OAT, addon_group_id: SHOT_GROUP, name: 'Oat milk', price_inr: 60, sort_order: 1 },
          ],
        },
      },
    ],
  },
  {
    id: JAR,
    name: 'Instant Coffee',
    category: 'In-store',
    is_available: true,
    unavailable_until: null,
    in_store_only: true,
    gst_exempt: true,
    menu_item_variants: [
      { id: JAR_CLASSIC, label: 'Classic', price_inr: 399, sort_order: 0 },
      { id: JAR_HAZEL, label: 'Hazelnut', price_inr: 399, sort_order: 1 },
    ],
    menu_item_addon_groups: [],
  },
  {
    id: BEANS,
    name: 'House Beans',
    category: 'In-store',
    is_available: true,
    unavailable_until: null,
    sold_by_weight: true,
    menu_item_variants: [{ id: BEANS_V, label: 'Medium roast', price_inr: 1600, sort_order: 0 }],
    menu_item_addon_groups: [],
  },
  {
    id: WATER,
    name: 'Water',
    category: 'In-store',
    is_available: false,
    unavailable_until: null,
    menu_item_variants: [{ id: WATER_V, label: '500 ml', price_inr: 20, sort_order: 0 }],
    menu_item_addon_groups: [],
  },
];

const liveOffer = {
  id: '55555555-5555-4555-8555-555555555555',
  name: 'Instant Coffee offer',
  menu_item_id: JAR,
  tier_prices: [299, 499, 599],
  active: true,
  valid_from: null,
  valid_to: null,
};

const state: {
  settings: Record<string, unknown>;
  offers: Record<string, unknown>[];
} = { settings: {}, offers: [] };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: (_col: string, ids: string[]) =>
          table === 'menu_items'
            ? Promise.resolve({ data: rows.filter((r) => ids.includes(r.id as string)), error: null })
            : Promise.resolve({ data: state.offers.filter((o) => ids.includes(o.menu_item_id as string)), error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve({ id: 'staff-1' }),
  getCounterActor: () => Promise.resolve({ user: { id: 'staff-1' }, role: 'staff', via: 'session' }),
}));
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve(state.settings) }));
vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(null),
  toStoredPhone: () => '',
}));
vi.mock('@/lib/promotions/coupons', () => ({ validateAndComputeCoupon: () => Promise.resolve({ ok: false }) }));
vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(0),
  quoteRedemption: () => Promise.resolve({ ok: false }),
}));

const { POST } = await import('@/app/api/orders/quote/route');
const { quoteLocally, pricingSettingsOf } = await import('@/lib/pos/localQuote');
const { shapeMenuItem } = await import('@/lib/menu/applyMenuChange');
const { applyMenuSwitches, isCategoryHidden, switchesFromSettings } = await import('@/lib/menu/menuSwitches');
import type { MenuItem, StoreSettings } from '@/lib/types';
import type { MenuItemRow } from '@/lib/menu/applyMenuChange';

type Item = { menu_item_id: string; variant_id: string; quantity: number; addon_option_ids: string[]; weight_grams?: number };

/** The menu as GET /api/menu?pos=true serves it: shaped, switches applied, hidden categories left out. */
function posMenu(): MenuItem[] {
  const switches = switchesFromSettings(state.settings as unknown as StoreSettings);
  return rows
    .map((r) => applyMenuSwitches(shapeMenuItem(r as unknown as MenuItemRow), switches))
    .filter((m) => !isCategoryHidden(m.category, switches.hiddenCategories));
}

async function both(items: Item[], orderType: 'takeaway' | 'dine_in' = 'takeaway') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  try {
    const res = await POST(
      new Request('https://hioc.in/api/orders/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items, order_type: orderType, pass_drinks: 0 }),
      }),
    );
    const server = { status: res.status, body: await res.json() };
    const local = quoteLocally({
      items: items.map((i) => ({ special_instructions: '', ...i })),
      menuItems: posMenu(),
      pricing: { settings: pricingSettingsOf(state.settings as unknown as StoreSettings), offers: state.offers as never },
      isDineIn: orderType === 'dine_in',
      now,
    });
    return { server, local };
  } finally {
    vi.useRealTimers();
  }
}

async function expectSameBill(items: Item[], orderType: 'takeaway' | 'dine_in' = 'takeaway') {
  const { server, local } = await both(items, orderType);
  expect(server.status).toBe(200);
  expect(local.ok).toBe(true);
  if (!local.ok) return;
  expect(local.bill).toEqual(server.body.bill);
  expect(local.offers).toEqual(server.body.offers);
  return local.bill;
}

beforeEach(() => {
  state.settings = {
    gst_percent: 5,
    gst_inclusive: false,
    packaging_charge_inr: 20,
    hidden_categories: [],
    hidden_variant_labels: [],
  };
  state.offers = [liveOffer];
});

describe('quoteLocally gives the server quote, to the rupee', () => {
  it('a plain takeaway cart (GST on lines + packaging)', async () => {
    const bill = await expectSameBill([{ menu_item_id: LATTE, variant_id: LATTE_R, quantity: 2, addon_option_ids: [] }]);
    expect(bill?.total_inr).toBe(360 + 19 + 20);
  });

  it('dine-in: no packaging', async () => {
    const bill = await expectSameBill(
      [{ menu_item_id: LATTE, variant_id: LATTE_L, quantity: 1, addon_option_ids: [SHOT, OAT] }],
      'dine_in',
    );
    expect(bill?.packaging_inr).toBe(0);
  });

  it('add-ons, several lines, a GST-exempt item and a multi-buy offer together', async () => {
    const bill = await expectSameBill([
      { menu_item_id: LATTE, variant_id: LATTE_R, quantity: 3, addon_option_ids: [SHOT] },
      { menu_item_id: JAR, variant_id: JAR_CLASSIC, quantity: 1, addon_option_ids: [] },
      { menu_item_id: JAR, variant_id: JAR_HAZEL, quantity: 1, addon_option_ids: [] },
    ]);
    expect(bill?.offer_discount_inr).toBe(798 - 499);
  });

  it('beyond the last offer tier (5 jars = 599 + 499)', async () => {
    await expectSameBill([{ menu_item_id: JAR, variant_id: JAR_CLASSIC, quantity: 5, addon_option_ids: [] }]);
  });

  it('an offer outside its window is not applied — on either side', async () => {
    state.offers = [{ ...liveOffer, valid_to: '2026-10-30T00:00:00Z' }];
    const bill = await expectSameBill([{ menu_item_id: JAR, variant_id: JAR_CLASSIC, quantity: 2, addon_option_ids: [] }]);
    expect(bill?.offer_discount_inr).toBe(0);
  });

  it('GST-inclusive prices', async () => {
    state.settings.gst_inclusive = true;
    await expectSameBill([{ menu_item_id: LATTE, variant_id: LATTE_L, quantity: 2, addon_option_ids: [OAT] }]);
  });

  it('a sold-by-weight line', async () => {
    await expectSameBill([{ menu_item_id: BEANS, variant_id: BEANS_V, quantity: 2, addon_option_ids: [], weight_grams: 250 }]);
  });
});

describe('quoteLocally refuses what the server refuses', () => {
  it("an 86'd item", async () => {
    const { server, local } = await both([{ menu_item_id: WATER, variant_id: WATER_V, quantity: 1, addon_option_ids: [] }]);
    expect(server.status).toBe(400);
    expect(local).toEqual({ ok: false, error: server.body.error });
  });

  it('too many add-ons in a group', async () => {
    state.settings.hidden_variant_labels = [];
    const items = [{ menu_item_id: LATTE, variant_id: LATTE_R, quantity: 1, addon_option_ids: [SHOT, OAT, SHOT] }];
    const { server, local } = await both(items);
    expect(server.status).toBe(400);
    expect(local).toEqual({ ok: false, error: server.body.error });
  });

  it('a category switched off (the POS then asks the server, which says why)', async () => {
    state.settings.hidden_categories = ['Coffee'];
    const { server, local } = await both([{ menu_item_id: LATTE, variant_id: LATTE_R, quantity: 1, addon_option_ids: [] }]);
    expect(server.status).toBe(400);
    expect(local.ok).toBe(false);
  });
});
