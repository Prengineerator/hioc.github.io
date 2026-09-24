// Shared fixture for the Phase-7 suggestion-engine tests (SUG-3). Modelled on
// supabase/seed.sql's real categories (Coffee/Hot, Hot Non-Coffee, Creme
// Coffee/Non-Coffee, Iced Coffee/Non-Coffee, Cold Brew, Waffles, Cheesecakes,
// Cupcakes) — names and prices are representative, not copied verbatim.
//
// house style: pure fixtures, no Supabase — see tests/customerSegments.test.ts
// for the sibling pattern (factory functions + sensible overrides).

import type { MenuItem, MenuItemVariant } from '@/lib/types';
import type { MenuItemTraits } from '@/lib/suggest/types';

let variantSeq = 0;
function variant(menuItemId: string, priceInr: number, label = 'Regular'): MenuItemVariant {
  variantSeq += 1;
  return {
    id: `${menuItemId}-var-${variantSeq}`,
    menu_item_id: menuItemId,
    label,
    price_inr: priceInr,
    sort_order: 0,
  };
}

function menuItem(over: Partial<MenuItem> & { id: string; name: string; priceInr: number }): MenuItem {
  const { priceInr, ...rest } = over;
  return {
    description: '',
    category: 'Coffee',
    parent_category: 'Hot',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    variants: [variant(rest.id, priceInr)],
    addon_groups: [],
    ...rest,
  };
}

function traits(over: Partial<MenuItemTraits> & { menu_item_id: string }): MenuItemTraits {
  return {
    temperature: 'hot',
    caffeine: 'medium',
    is_coffee: true,
    sweetness: 1,
    body: 'medium',
    kind: 'drink',
    moods: [],
    dayparts: ['morning', 'afternoon', 'evening', 'late'],
    flavor_notes: [],
    source: 'opus',
    confirmed: true,
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Items (§5.1 traits + a spread of prices to exercise every budget band:
// under_150 ≤150, 150_300 150–300 inclusive, and above 300 for 'treat'/'any').
// ---------------------------------------------------------------------------

export const ESPRESSO = menuItem({
  id: 'espresso',
  name: 'Espresso',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 70,
});
export const ESPRESSO_TRAITS = traits({
  menu_item_id: 'espresso',
  temperature: 'hot',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 0,
  body: 'light',
  kind: 'drink',
  moods: ['boost'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['bold', 'nutty'],
});

export const CAPPUCCINO = menuItem({
  id: 'cappuccino',
  name: 'Cappuccino',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 130,
});
export const CAPPUCCINO_TRAITS = traits({
  menu_item_id: 'cappuccino',
  temperature: 'hot',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 1,
  body: 'medium',
  kind: 'drink',
  moods: ['cosy'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['creamy'],
});

export const CAFE_LATTE = menuItem({
  id: 'cafe-latte',
  name: 'Latte',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 140,
});
export const CAFE_LATTE_TRAITS = traits({
  menu_item_id: 'cafe-latte',
  temperature: 'hot',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 1,
  body: 'medium',
  kind: 'drink',
  moods: ['cosy'],
  dayparts: ['morning', 'afternoon', 'evening'],
  flavor_notes: ['smooth', 'milky'],
});

// Seven more hot coffees (alongside ESPRESSO/CAPPUCCINO/CAFE_LATTE above —
// 10 total in the 'Coffee' category) so a "hot coffee" request has enough
// same-category candidates to exercise the no-longer-2-per-category
// diversity cap (root cause #2 — buildShortlist used to starve the decider
// down to just 2 coffees). Most are tagged 'boost' so a boost+hot+coffee
// request scores them competitively against each other.
export const DOPPIO = menuItem({
  id: 'doppio',
  name: 'Doppio',
  description: 'A double shot of espresso, pulled short and strong.',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 90,
});
export const DOPPIO_TRAITS = traits({
  menu_item_id: 'doppio',
  temperature: 'hot',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 0,
  body: 'light',
  kind: 'drink',
  moods: ['boost'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['bold', 'intense'],
});

export const FLAT_WHITE = menuItem({
  id: 'flat-white',
  name: 'Flat White',
  description: 'Espresso with steamed milk and a thin layer of microfoam.',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 150,
});
export const FLAT_WHITE_TRAITS = traits({
  menu_item_id: 'flat-white',
  temperature: 'hot',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 1,
  body: 'medium',
  kind: 'drink',
  moods: ['boost', 'cosy'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['velvety', 'smooth'],
});

export const MOCHA = menuItem({
  id: 'mocha',
  name: 'Mocha',
  description: 'Espresso with steamed milk and rich chocolate syrup.',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 170,
});
export const MOCHA_TRAITS = traits({
  menu_item_id: 'mocha',
  temperature: 'hot',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 2,
  body: 'rich',
  kind: 'drink',
  moods: ['comfort', 'celebrate'],
  dayparts: ['afternoon', 'evening'],
  flavor_notes: ['chocolate', 'coffee-forward'],
});

export const CORTADO = menuItem({
  id: 'cortado',
  name: 'Cortado',
  description: 'Espresso cut with a small, equal amount of warm milk.',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 140,
});
export const CORTADO_TRAITS = traits({
  menu_item_id: 'cortado',
  temperature: 'hot',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 1,
  body: 'medium',
  kind: 'drink',
  moods: ['boost'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['balanced', 'nutty'],
});

export const RISTRETTO = menuItem({
  id: 'ristretto',
  name: 'Ristretto',
  description: 'A short, concentrated espresso pull — bold and syrupy.',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 95,
});
export const RISTRETTO_TRAITS = traits({
  menu_item_id: 'ristretto',
  temperature: 'hot',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 0,
  body: 'light',
  kind: 'drink',
  moods: ['boost'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['concentrated', 'bold'],
});

export const HOT_AMERICANO = menuItem({
  id: 'hot-americano',
  name: 'Americano',
  description: 'Espresso lengthened with hot water — bold and clean.',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 100,
});
export const HOT_AMERICANO_TRAITS = traits({
  menu_item_id: 'hot-americano',
  temperature: 'hot',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 0,
  body: 'light',
  kind: 'drink',
  moods: ['boost'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['bold', 'clean'],
});

export const CAFE_MACCHIATO = menuItem({
  id: 'macchiato',
  name: 'Cafe Macchiato',
  description: 'Espresso "marked" with a dash of foamed milk.',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 120,
});
export const CAFE_MACCHIATO_TRAITS = traits({
  menu_item_id: 'macchiato',
  temperature: 'hot',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 1,
  body: 'medium',
  kind: 'drink',
  moods: ['boost', 'cosy'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['sweet', 'bold'],
});

export const CHAI_LATTE = menuItem({
  id: 'chai-latte',
  name: 'Chai Latte',
  category: 'Hot Non-Coffee',
  parent_category: 'Hot',
  priceInr: 110,
});
export const CHAI_LATTE_TRAITS = traits({
  menu_item_id: 'chai-latte',
  temperature: 'hot',
  caffeine: 'low',
  is_coffee: false,
  sweetness: 2,
  body: 'medium',
  kind: 'drink',
  moods: ['cosy', 'comfort'],
  dayparts: ['morning', 'afternoon', 'evening', 'late'],
  flavor_notes: ['spiced', 'warm'],
});

export const HOT_CHOCOLATE = menuItem({
  id: 'hot-chocolate',
  name: 'Signature Hot Chocolate',
  category: 'Hot Non-Coffee',
  parent_category: 'Hot',
  priceInr: 160,
});
export const HOT_CHOCOLATE_TRAITS = traits({
  menu_item_id: 'hot-chocolate',
  temperature: 'hot',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 3,
  body: 'rich',
  kind: 'drink',
  moods: ['comfort', 'celebrate'],
  dayparts: ['evening', 'late'],
  flavor_notes: ['chocolate'],
});

export const SIGNATURE_CREME = menuItem({
  id: 'signature-creme',
  name: "Hioc's Signature Creme",
  category: 'Creme Coffee',
  parent_category: 'Creme',
  priceInr: 180,
});
export const SIGNATURE_CREME_TRAITS = traits({
  menu_item_id: 'signature-creme',
  temperature: 'iced',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 2,
  body: 'rich',
  kind: 'drink',
  moods: ['celebrate', 'comfort'],
  dayparts: ['afternoon', 'evening'],
  flavor_notes: ['creamy', 'smooth'],
});

export const HAZELNUT_CREME = menuItem({
  id: 'hazelnut-creme',
  name: 'Hazelnut Creme',
  category: 'Creme Coffee',
  parent_category: 'Creme',
  priceInr: 190,
});
export const HAZELNUT_CREME_TRAITS = traits({
  menu_item_id: 'hazelnut-creme',
  temperature: 'iced',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 3,
  body: 'rich',
  kind: 'drink',
  moods: ['celebrate'],
  dayparts: ['afternoon', 'evening'],
  flavor_notes: ['hazelnut', 'creamy'],
});

export const STRAWBERRY_CREME = menuItem({
  id: 'strawberry-creme',
  name: 'Fruity Strawberry Creme',
  category: 'Creme Non-Coffee',
  parent_category: 'Creme',
  priceInr: 185,
});
export const STRAWBERRY_CREME_TRAITS = traits({
  menu_item_id: 'strawberry-creme',
  temperature: 'iced',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 3,
  body: 'rich',
  kind: 'drink',
  moods: ['celebrate', 'comfort'],
  dayparts: ['afternoon', 'evening'],
  flavor_notes: ['strawberry'],
});

export const ON_THE_ROCKS = menuItem({
  id: 'on-the-rocks',
  name: 'On The Rocks',
  category: 'Iced Coffee',
  parent_category: 'Iced Drinks',
  priceInr: 140,
});
export const ON_THE_ROCKS_TRAITS = traits({
  menu_item_id: 'on-the-rocks',
  temperature: 'iced',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 0,
  body: 'light',
  kind: 'drink',
  moods: ['boost', 'cool'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['bold', 'crisp'],
});

export const ICED_LATTE = menuItem({
  id: 'iced-latte',
  name: 'Latte Iced',
  category: 'Iced Coffee',
  parent_category: 'Iced Drinks',
  priceInr: 150,
});
export const ICED_LATTE_TRAITS = traits({
  menu_item_id: 'iced-latte',
  temperature: 'iced',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 1,
  body: 'medium',
  kind: 'drink',
  moods: ['cool'],
  dayparts: ['afternoon', 'evening'],
  flavor_notes: ['smooth', 'milky'],
});

export const ICED_AMERICANO = menuItem({
  id: 'iced-americano',
  name: 'Americano Iced',
  category: 'Iced Coffee',
  parent_category: 'Iced Drinks',
  priceInr: 120,
});
export const ICED_AMERICANO_TRAITS = traits({
  menu_item_id: 'iced-americano',
  temperature: 'iced',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 0,
  body: 'light',
  kind: 'drink',
  moods: ['boost', 'cool'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['bold'],
});

export const BERRY_LEMONADE = menuItem({
  id: 'berry-lemonade',
  name: 'Berry Lemonade Iced',
  category: 'Iced Non-Coffee',
  parent_category: 'Iced Drinks',
  priceInr: 160,
});
export const BERRY_LEMONADE_TRAITS = traits({
  menu_item_id: 'berry-lemonade',
  temperature: 'iced',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 2,
  body: 'light',
  kind: 'drink',
  moods: ['cool', 'surprise'],
  dayparts: ['afternoon', 'evening'],
  flavor_notes: ['berry', 'citrus'],
});

export const MATCHA_ICED_LATTE = menuItem({
  id: 'matcha-iced-latte',
  name: 'Matcha Latte Iced',
  category: 'Iced Non-Coffee',
  parent_category: 'Iced Drinks',
  priceInr: 170,
});
export const MATCHA_ICED_LATTE_TRAITS = traits({
  menu_item_id: 'matcha-iced-latte',
  temperature: 'iced',
  caffeine: 'low',
  is_coffee: false,
  sweetness: 1,
  body: 'medium',
  kind: 'drink',
  moods: ['cool'],
  dayparts: ['afternoon'],
  flavor_notes: ['earthy', 'matcha'],
});

export const COLD_BREW = menuItem({
  id: 'cold-brew',
  name: 'Cold Brew',
  category: 'Cold Brew',
  parent_category: 'Iced Drinks',
  priceInr: 150,
});
export const COLD_BREW_TRAITS = traits({
  menu_item_id: 'cold-brew',
  temperature: 'iced',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 0,
  body: 'light',
  kind: 'drink',
  moods: ['boost', 'cool'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['bold', 'smooth'],
});

export const VANILLA_COLD_BREW = menuItem({
  id: 'vanilla-cold-brew',
  name: 'Vanilla Cold Brew',
  category: 'Cold Brew',
  parent_category: 'Iced Drinks',
  priceInr: 170,
});
export const VANILLA_COLD_BREW_TRAITS = traits({
  menu_item_id: 'vanilla-cold-brew',
  temperature: 'iced',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 1,
  body: 'medium',
  kind: 'drink',
  moods: ['boost', 'cool'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['vanilla', 'smooth'],
});

export const BELGIAN_WAFFLE = menuItem({
  id: 'belgian-waffle',
  name: 'Belgian Waffle',
  category: 'Waffles',
  parent_category: 'Eatery',
  priceInr: 220,
});
export const BELGIAN_WAFFLE_TRAITS = traits({
  menu_item_id: 'belgian-waffle',
  temperature: 'ambient',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 2,
  body: 'rich',
  kind: 'food',
  moods: ['comfort', 'celebrate'],
  dayparts: ['morning', 'afternoon'],
  flavor_notes: ['buttery'],
});

export const NUTELLA_WAFFLE = menuItem({
  id: 'nutella-waffle',
  name: 'Nutella Waffle',
  category: 'Waffles',
  parent_category: 'Eatery',
  priceInr: 240,
});
export const NUTELLA_WAFFLE_TRAITS = traits({
  menu_item_id: 'nutella-waffle',
  temperature: 'ambient',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 3,
  body: 'rich',
  kind: 'food',
  moods: ['celebrate', 'comfort'],
  dayparts: ['afternoon', 'evening'],
  flavor_notes: ['chocolate', 'hazelnut'],
});

// Two HOT (not 'ambient') food items — the exact dishes named in the real
// production sessions this ticket fixes (root cause #1: food leaking into
// plain drink requests, and hot food wrongly excluded by an iced-drink
// chip). temperature: 'hot' here specifically exercises "the temperature
// constraint applies to drinks only" (§5.2) — before that fix, requesting an
// iced drink would have wrongly excluded these.
export const GARLIC_BREAD_TOAST = menuItem({
  id: 'garlic-bread-toast',
  name: 'Garlic Bread Toast',
  description: 'Toasted bread with garlic butter, baked hot and crisp.',
  category: 'Savouries',
  parent_category: 'Eatery',
  priceInr: 160,
});
export const GARLIC_BREAD_TOAST_TRAITS = traits({
  menu_item_id: 'garlic-bread-toast',
  temperature: 'hot',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 0,
  body: 'medium',
  kind: 'food',
  moods: ['comfort'],
  dayparts: ['afternoon', 'evening'],
  flavor_notes: ['garlicky', 'buttery'],
});

export const BAKED_CHEESE_NACHOS = menuItem({
  id: 'baked-cheese-nachos',
  name: 'Baked Cheese Nachos',
  description: 'Corn chips baked hot under melted cheese, lightly spiced.',
  category: 'Savouries',
  parent_category: 'Eatery',
  priceInr: 220,
});
export const BAKED_CHEESE_NACHOS_TRAITS = traits({
  menu_item_id: 'baked-cheese-nachos',
  temperature: 'hot',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 0,
  body: 'rich',
  kind: 'food',
  moods: ['comfort', 'celebrate'],
  dayparts: ['afternoon', 'evening', 'late'],
  flavor_notes: ['cheesy', 'spiced'],
});

export const BLUEBERRY_CHEESECAKE = menuItem({
  id: 'blueberry-cheesecake',
  name: 'Blueberry Cheesecake',
  category: 'Cheesecakes',
  parent_category: '',
  priceInr: 250,
});
export const BLUEBERRY_CHEESECAKE_TRAITS = traits({
  menu_item_id: 'blueberry-cheesecake',
  temperature: 'ambient',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 3,
  body: 'rich',
  kind: 'dessert',
  moods: ['celebrate', 'comfort'],
  dayparts: ['afternoon', 'evening', 'late'],
  flavor_notes: ['blueberry', 'creamy'],
});

export const BISCOFF_CHEESECAKE = menuItem({
  id: 'biscoff-cheesecake',
  name: 'Biscoff Cheesecake',
  category: 'Cheesecakes',
  parent_category: '',
  priceInr: 260,
});
export const BISCOFF_CHEESECAKE_TRAITS = traits({
  menu_item_id: 'biscoff-cheesecake',
  temperature: 'ambient',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 3,
  body: 'rich',
  kind: 'dessert',
  moods: ['celebrate', 'comfort'],
  dayparts: ['afternoon', 'evening', 'late'],
  flavor_notes: ['biscoff', 'creamy'],
});

export const RED_VELVET_CUPCAKE = menuItem({
  id: 'red-velvet-cupcake',
  name: 'Red Velvet Cupcake',
  category: 'Cupcakes',
  parent_category: '',
  priceInr: 90,
});
export const RED_VELVET_CUPCAKE_TRAITS = traits({
  menu_item_id: 'red-velvet-cupcake',
  temperature: 'ambient',
  caffeine: 'none',
  is_coffee: false,
  sweetness: 3,
  body: 'medium',
  kind: 'dessert',
  moods: ['celebrate'],
  dayparts: ['afternoon', 'evening', 'late'],
  flavor_notes: ['vanilla', 'cream cheese'],
});

// An item with NO traits row (§5.1: "never suggested" — the fixture's own
// check that filterCandidates/pickUsual never treat a missing row as a
// pass-through).
export const NO_TRAITS_ITEM = menuItem({
  id: 'seasonal-special',
  name: 'Seasonal Special',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 100,
});

// An 86'd item (manually unavailable) that DOES have traits, to exercise the
// availability half of §5.2 rule 1 independent of the traits-row half.
export const UNAVAILABLE_ITEM = menuItem({
  id: 'eighty-sixed',
  name: "86'd Filter Coffee",
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 90,
  is_available: false,
});
export const UNAVAILABLE_ITEM_TRAITS = traits({
  menu_item_id: 'eighty-sixed',
  temperature: 'hot',
  caffeine: 'medium',
  is_coffee: true,
});

// A snoozed item (`unavailable_until` in the future) — same availability
// rule, via the timed-snooze path (lib/menu/availability.ts) rather than the
// manual `is_available` flag.
export const SNOOZED_ITEM = menuItem({
  id: 'snoozed-special',
  name: 'Snoozed Special',
  category: 'Coffee',
  parent_category: 'Hot',
  priceInr: 110,
  is_available: true,
  unavailable_until: '2099-01-01T00:00:00Z',
});
export const SNOOZED_ITEM_TRAITS = traits({
  menu_item_id: 'snoozed-special',
  temperature: 'hot',
  caffeine: 'medium',
  is_coffee: true,
});

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export const SUGGEST_FIXTURE_ITEMS: MenuItem[] = [
  ESPRESSO,
  CAPPUCCINO,
  CAFE_LATTE,
  DOPPIO,
  FLAT_WHITE,
  MOCHA,
  CORTADO,
  RISTRETTO,
  HOT_AMERICANO,
  CAFE_MACCHIATO,
  CHAI_LATTE,
  HOT_CHOCOLATE,
  SIGNATURE_CREME,
  HAZELNUT_CREME,
  STRAWBERRY_CREME,
  ON_THE_ROCKS,
  ICED_LATTE,
  ICED_AMERICANO,
  BERRY_LEMONADE,
  MATCHA_ICED_LATTE,
  COLD_BREW,
  VANILLA_COLD_BREW,
  BELGIAN_WAFFLE,
  NUTELLA_WAFFLE,
  GARLIC_BREAD_TOAST,
  BAKED_CHEESE_NACHOS,
  BLUEBERRY_CHEESECAKE,
  BISCOFF_CHEESECAKE,
  RED_VELVET_CUPCAKE,
  NO_TRAITS_ITEM,
  UNAVAILABLE_ITEM,
  SNOOZED_ITEM,
];

const TRAITS_LIST: MenuItemTraits[] = [
  ESPRESSO_TRAITS,
  CAPPUCCINO_TRAITS,
  CAFE_LATTE_TRAITS,
  DOPPIO_TRAITS,
  FLAT_WHITE_TRAITS,
  MOCHA_TRAITS,
  CORTADO_TRAITS,
  RISTRETTO_TRAITS,
  HOT_AMERICANO_TRAITS,
  CAFE_MACCHIATO_TRAITS,
  CHAI_LATTE_TRAITS,
  HOT_CHOCOLATE_TRAITS,
  SIGNATURE_CREME_TRAITS,
  HAZELNUT_CREME_TRAITS,
  STRAWBERRY_CREME_TRAITS,
  ON_THE_ROCKS_TRAITS,
  ICED_LATTE_TRAITS,
  ICED_AMERICANO_TRAITS,
  BERRY_LEMONADE_TRAITS,
  MATCHA_ICED_LATTE_TRAITS,
  COLD_BREW_TRAITS,
  VANILLA_COLD_BREW_TRAITS,
  BELGIAN_WAFFLE_TRAITS,
  NUTELLA_WAFFLE_TRAITS,
  GARLIC_BREAD_TOAST_TRAITS,
  BAKED_CHEESE_NACHOS_TRAITS,
  BLUEBERRY_CHEESECAKE_TRAITS,
  BISCOFF_CHEESECAKE_TRAITS,
  RED_VELVET_CUPCAKE_TRAITS,
  // NO_TRAITS_ITEM deliberately has no entry.
  UNAVAILABLE_ITEM_TRAITS,
  SNOOZED_ITEM_TRAITS,
];

/** A fresh Map each call — tests that mutate it (e.g. deleting a row) never
 * leak state to the next test. */
export function buildFixtureTraitsById(): Map<string, MenuItemTraits> {
  return new Map(TRAITS_LIST.map((t) => [t.menu_item_id, t]));
}

/** A fresh, independent copy of the fixture menu (shallow item copies —
 * enough that tests flipping `is_available` etc. on one copy don't affect
 * another test's). */
export function buildFixtureMenu(): MenuItem[] {
  return SUGGEST_FIXTURE_ITEMS.map((item) => ({ ...item, variants: [...item.variants] }));
}
