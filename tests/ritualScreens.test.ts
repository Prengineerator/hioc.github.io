import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The customer /ritual screens' pieces, server-rendered (there is no DOM in this
// suite; effects do not run on the server, so this is the first paint). It pins
// what a customer is shown before they touch anything: plan cards with no fixed
// price, the drink picker, the price panel's states, and "Your Ritual" titled by
// its drink (docs/COFFEE-PASS-SPEC.md §13).

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/ritual',
}));

import { DrinkPicker } from '@/components/passes/DrinkPicker';
import { PassCard } from '@/components/passes/PassCard';
import { PlanCard } from '@/components/passes/PlanCard';
import { RitualBuilder } from '@/components/passes/RitualBuilder';
import type { CoffeePassPlan, RitualDrink } from '@/lib/passes/types';
import type { PassWithHistory, RitualOffer } from '@/lib/passes/ui';

const noop = () => {};

/** The opening tag of the button whose content holds `text`. */
function buttonTag(html: string, text: string): string {
  const segment = html.split('<button').find((part, i) => i > 0 && part.slice(part.indexOf('>')).split('</button>')[0].includes(text));
  return segment ? segment.slice(0, segment.indexOf('>')) : '';
}

const WEEKLY: CoffeePassPlan = {
  id: 'plan-weekly',
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
  sort_order: 10,
};
const MONTHLY: CoffeePassPlan = {
  ...WEEKLY,
  id: 'plan-monthly',
  name: 'Monthly Ritual',
  drinks_paid: 6,
  validity_days: 30,
  sort_order: 20,
};

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
const FEW = [drink('cap', 'Cappuccino', 'Coffee'), drink('cold', 'Cold Brew', 'Cold Brews', { is_available: false })];
// More than the search threshold, so the picker offers a search box.
const MANY = Array.from({ length: 12 }, (_, i) => drink(`d${i}`, `Drink ${i}`, i % 2 ? 'Coffee' : 'Iced Coffee'));

const offer = (over: Partial<RitualOffer> = {}): RitualOffer => ({
  plans: [WEEKLY, MONTHLY],
  eligible: FEW,
  online_purchase: true,
  gst: { percent: 5, inclusive: false },
  ...over,
});

describe('PlanCard', () => {
  const render = (selected: boolean, plan = WEEKLY) =>
    renderToStaticMarkup(createElement(PlanCard, { plan, selected, groupName: 'plans', onSelect: noop }));

  it('states what the customer gets and that the price follows the drink: no fixed price, no cup value', () => {
    const html = render(false);
    expect(html).toContain('Weekly Ritual');
    expect(html).toContain('7 cups for the price of 5');
    expect(html).toContain('Save 29%');
    expect(html).toContain('Valid 7 days');
    expect(html).toContain('The price follows the drink you pick.');
    expect(html).not.toContain('₹');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('covers up to');
  });

  it('is a radio in a group, checked when it is the chosen plan', () => {
    expect(render(true)).toContain('type="radio"');
    expect(render(true)).toContain('name="plans"');
    expect(render(true)).toMatch(/<input[^>]*\schecked=""/);
    expect(render(false)).not.toMatch(/<input[^>]*\schecked=""/);
  });

  it('a Monthly reads "Pay for 6, get 7"', () => {
    expect(render(false, MONTHLY)).toContain('Pay for 6, get 7');
    expect(render(false, MONTHLY)).toContain('Valid 30 days');
  });
});

describe('DrinkPicker', () => {
  const render = (drinks: RitualDrink[], choice = { drinkId: null as string | null, variantId: null as string | null }) =>
    renderToStaticMarkup(createElement(DrinkPicker, { drinks, choice, onChoice: noop }));

  it('lists the drinks by category with their prices, and greys one that is off the menu today', () => {
    const html = render(FEW);
    expect(html).toContain('Cappuccino');
    expect(html).toContain('₹90–₹120');
    expect(html).toContain('Not available today');
    expect(buttonTag(html, 'Not available today')).toContain('disabled=""');
    expect(buttonTag(html, '₹90–₹120')).not.toContain('disabled=""');
  });

  it('offers a search box only once the list is long, and category chips when there is more than one category', () => {
    expect(render(FEW)).not.toContain('Search drinks');
    const many = render(MANY);
    expect(many).toContain('Search drinks');
    expect(many).toContain('type="search"');
    expect(many).toContain('aria-label="Category"');
  });

  it('rows are at least 52px tall', () => {
    expect(render(FEW)).toContain('min-h-[52px]');
  });

  it('after a drink is chosen shows it with its sizes and prices, and a way to change it', () => {
    const html = render(FEW, { drinkId: 'cap', variantId: null });
    expect(html).toContain('Cappuccino');
    expect(html).toContain('Size');
    expect(html).toContain('Small');
    expect(html).toContain('₹90');
    expect(html).toContain('Large');
    expect(html).toContain('₹120');
    expect(html).toContain('Change drink');
    expect(html).not.toMatch(/<input[^>]*\schecked=""/); // no size chosen yet
    expect(render(FEW, { drinkId: 'cap', variantId: 'cap-l' })).toMatch(/<input[^>]*\schecked=""/);
  });

  it('says so when no drink is set up yet', () => {
    expect(render([])).toContain('No drinks are set up for a Ritual yet');
  });
});

describe('RitualBuilder — first paint', () => {
  const render = (over: Partial<RitualOffer> = {}, signedIn = true) =>
    renderToStaticMarkup(
      createElement(RitualBuilder, { offer: offer(over), signedIn, opening: null, busy: false, onBuy: noop }),
    );

  it('shows the plans, the drink picker and a price panel that waits for a drink', () => {
    const html = render();
    expect(html).toContain('Pick a plan');
    expect(html).toContain('Weekly Ritual');
    expect(html).toContain('Monthly Ritual');
    expect(html).toContain('Choose your drink');
    expect(html).toContain('Your price');
    expect(html).toContain('Choose a drink to see your price.');
  });

  it('opens with the first plan chosen, so the price shows as soon as a size is', () => {
    const html = render();
    const checked = html.match(/<input[^>]*\schecked=""[^>]*>/g) ?? [];
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('plan-weekly');
  });

  it('keeps Buy off (and unnamed by a price) until a drink and size are chosen', () => {
    const html = render();
    expect(html).toContain('Buy Weekly Ritual');
    expect(html).not.toContain('Buy Weekly Ritual ·');
    expect(buttonTag(html, 'Buy Weekly Ritual')).toContain('disabled=""');
  });

  it('asks a signed-out customer to log in, and sends a counter-only shop to the counter', () => {
    expect(render({}, false)).toContain('Log in to buy');
    expect(render({ online_purchase: false })).toContain('Buy at the counter');
    expect(render({ online_purchase: false })).not.toContain('Buy Weekly Ritual');
  });
});

describe('PassCard — "Your Ritual"', () => {
  const pass = (over: Partial<PassWithHistory> = {}): PassWithHistory => ({
    id: 'pass-1',
    plan_id: 'plan-weekly',
    plan_name: 'Weekly Ritual',
    drinks_total: 7,
    drinks_used: 2,
    drinks_credited: 0,
    drinks_remaining: 5,
    drink_value_inr: 120,
    max_per_day: null,
    used_today: 0,
    price_inr: 600,
    starts_at: '2026-10-05T04:30:00.000Z',
    expires_at: '2026-10-11T18:30:00.000Z',
    status: 'active',
    state: 'active',
    order_id: 'order-1',
    drink_menu_item_id: 'cap',
    drink_label: 'Cappuccino · Large',
    history: [],
    ...over,
  });
  const render = (p: PassWithHistory) => renderToStaticMarkup(createElement(PassCard, { pass: p }));

  it('is titled by its drink and says what each cup covers', () => {
    const html = render(pass());
    expect(html).toContain('Weekly Ritual · Cappuccino · Large');
    expect(html).toContain('Each cup covers up to');
    expect(html).toContain('₹120');
    expect(html).toContain('font-mono');
  });

  it('a pass with no drink label (from before per-drink pricing) falls back to the plan name', () => {
    const html = render(pass({ drink_label: '', drink_menu_item_id: null, drink_value_inr: 150 }));
    expect(html).toContain('Weekly Ritual');
    expect(html).not.toContain('Cappuccino');
    expect(html).toContain('₹150');
  });
});
