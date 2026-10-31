// Shared by app/api/offers and app/api/offers/[id]: the row shape the owner's
// Offers list reads, and the database errors an offer write can meet.

import { errorResponse } from '@/lib/api/http';
import type { MenuOffer } from '@/lib/orders/offers';

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
