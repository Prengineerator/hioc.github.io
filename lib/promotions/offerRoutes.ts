// Shared by app/api/offers, app/api/spend-offers and their [id] routes: the row
// shapes the owner's Offers list reads, and the database errors a write can meet.

import { errorResponse } from '@/lib/api/http';
import type { MenuOffer, StoredSpendOffer } from '@/lib/orders/offers';

/** An offer with its item's name (the menu_items embed). */
export const OFFER_SELECT = '*, menu_items(name)';

export type OfferRow = MenuOffer & { menu_items: { name: string } | null };

/** An offer as the Offers list shows it. */
export type OwnerOffer = MenuOffer & { item_name: string };

export function toOwnerOffer(row: OfferRow): OwnerOffer {
  const { menu_items, ...offer } = row;
  return { ...offer, item_name: menu_items?.name ?? 'Deleted item' };
}

export const OFFERS_MIGRATION_HINT =
  'Offers need a database update first: apply supabase/2026-10-item-offers.sql in the Supabase SQL editor.';

/** The response for a failed offers read or write. */
export function offerWriteError(error: { code?: string } | null, fallback: string) {
  if (error?.code === '42P01') return errorResponse(409, OFFERS_MIGRATION_HINT);
  if (error?.code === '23505') {
    return errorResponse(409, 'This item already has an offer switched on. Switch that one off first.');
  }
  if (error?.code === '23503') return errorResponse(400, 'That menu item no longer exists');
  if (error?.code === '23514') return errorResponse(400, 'Those offer prices are not allowed');
  console.error('menu_offers write failed', error);
  return errorResponse(500, fallback);
}

// ---------------------------------------------------------------------------
// Spend offers (app/api/spend-offers): "spend ₹1099, get one Instant Coffee jar at ₹49"
// ---------------------------------------------------------------------------

export const SPEND_OFFER_SELECT = '*, menu_items(name)';

export type SpendOfferDbRow = StoredSpendOffer & { menu_items: { name: string } | null };

/** A spend offer as the Offers list shows it. */
export type OwnerSpendOffer = StoredSpendOffer & { item_name: string };

export function toOwnerSpendOffer(row: SpendOfferDbRow): OwnerSpendOffer {
  const { menu_items, ...offer } = row;
  return { ...offer, item_name: menu_items?.name ?? 'Deleted item' };
}

export const SPEND_OFFERS_MIGRATION_HINT =
  'Spend offers need a database update first: apply supabase/2026-11-spend-offers.sql in the Supabase SQL editor.';

/** The response for a failed spend offers read or write. */
export function spendOfferWriteError(error: { code?: string } | null, fallback: string) {
  if (error?.code === '42P01') return errorResponse(409, SPEND_OFFERS_MIGRATION_HINT);
  if (error?.code === '23505') {
    return errorResponse(409, 'This item already has a spend offer switched on. Switch that one off first.');
  }
  if (error?.code === '23503') return errorResponse(400, 'That menu item no longer exists');
  if (error?.code === '23514') return errorResponse(400, 'Those amounts are not allowed');
  console.error('spend_offers write failed', error);
  return errorResponse(500, fallback);
}
