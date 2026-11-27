// The live multi-buy offers for the items on an order (lib/orders/offers.ts,
// supabase/2026-10-item-offers.sql). Order create, the quote and the running-tab
// add load them once and hand them to resolveOrderLines, which snapshots the
// offer onto each line it applies to.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  liveOffersByItem,
  liveSpendOffers,
  spendOfferBlocks,
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

/**
 * The spend offers (of `offerIds`) this phone number has had: a redemption on
 * an order that wasn't cancelled or rejected (supabase/2026-11-spend-offers.sql,
 * once per customer). `exceptOrderId` leaves out the order being corrected.
 *
 * A failed read answers "had them all": the offer is then withheld rather than
 * given twice, and the bill is the regular one.
 */
export async function loadUsedSpendOffers(
  admin: SupabaseClient,
  offerIds: readonly string[],
  phone: string,
  exceptOrderId?: string,
): Promise<Set<string>> {
  if (offerIds.length === 0) return new Set();
  try {
    const { data, error } = await admin
      .from('spend_offer_redemptions')
      .select('spend_offer_id, order_id, orders(status)')
      .eq('phone', phone)
      .in('spend_offer_id', [...offerIds]);
    if (error) {
      console.error('loadUsedSpendOffers failed', error);
      return new Set(offerIds);
    }
    const used = new Set<string>();
    for (const row of (data ?? []) as {
      spend_offer_id: string;
      order_id: string;
      orders: { status: string } | { status: string }[] | null;
    }[]) {
      if (row.order_id === exceptOrderId) continue;
      const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
      if (order && (order.status === 'cancelled' || order.status === 'rejected')) continue;
      used.add(row.spend_offer_id);
    }
    return used;
  } catch (err) {
    console.error('loadUsedSpendOffers threw', err);
    return new Set(offerIds);
  }
}

/** What this customer can't have of `offers` (no number, or had it already), for billOffers. */
export async function loadSpendOfferBlocks(
  admin: SupabaseClient,
  offers: readonly SpendOffer[],
  phone: string | null,
  exceptOrderId?: string,
): Promise<Map<string, string>> {
  if (offers.length === 0) return new Map();
  const used = phone ? await loadUsedSpendOffers(admin, offers.map((o) => o.id), phone, exceptOrderId) : new Set<string>();
  return spendOfferBlocks(offers, phone, used);
}

/**
 * Records that `phone` had the spend offer on `orderId`. Never throws: the
 * order is already placed, so a failed write is logged, not refused.
 */
export async function recordSpendRedemption(
  admin: SupabaseClient,
  input: { offerId: string; phone: string; orderId: string },
): Promise<void> {
  try {
    const { error } = await admin
      .from('spend_offer_redemptions')
      .insert({ spend_offer_id: input.offerId, phone: input.phone, order_id: input.orderId });
    if (error) console.error('recordSpendRedemption failed', error);
  } catch (err) {
    console.error('recordSpendRedemption threw', err);
  }
}

/** Removes the order's spend offer record (a correction took the offer off the bill). Never throws. */
export async function releaseSpendRedemption(admin: SupabaseClient, orderId: string): Promise<void> {
  try {
    const { error } = await admin.from('spend_offer_redemptions').delete().eq('order_id', orderId);
    if (error) console.error('releaseSpendRedemption failed', error);
  } catch (err) {
    console.error('releaseSpendRedemption threw', err);
  }
}
