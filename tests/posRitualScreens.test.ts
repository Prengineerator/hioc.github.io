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

import { PassCard } from '@/components/staff/passes/PassCard';
import { PlanCard } from '@/components/staff/passes/PlanCard';
import { RitualPassesScreen } from '@/components/staff/passes/RitualPassesScreen';
import type { CoffeePassPlan } from '@/lib/passes/types';
import type { HolderPass } from '@/lib/pos/ritual';

const noop = () => {};

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
    history: [],
    ...overrides,
  };
}

const plan: CoffeePassPlan = {
  id: 'plan-1',
  name: 'Weekly Ritual',
  description: '',
  drinks_total: 7,
  drinks_paid: 5,
  validity_days: 7,
  drink_value_inr: 150,
  price_inr: 750,
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
  const render = (over: Partial<CoffeePassPlan> = {}, gst = { percent: 5, inclusive: false }, sellBlocked = false) =>
    renderToStaticMarkup(
      createElement(PlanCard, { plan: { ...plan, ...over }, gst, sellBlocked, blockedReasonId: 'reason', onSell: noop }),
    );

  it('shows the name, "7 cups · 7 days", the price with "+ GST", the per-cup price and the saving', () => {
    const html = render();
    expect(html).toContain('Weekly Ritual');
    expect(html).toContain('7 cups · 7 days');
    expect(html).toContain('₹750');
    expect(html).toContain('+ GST');
    expect(html).toContain('₹107');
    expect(html).toContain('pay for 5, get');
    expect(html).toContain('Save 29%');
    expect(html).toContain('font-mono');
  });

  it('drops "+ GST" when the price already includes it or the plan is exempt', () => {
    expect(render({}, { percent: 5, inclusive: true })).not.toContain('+ GST');
    expect(render({ gst_exempt: true })).not.toContain('+ GST');
  });

  it('disables Sell, and points at the reason, while the customer is not ready', () => {
    const html = render({}, { percent: 5, inclusive: false }, true);
    // The class list carries "disabled:…" variants, so match the attribute itself.
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toContain('aria-describedby="reason"');
    expect(render()).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(render()).not.toContain('aria-describedby');
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
