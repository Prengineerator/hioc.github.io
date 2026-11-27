// A small menu for the "made your way" tests (COFFEY-SPEC §11): coffees that can
// be made nutty or caramel with a syrup and stronger with an espresso shot, next
// to ones that carry the flavour themselves, one with no add-ons, desserts and a
// food. A separate fixture, so the shared one (tests/fixtures/suggestMenu.ts) and
// every expectation pinned to it stay as they were.

import type { AddonGroup, MenuItem } from '@/lib/types';
import type { MenuItemTraits } from '@/lib/suggest/types';
import { buildSugarGroup, makeMenuItem, makeTraitsV2 } from './suggestMenu';

export function syrupGroupFor(prefix: string, priceInr = 35): AddonGroup {
  const id = `${prefix}-syrup`;
  const opt = (key: string, name: string, order: number) => ({
    id: `${id}-${key}`,
    addon_group_id: id,
    name,
    price_inr: priceInr,
    sort_order: order,
  });
  return {
    id,
    name: 'Add On Syrup',
    display_name: 'Add a Syrup',
    selection_type: 'single',
    min_select: 0,
    max_select: 1,
    sort_order: 30,
    options: [opt('vanilla', 'Vanilla', 0), opt('hazelnut', 'Hazelnut', 1), opt('caramel', 'Caramel', 2)],
  };
}

export function shotGroupFor(prefix: string, priceInr = 40): AddonGroup {
  const id = `${prefix}-shot`;
  return {
    id,
    name: 'Add On Shot',
    display_name: 'Add a shot',
    selection_type: 'single',
    min_select: 0,
    max_select: 1,
    sort_order: 40,
    options: [{ id: `${id}-espresso`, addon_group_id: id, name: 'Espresso Shot', price_inr: priceInr, sort_order: 0 }],
  };
}

interface Spec {
  id: string;
  name: string;
  price: number;
  traits: Partial<MenuItemTraits> & { sweetness_level: number };
  groups?: ('syrup' | 'shot' | 'sugar')[];
}

const COFFEE = { kind: 'drink', is_coffee: true, caffeine: 'medium', body: 'medium', temperature: 'hot', intensity: 2 } as const;

const SPECS: Spec[] = [
  { id: 'ax-cappuccino', name: 'Cappuccino', price: 130, traits: { ...COFFEE, sweetness_level: 1 }, groups: ['sugar', 'syrup', 'shot'] },
  { id: 'ax-latte', name: 'Cafe Latte', price: 140, traits: { ...COFFEE, sweetness_level: 2 }, groups: ['syrup', 'shot'] },
  { id: 'ax-americano', name: 'Hot Americano', price: 110, traits: { ...COFFEE, intensity: 3, caffeine: 'high', sweetness_level: 0 }, groups: ['shot'] },
  { id: 'ax-mocha', name: 'Mocha', price: 160, traits: { ...COFFEE, sweetness_level: 3, flavor_notes: ['chocolate'] }, groups: ['syrup', 'shot'] },
  { id: 'ax-hazelnut-latte', name: 'Hazelnut Latte', price: 170, traits: { ...COFFEE, sweetness_level: 3, flavor_notes: ['hazelnut'] }, groups: ['syrup', 'shot'] },
  { id: 'ax-plain-flat-white', name: 'Flat White', price: 150, traits: { ...COFFEE, sweetness_level: 1 } },
  { id: 'ax-iced-latte', name: 'Iced Latte', price: 150, traits: { ...COFFEE, temperature: 'iced', sweetness_level: 3 }, groups: ['sugar', 'syrup', 'shot'] },
  { id: 'ax-cold-brew', name: 'Cold Brew', price: 160, traits: { ...COFFEE, temperature: 'iced', intensity: 3, caffeine: 'high', sweetness_level: 0 }, groups: ['sugar'] },
  { id: 'ax-lemonade', name: 'Berry Lemonade', price: 120, traits: { kind: 'drink', is_coffee: false, caffeine: 'none', temperature: 'iced', intensity: 0, body: 'light', sweetness_level: 6, flavor_notes: ['berry'] } },
  { id: 'ax-brownie', name: 'Fudge Brownie', price: 140, traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', temperature: 'ambient', body: 'rich', sweetness_level: 9, flavor_notes: ['chocolate'] } },
  { id: 'ax-cheesecake', name: 'Blueberry Cheesecake', price: 180, traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', temperature: 'ambient', body: 'rich', sweetness_level: 7, flavor_notes: ['blueberry'] } },
  { id: 'ax-garlic-bread', name: 'Garlic Bread', price: 120, traits: { kind: 'food', is_coffee: false, caffeine: 'none', temperature: 'ambient', body: 'medium', sweetness_level: 0 } },
];

export function buildAddonMenu(): { items: MenuItem[]; traitsById: Map<string, MenuItemTraits> } {
  const items: MenuItem[] = [];
  const traitsById = new Map<string, MenuItemTraits>();
  for (const spec of SPECS) {
    const groups = (spec.groups ?? []).map((g) => (g === 'sugar' ? buildSugarGroup(spec.id) : g === 'syrup' ? syrupGroupFor(spec.id) : shotGroupFor(spec.id)));
    items.push(makeMenuItem({ id: spec.id, name: spec.name, priceInr: spec.price, addon_groups: groups }));
    traitsById.set(spec.id, makeTraitsV2({ menu_item_id: spec.id, moods: ['cosy'], mood_fit: { cosy: 3 }, ...spec.traits }));
  }
  return { items, traitsById };
}
