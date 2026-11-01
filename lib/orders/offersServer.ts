// The live multi-buy offers for the items on an order (lib/orders/offers.ts,
// supabase/2026-10-item-offers.sql). Order create, the quote and the running-tab
// add load them once and hand them to resolveOrderLines, which snapshots the
// offer onto each line it applies to.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  liveOffersByItem,
  liveSpendOffers,
  type ActiveOffer,
  type OfferRow,
  type SpendOffer,
  type SpendOfferRow,
} from '@/lib/orders/offers';

/** Live offers by menu item id. */
export type OffersByItem = ReadonlyMap<string, ActiveOffer>;

/**
 * The offers live at `now` on `menuItemIds`, keyed by item. Never throws and
 * never blocks an order: a read that fails (the table not created yet, a
 * network blip) means "no offer", and the bill is the regular one.
 */
export async function loadActiveOffers(
  admin: SupabaseClient,
  menuItemIds: readonly string[],
  now: Date = new Date(),
): Promise<OffersByItem> {
  if (menuItemIds.length === 0) return new Map();
  return liveOffersByItem(await loadOfferRows(admin, menuItemIds), now);
}

/**
 * The switched-on offer rows (on `menuItemIds`, or on every item when omitted),
 * windows included, for a caller that decides "live" itself at the moment it
 * prices: the POS gets these with its menu (GET /api/menu) and applies
 * liveOffersByItem when it prices a cart. Never throws: a failed read (the
 * table not created yet, a network blip) is no offers.
 */
export async function loadOfferRows(admin: SupabaseClient, menuItemIds?: readonly string[]): Promise<OfferRow[]> {
  try {
    let query = admin
      .from('menu_offers')
      .select('id, name, menu_item_id, tier_prices, active, valid_from, valid_to')
      .eq('active', true);
    if (menuItemIds) query = query.in('menu_item_id', [...menuItemIds]);
    const { data, error } = await query;
    if (error) {
      // 42P01: supabase/2026-10-item-offers.sql not applied yet — no offers.
      if (error.code !== '42P01') console.error('loadOfferRows failed', error);
      return [];
    }
    return (data ?? []) as OfferRow[];
  } catch (err) {
    console.error('loadOfferRows threw', err);
    return [];
  }
}

/**
 * The spend offers live at `now` whose item is one of `menuItemIds` ("spend
 * ₹1099, get one Instant Coffee jar at ₹49"). Never throws: a failed read is no
 * spend offer, and the bill is priced without it.
 */
export async function loadActiveSpendOffers(
  admin: SupabaseClient,
  menuItemIds: readonly string[],
  now: Date = new Date(),
): Promise<SpendOffer[]> {
  if (menuItemIds.length === 0) return [];
  return liveSpendOffers(await loadSpendOfferRows(admin, menuItemIds), now);
}

/** The switched-on spend offer rows (on `menuItemIds`, or every item when omitted). Never throws. */
export async function loadSpendOfferRows(admin: SupabaseClient, menuItemIds?: readonly string[]): Promise<SpendOfferRow[]> {
  try {
    let query = admin
      .from('spend_offers')
      .select('id, name, menu_item_id, min_spend_inr, price_inr, active, valid_from, valid_to')
      .eq('active', true);
    if (menuItemIds) query = query.in('menu_item_id', [...menuItemIds]);
    const { data, error } = await query;
    if (error) {
      // 42P01: supabase/2026-11-spend-offers.sql not applied yet — no spend offers.
      if (error.code !== '42P01') console.error('loadSpendOfferRows failed', error);
      return [];
    }
    return (data ?? []) as SpendOfferRow[];
  } catch (err) {
    console.error('loadSpendOfferRows threw', err);
    return [];
  }
}
