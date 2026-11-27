// Presentation helpers for shop orders in the account (docs/SHOP-V2-SPEC.md E4).

import { describe, expect, it } from 'vitest';
import {
  activeShopSentence,
  beaniesWorth,
  shopChannelBadgeText,
  shopItemsSummary,
  shopStatusSteps,
  splitShopRefFromNote,
} from '@/lib/account/orderDisplay';
import { SHOP_ORDER_STATUSES } from '@/lib/shop/status';
import type { ShopLine } from '@/lib/shop/types';

const instant = (name: string, quantity: number): ShopLine => ({
  product_id: name,
  name,
  sku: name,
  unit_price_inr: 100,
  quantity,
  line_total_inr: 100 * quantity,
});

const blend = (quantity: number, grind: ShopLine['grind'] = 'filter'): ShopLine => ({
  product_id: 'hb',
  name: 'Signature Home Blend',
  sku: 'HIOC-HB-500G-FLT',
  unit_price_inr: 600,
  quantity,
  line_total_inr: 600 * quantity,
  line: 'home_blend',
  pack_grams: 500,
  grind,
});

describe('shopChannelBadgeText', () => {
  it('names the city', () => expect(shopChannelBadgeText('Pune')).toBe('Shipped to Pune'));
  it('trims and tolerates a missing city', () => {
    expect(shopChannelBadgeText('  Goa ')).toBe('Shipped to Goa');
    expect(shopChannelBadgeText('')).toBe('Shipped');
    expect(shopChannelBadgeText(null)).toBe('Shipped');
  });
});

describe('shopItemsSummary', () => {
  it('words instant and home blend lines with the grind', () => {
    expect(shopItemsSummary([instant('Signature Classic', 2), blend(1)])).toBe(
      '2× Signature Classic, 1× Home Blend 500 g · Filter',
    );
  });
  it('keeps three lines and counts the rest', () => {
    const lines = [instant('A', 1), instant('B', 1), instant('C', 1), instant('D', 1), instant('E', 1)];
    expect(shopItemsSummary(lines)).toBe('1× A, 1× B, 1× C +2 more');
    expect(shopItemsSummary(lines, 4)).toBe('1× A, 1× B, 1× C, 1× D +1 more');
  });
  it('does not truncate at exactly max', () => {
    expect(shopItemsSummary([instant('A', 1), instant('B', 1), instant('C', 1)])).toBe('1× A, 1× B, 1× C');
  });
  it('is empty for no lines', () => expect(shopItemsSummary([])).toBe(''));
});

describe('shopStatusSteps', () => {
  const states = (s: Parameters<typeof shopStatusSteps>[0]) => shopStatusSteps(s).steps.map((x) => x.state);

  it('always lists the four steps in order', () => {
    for (const s of SHOP_ORDER_STATUSES) {
      expect(shopStatusSteps(s).steps.map((x) => x.label)).toEqual(['Paid', 'Packed', 'Shipped', 'Delivered']);
    }
  });
  it('paid is on step 0', () => {
    expect(shopStatusSteps('paid').currentIndex).toBe(0);
    expect(states('paid')).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
  });
  it('sent_to_shiprocket is Packed', () => {
    expect(shopStatusSteps('sent_to_shiprocket').currentIndex).toBe(1);
    expect(states('sent_to_shiprocket')).toEqual(['done', 'current', 'upcoming', 'upcoming']);
  });
  it('shipped is on step 2', () => expect(states('shipped')).toEqual(['done', 'done', 'current', 'upcoming']));
  it('delivered is on the last step', () => {
    expect(shopStatusSteps('delivered').currentIndex).toBe(3);
    expect(states('delivered')).toEqual(['done', 'done', 'done', 'current']);
  });
  it('payment_pending has no current step and no terminal', () => {
    const r = shopStatusSteps('payment_pending');
    expect(r.currentIndex).toBe(-1);
    expect(r.terminal).toBeNull();
    expect(states('payment_pending')).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming']);
  });
  it('cancelled and expired leave the track with words', () => {
    expect(shopStatusSteps('cancelled')).toMatchObject({ currentIndex: -1, terminal: 'Cancelled' });
    expect(shopStatusSteps('expired')).toMatchObject({ currentIndex: -1, terminal: 'Payment not completed' });
    expect(states('cancelled')).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming']);
  });
  it('only cancelled and expired are terminal', () => {
    const terminal = SHOP_ORDER_STATUSES.filter((s) => shopStatusSteps(s).terminal !== null);
    expect(terminal).toEqual(['cancelled', 'expired']);
  });
});

describe('activeShopSentence', () => {
  it('says on its way once shipped', () => expect(activeShopSentence({ status: 'shipped' })).toBe('Your coffee is on its way'));
  it('says packing before that', () => {
    expect(activeShopSentence({ status: 'paid' })).toBe('Your coffee is being packed');
    expect(activeShopSentence({ status: 'sent_to_shiprocket' })).toBe('Your coffee is being packed');
  });
});

describe('beaniesWorth', () => {
  it('multiplies and rounds down', () => {
    expect(beaniesWorth(39, 1)).toBe('₹39');
    expect(beaniesWorth(39, 0.5)).toBe('₹19');
  });
  it('never goes negative or NaN', () => {
    expect(beaniesWorth(0, 1)).toBe('₹0');
    expect(beaniesWorth(-5, 1)).toBe('₹0');
    expect(beaniesWorth(Number.NaN, 1)).toBe('₹0');
    expect(beaniesWorth(10, Number.NaN)).toBe('₹0');
  });
  it('groups thousands the Indian way', () => expect(beaniesWorth(123456, 1)).toBe('₹1,23,456'));
});

describe('splitShopRefFromNote', () => {
  it('splits a shop ledger note around the order number', () => {
    expect(splitShopRefFromNote('Earned on shop order HIOC-S1004')).toEqual({
      before: 'Earned on shop order ',
      ref: 'HIOC-S1004',
      after: '',
    });
    expect(splitShopRefFromNote('Used 39 Beanies for ₹39 off shop order HIOC-S12 today')?.after).toBe(' today');
  });
  it('is null for a café note or no note', () => {
    expect(splitShopRefFromNote('Earned on order #1042')).toBeNull();
    expect(splitShopRefFromNote(null)).toBeNull();
    expect(splitShopRefFromNote('')).toBeNull();
  });
});
