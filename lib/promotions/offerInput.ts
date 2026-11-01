// Validation for a multi-buy offer the owner creates or edits in Promotions →
// Offers (app/api/offers). Pure. The rules the bill applies live in
// lib/orders/offers.ts; this only decides what may be stored.

import { isUuid } from '@/lib/api/constants';
import { MAX_OFFER_NAME_LENGTH, MAX_OFFER_TIERS, normalizeOfferPrices } from '@/lib/orders/offers';

/** The writable columns of menu_offers. */
export interface OfferInput {
  name: string;
  menu_item_id: string;
  tier_prices: number[];
  active: boolean;
  valid_from: string | null;
  valid_to: string | null;
}

function parseInstant(value: unknown, field: string): { ok: string | null } | { error: string } {
  if (value === undefined || value === null || value === '') return { ok: null };
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return { error: `${field} must be a date and time, or empty` };
  }
  return { ok: new Date(value).toISOString() };
}

/**
 * The body checked. `partial` (an edit) takes only the fields present; a create
 * needs name, menu_item_id and tier_prices. Returns the fields, or one
 * human-readable error.
 */
export function parseOfferInput(
  body: Record<string, unknown>,
  { partial }: { partial: boolean },
): Partial<OfferInput> | string {
  const out: Partial<OfferInput> = {};

  if (!partial || 'name' in body) {
    if (typeof body.name !== 'string' || body.name.trim() === '') return 'Give the offer a name, e.g. "Instant Coffee offer"';
    const name = body.name.trim();
    if (name.length > MAX_OFFER_NAME_LENGTH) return `The name can be at most ${MAX_OFFER_NAME_LENGTH} characters`;
    out.name = name;
  }

  if (!partial || 'menu_item_id' in body) {
    if (!isUuid(body.menu_item_id)) return 'Choose the menu item the offer is on';
    out.menu_item_id = body.menu_item_id;
  }

  if (!partial || 'tier_prices' in body) {
    const prices = normalizeOfferPrices(body.tier_prices);
    if (!prices) {
      return `Offer prices must be 1 to ${MAX_OFFER_TIERS} whole rupee amounts above ₹0, and buying more can never cost less (e.g. 299, 499, 599)`;
    }
    out.tier_prices = prices;
  }

  if ('active' in body) {
    if (typeof body.active !== 'boolean') return 'active must be true or false';
    out.active = body.active;
  } else if (!partial) {
    out.active = true;
  }

  for (const field of ['valid_from', 'valid_to'] as const) {
    if (!partial || field in body) {
      const parsed = parseInstant(body[field], field === 'valid_from' ? 'Starts' : 'Ends');
      if ('error' in parsed) return parsed.error;
      out[field] = parsed.ok;
    }
  }
  if (out.valid_from && out.valid_to && Date.parse(out.valid_to) <= Date.parse(out.valid_from)) {
    return 'The offer must end after it starts';
  }

  return out;
}

/** The writable columns of spend_offers. */
export interface SpendOfferInput {
  name: string;
  menu_item_id: string;
  min_spend_inr: number;
  price_inr: number;
  active: boolean;
  valid_from: string | null;
  valid_to: string | null;
}

function wholeRupees(value: unknown, { min }: { min: number }): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 1_000_000 ? value : null;
}

/**
 * A spend offer ("spend ₹1099, get one Instant Coffee jar at ₹49") checked.
 * `partial` (an edit) takes only the fields present; a create needs name,
 * menu_item_id, min_spend_inr and price_inr. Returns the fields, or one error.
 */
export function parseSpendOfferInput(
  body: Record<string, unknown>,
  { partial }: { partial: boolean },
): Partial<SpendOfferInput> | string {
  const out: Partial<SpendOfferInput> = {};

  if (!partial || 'name' in body) {
    if (typeof body.name !== 'string' || body.name.trim() === '') return 'Give the offer a name, e.g. "Instant Coffee at ₹49"';
    const name = body.name.trim();
    if (name.length > MAX_OFFER_NAME_LENGTH) return `The name can be at most ${MAX_OFFER_NAME_LENGTH} characters`;
    out.name = name;
  }
  if (!partial || 'menu_item_id' in body) {
    if (!isUuid(body.menu_item_id)) return 'Choose the item one of which comes at the offer price';
    out.menu_item_id = body.menu_item_id;
  }
  if (!partial || 'min_spend_inr' in body) {
    const min = wholeRupees(body.min_spend_inr, { min: 1 });
    if (min === null) return 'The minimum spend must be a whole rupee amount above ₹0';
    out.min_spend_inr = min;
  }
  if (!partial || 'price_inr' in body) {
    const price = wholeRupees(body.price_inr, { min: 0 });
    if (price === null) return 'The offer price must be a whole rupee amount (₹0 or more)';
    out.price_inr = price;
  }
  if ('active' in body) {
    if (typeof body.active !== 'boolean') return 'active must be true or false';
    out.active = body.active;
  } else if (!partial) {
    out.active = true;
  }
  for (const field of ['valid_from', 'valid_to'] as const) {
    if (!partial || field in body) {
      const parsed = parseInstant(body[field], field === 'valid_from' ? 'Starts' : 'Ends');
      if ('error' in parsed) return parsed.error;
      out[field] = parsed.ok;
    }
  }
  if (out.valid_from && out.valid_to && Date.parse(out.valid_to) <= Date.parse(out.valid_from)) {
    return 'The offer must end after it starts';
  }
  return out;
}
