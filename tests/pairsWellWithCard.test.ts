import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Coffey checkout pairings (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §1.2): what the
// card looks like and, as important, that it looks like NOTHING before there is
// something to show. The repo's vitest environment is node-only, so this renders
// to static markup — the first paint, which is exactly the "no skeleton, no layout
// shift" case — and renders the presentational card with sample rows.

const flagState = { checkoutPairings: true };
vi.mock('@/lib/flags', () => ({
  flags: {
    get checkoutPairings() {
      return flagState.checkoutPairings;
    },
  },
}));

import { PairsWellWith, PairsWellWithCard, type PairingRow } from '@/components/checkout/PairsWellWith';
import { CartProvider } from '@/lib/cart/CartContext';
import type { MenuItem } from '@/lib/types';

function menuItem(id: string, name: string, price: number, over: Partial<MenuItem> = {}): MenuItem {
  return {
    id,
    name,
    description: '',
    category: 'Desserts',
    parent_category: 'Menu',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    variants: [{ id: `${id}-v`, menu_item_id: id, label: 'Regular', price_inr: price, sort_order: 0 }],
    addon_groups: [],
    ...over,
  };
}

const rows: PairingRow[] = [
  {
    pick: { menuItemId: 'brownie', anchorItemId: 'americano', reason: 'Pairs well with your Americano — a sweet finish.', score: 0.53 },
    item: menuItem('brownie', 'Fudge Brownie', 120),
    minPriceInr: 120,
  },
  {
    pick: { menuItemId: 'sandwich', anchorItemId: 'americano', reason: 'Often ordered with your Americano.', score: 0.4 },
    item: menuItem('sandwich', 'Veg Sandwich', 150, { is_veg: false, category: 'Food' }),
    minPriceInr: 99,
  },
];

describe('PairsWellWith (first paint)', () => {
  it('renders nothing at all — no skeleton, no placeholder — before a response has arrived', () => {
    const html = renderToStaticMarkup(createElement(CartProvider, null, createElement(PairsWellWith)));
    expect(html).toBe('');
  });

  it('renders nothing when the flag is off', () => {
    flagState.checkoutPairings = false;
    try {
      const html = renderToStaticMarkup(createElement(CartProvider, null, createElement(PairsWellWith)));
      expect(html).toBe('');
    } finally {
      flagState.checkoutPairings = true;
    }
  });
});

describe('PairsWellWithCard', () => {
  const html = renderToStaticMarkup(createElement(PairsWellWithCard, { rows, onAdd: () => {} }));

  it('is titled "Pairs well with your order", with a 20 px mascot', () => {
    expect(html).toContain('Pairs well with your order');
    expect(html).toMatch(/<svg[^>]*width="20"[^>]*height="20"/);
  });

  it('has a row per pick: name, reason, "from ₹min"', () => {
    expect(html).toContain('Fudge Brownie');
    expect(html).toContain('Pairs well with your Americano — a sweet finish.');
    expect(html).toContain('Veg Sandwich');
    expect(html).toContain('Often ordered with your Americano.');
    expect(html).toMatch(/from <span[^>]*>₹120<\/span>/);
    expect(html).toMatch(/from <span[^>]*>₹99<\/span>/);
    expect(html.match(/<li /g)).toHaveLength(2);
  });

  it('shows the existing image placeholder when an item has no photo, and the veg marker', () => {
    expect(html).toContain('☕');
    expect(html).toContain('aria-label="Vegetarian"');
    expect(html).toContain('aria-label="Non-vegetarian"');
  });

  it('gives each row an Add button with a name, at least 44 px tall', () => {
    expect(html).toContain('aria-label="Add Fudge Brownie to your order"');
    expect(html).toContain('aria-label="Add Veg Sandwich to your order"');
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain('min-h-[44px]');
      expect(button).toContain('type="button"');
    }
  });

  it('cannot scroll sideways at 360 px: the text column shrinks and wraps, the card is a section', () => {
    expect(html).toContain('min-w-0');
    expect(html).toContain('break-words');
    expect(html).not.toMatch(/\b(w|min-w)-\[\d+px\]/); // no fixed-width boxes
    expect(html).not.toContain('overflow-x');
    expect(html).toMatch(/^<section[^>]*aria-labelledby="pairs-well-heading"/);
  });

  it('uses brand tokens only: no hex colours, no inline styles', () => {
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3}\b(?!\w)/);
    expect(html).not.toContain('style=');
    expect(html).not.toMatch(/\[#/);
  });
});
