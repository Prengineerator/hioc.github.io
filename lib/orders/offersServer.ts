// The live multi-buy offers for the items on an order (lib/orders/offers.ts,
// supabase/2026-10-item-offers.sql). Order create, the quote and the running-tab
// add load them once and hand them to resolveOrderLines, which snapshots the
// offer onto each line it applies to.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isOfferLive, normalizeOfferPrices, type ActiveOffer, type MenuOffer } from '@/lib/orders/offers';

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
  const byItem = new Map<string, ActiveOffer>();
  if (menuItemIds.length === 0) return byItem;
  try {
    const { data, error } = await admin
      .from('menu_offers')
      .select('id, name, menu_item_id, tier_prices, active, valid_from, valid_to')
      .eq('active', true)
      .in('menu_item_id', [...menuItemIds]);
    if (error) {
      // 42P01: supabase/2026-10-item-offers.sql not applied yet — no offers.
      if (error.code !== '42P01') console.error('loadActiveOffers failed', error);
      return byItem;
    }
    for (const row of (data ?? []) as Partial<MenuOffer>[]) {
      const prices = normalizeOfferPrices(row.tier_prices);
      if (
        typeof row.id !== 'string' ||
        typeof row.menu_item_id !== 'string' ||
        typeof row.name !== 'string' ||
        !prices ||
        !isOfferLive({
          active: row.active === true,
          valid_from: row.valid_from ?? null,
          valid_to: row.valid_to ?? null,
          tier_prices: prices,
        }, now)
      ) {
        continue;
      }
      // One live offer per item (a unique index); should two ever be live, the
      // first read wins rather than stacking.
      if (!byItem.has(row.menu_item_id)) {
        byItem.set(row.menu_item_id, { id: row.id, name: row.name.trim(), tier_prices: prices });
      }
    }
  } catch (err) {
    console.error('loadActiveOffers threw', err);
  }
  return byItem;
}
