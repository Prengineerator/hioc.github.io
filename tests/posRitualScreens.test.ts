import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The Ritual passes screen's pieces, server-rendered (there is no DOM in this
// suite; effects do not run on the server, so this is the first paint). It pins
// what the counter is shown before anything is typed, what a pass card offers to
// whom, and what a plan card says — the things a type check cannot.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/staff/passes',
}));

import { DrinkSizePicker } from '@/components/staff/passes/DrinkSizePicker';
import { PassCard } from '@/components/staff/passes/PassCard';
import { PlanCard } from '@/components/staff/passes/PlanCard';
import { RitualPassesScreen } from '@/components/staff/passes/RitualPassesScreen';
import type { CoffeePassPlan, RitualDrink } from '@/lib/passes/types';
import type { HolderPass } from '@/lib/pos/ritual';

const noop = () => {};

/** The opening tag of the button whose content holds `text`. */
function buttonTag(html: string, text: string): string {
  const segment = html.split('<button').find((part, i) => i > 0 && part.slice(part.indexOf('>')).split('</button>')[0].includes(text));
  return segment ? segment.slice(0, segment.indexOf('>')) : '';
}

function pass(overrides: Partial<HolderPass> = {}): HolderPass {
  return {
    id: 'pass-1',
    plan_id: 'plan-1',
    plan_name: 'Weekly Ritual',
    drinks_total: 7,
    drinks_used: 2,
    drinks_credited: 0,
    drinks_remaining: 5,
    drink_value_inr: 150,
    max_per_day: null,
    used_today: 0,
    price_inr: 750,
    starts_at: '2026-09-28T04:30:00.000Z',
    expires_at: '2026-10-04T18:30:00.000Z',
    status: 'active',
    state: 'active',
    order_id: 'order-1',
    drink_menu_item_id: 'menu-cappuccino',
    drink_label: 'Cappuccino · Large',
    history: [],
    ...overrides,
  };
}

// A plan is the recipe (CP-D24): no price, no cup value.
const plan: CoffeePassPlan = {
  id: 'plan-1',
  name: 'Weekly Ritual',
  description: '',
  drinks_total: 7,
  drinks_paid: 5,
  validity_days: 7,
  drink_value_inr: null,
  price_inr: null,
  max_per_day: null,
  gst_exempt: false,
  is_active: true,
  sort_order: 1,
};

const card = (p: HolderPass, canManage: boolean) =>
  renderToStaticMarkup(createElement(PassCard, { pass: p, canManage, onExtend: noop, onGiveBack: noop }));

describe('PassCard', () => {
  it('shows the plan, the cups left in words, and how long it is good for', () => {
    const html = card(pass(), false);
    expect(html).toContain('Weekly Ritual');
    expect(html).toContain('5 of 7 cups left');
    expect(html).toContain('Valid till Sun 4 Oct');
    expect(html).toContain('Active');
    // One decorative dot per cup the pass can give.
    expect(html.match(/rounded-full border-2 border-tan-dark/g)).toHaveLength(7);
  });

  it('titles the pass with its drink and says what a cup covers (CP-D25)', () => {
    const html = card(pass(), false);
    expect(html).toContain('Weekly Ritual · Cappuccino · Large');
    expect(html).toContain('Each cup covers up to');
    expect(html).toContain('₹150');
  });

  it('a pass with no drink label (from before per-drink pricing) reads as its plan', () => {
    const html = card(pass({ drink_label: '', drink_menu_item_id: null }), false);
    expect(html).toContain('Weekly Ritual');
    expect(html).not.toContain('Cappuccino');
  });

  it('offers Extend and Give back a cup to a manager only', () => {
    expect(card(pass(), true)).toContain('Extend');
    expect(card(pass(), true)).toContain('Give back a cup');
    expect(card(pass(), false)).not.toContain('Extend');
    expect(card(pass(), false)).not.toContain('Give back a cup');
  });

  it('offers a manager nothing on a refunded or void pass (the API would say "isn’t active")', () => {
    expect(card(pass({ status: 'refunded', state: 'refunded' }), true)).not.toContain('Extend');
    expect(card(pass({ status: 'void', state: 'void' }), true)).not.toContain('Give back a cup');
  });

  it('still lets a manager fix a used-up or lapsed pass', () => {
    expect(card(pass({ state: 'used_up', drinks_remaining: 0 }), true)).toContain('Give back a cup');
    expect(card(pass({ state: 'expired' }), true)).toContain('Expired Sun 4 Oct');
    expect(card(pass({ state: 'expired' }), true)).toContain('Extend');
  });

  it('keeps its history collapsed, with a button that says how many uses there are', () => {
    const html = card(
      pass({
        history: [
          { order_id: 'o1', order_number: 1042, drinks: 2, covered_inr: 270, created_at: '2026-09-29T10:00:00.000Z', reversed: false },
        ],
      }),
      false,
    );
    expect(html).toContain('History (1)');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('₹270 covered');
  });

  it('says a daily limit when the plan has one', () => {
    expect(card(pass({ max_per_day: 1, used_today: 1 }), false)).toContain('Up to 1 a day · 1 used today');
  });
});

describe('PlanCard', () => {
  const render = (over: Partial<CoffeePassPlan> = {}, sellBlocked = false) =>
    renderToStaticMarkup(
      createElement(PlanCard, { plan: { ...plan, ...over }, sellBlocked, blockedReasonId: 'reason', onSell: noop }),
    );

  it('shows the name, "7 cups · 7 days", the saving and that the price follows the drink (no fixed price, no ₹NaN)', () => {
    const html = render();
    expect(html).toContain('Weekly Ritual');
    expect(html).toContain('7 cups · 7 days');
    expect(html).toContain('Save 29%');
    expect(html).toContain('The price follows the drink you pick.');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('₹');
    expect(html).not.toContain('GST');
    expect(html).toContain('Sell Weekly Ritual');
  });

  it('says a daily limit when the plan has one', () => {
    expect(render({ max_per_day: 1 })).toContain('up to 1 a day');
    expect(render()).not.toContain('a day');
  });

  it('disables Sell, and points at the reason, while the customer is not ready', () => {
    const html = render({}, true);
    // The class list carries "disabled:…" variants, so match the attribute itself.
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toContain('aria-describedby="reason"');
    expect(render()).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(render()).not.toContain('aria-describedby');
  });
});

describe('DrinkSizePicker — first paint and the choice', () => {
  const drink = (id: string, name: string, category: string, over: Partial<RitualDrink> = {}): RitualDrink => ({
    id,
    name,
    category,
    is_available: true,
    sizes: [
      { variant_id: `${id}-s`, label: 'Small', price_inr: 90 },
      { variant_id: `${id}-l`, label: 'Large', price_inr: 120 },
    ],
    ...over,
  });
  const drinks = [
    drink('cap', 'Cappuccino', 'Coffee'),
    drink('lat', 'Latte', 'Coffee'),
    drink('ice', 'Iced Americano', 'Iced Coffee', { sizes: [{ variant_id: 'ice-r', label: '', price_inr: 100 }] }),
    drink('cold', 'Cold Brew', 'Cold Brews', { is_available: false }),
  ];
  const render = (choice = { drinkId: null as string | null, variantId: null as string | null }, list = drinks) =>
    renderToStaticMarkup(createElement(DrinkSizePicker, { drinks: list, choice, onChoice: noop }));

  it('puts the search box first, then the category chips, then the drinks as tiles with their prices', () => {
    const html = render();
    expect(html.indexOf('Search drinks')).toBeGreaterThan(-1);
    expect(html.indexOf('Search drinks')).toBeLessThan(html.indexOf('aria-label="Category"'));
    expect(html.indexOf('aria-label="Category"')).toBeLessThan(html.indexOf('Cappuccino'));
    expect(html).toContain('Iced Coffee');
    expect(html).toContain('₹90–₹120');
    expect(html).toContain('₹100'); // a single size: one price
    // Chips name the category with how many drinks it holds, and are toggles.
    expect(html).toContain('aria-pressed="true"'); // "All" is on
  });

  it('has big tap targets on the tiles and chips (at least 48px), and no size row before a drink is chosen', () => {
    const html = render();
    expect(html).toContain('min-h-[64px]');
    expect(html).toContain('min-h-[48px]');
    expect(html).not.toContain('Size for');
  });

  it('greys a drink that is off the menu today and cannot be picked', () => {
    const html = render();
    expect(html).toContain('Not available today');
    expect(buttonTag(html, 'Not available today')).toContain('disabled=""');
    expect(buttonTag(html, '₹90–₹120')).not.toContain('disabled=""');
  });

  it('shows the sizes of the chosen drink with their prices, and marks the chosen one', () => {
    const html = render({ drinkId: 'cap', variantId: 'cap-l' });
    expect(html).toContain('Size for Cappuccino');
    expect(html).toContain('Small');
    expect(html).toContain('₹90');
    expect(html).toContain('Large');
    expect(html).toContain('₹120');
    // The chosen drink tile and the chosen size are both marked (colour is never the only signal).
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBeGreaterThanOrEqual(3); // All, the tile, the size
  });

  it('a drink with one size and no size name reads "One size"', () => {
    expect(render({ drinkId: 'ice', variantId: 'ice-r' })).toContain('One size');
  });

  it('says so when no drink is set up for a Ritual yet', () => {
    expect(render({ drinkId: null, variantId: null }, [])).toContain('No drinks are set up');
  });
});

describe('RitualPassesScreen — first paint', () => {
  const screen = (props: Partial<Parameters<typeof RitualPassesScreen>[0]> = {}) =>
    renderToStaticMarkup(createElement(RitualPassesScreen, { canManage: false, canSell: true, ...props }));

  it('asks for the phone first, and says why Sell is off', () => {
    const html = screen();
    expect(html).toContain('Ritual passes');
    expect(html).toContain('Mobile number');
    expect(html).toContain('Enter the customer’s mobile number to see their HIOC Ritual.');
    expect(html).toContain('10-digit mobile number first');
  });

  it('pre-fills the phone it was opened with (?phone= from New order)', () => {
    expect(screen({ initialPhone: '9876543210' })).toContain('value="9876543210"');
  });

  it('tells a staffer who may not sell why, instead of leaving Sell dead', () => {
    const html = screen({ canSell: false, sellBlockedMessage: 'You don’t have permission to sell HIOC Ritual.' });
    expect(html).toContain('permission to sell HIOC Ritual');
  });
});
