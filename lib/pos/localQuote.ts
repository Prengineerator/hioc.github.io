// Pricing a cart on the POS's own screen — no request per tap.
//
// The New order screen used to ask POST /api/orders/quote for the bill after
// every tap (a 250 ms debounce), so a five-item order cost five to seven
// server calls before it was even placed, each one several database round
// trips. For an ordinary cart — no coupon, no Beanies, no Ritual cups — every
// input to the bill is already on the screen: the menu, the live multi-buy
// offers and the store's GST and packaging settings (GET /api/menu?pos=true
// brings the last two with the menu). So the screen prices it here, with the
// SAME functions the server prices it with:
//
//   resolveOrderLines   lib/orders/lines.ts       (line prices, availability, add-on rules)
//   liveOffersByItem    lib/orders/offers.ts      (which multi-buy offers are live right now)
//   liveSpendOffers     lib/orders/offers.ts      (which spend offers are live right now)
//   billOffers          lib/orders/offers.ts      (the offers the bill gets)
//   composeOrderBill    lib/orders/billPricing.ts (GST, packaging, the total)
//
// in the same order POST /api/orders/quote calls them. Nothing here is a copy
// of a money rule; it is the server's code, run in the browser.
//
// The server stays the authority. The screen sends the total it showed with
// the order (expected_total_inr); if the server's own total differs — a price
// changed since the menu was loaded, an offer just ended — it refuses before
// anything is created or charged, and hands back its bill (POST /api/orders,
// 'total_changed'). Coupons, Beanies and Ritual cups depend on the customer's
// account and are still quoted by the server.

import { switchesFromSettings } from '@/lib/menu/menuSwitches';
import { resolveOrderLines, type IncomingOrderItem } from '@/lib/orders/lines';
import {
  billOffers,
  liveOffersByItem,
  liveSpendOffers,
  type AppliedOffer,
  type OfferRow,
  type SpendOfferRow,
} from '@/lib/orders/offers';
import { composeOrderBill } from '@/lib/orders/billPricing';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { MenuItem, StoreSettings } from '@/lib/types';

/** The store settings a bill depends on (GST, packaging) and the menu switches. */
export type PosPricingSettings = Pick<
  StoreSettings,
  'gst_percent' | 'gst_inclusive' | 'packaging_charge_inr' | 'hidden_categories' | 'hidden_variant_labels'
>;

/** What the POS needs, beside the menu, to price a cart itself. */
export interface PosPricingContext {
  settings: PosPricingSettings;
  /** Switched-on offer rows, windows included: "live" is decided when pricing. */
  offers: OfferRow[];
  /** Switched-on spend offer rows, likewise. Absent from an older menu answer = none. */
  spendOffers?: SpendOfferRow[];
}

export type LocalQuote =
  | { ok: true; bill: ReturnType<typeof composeOrderBill>; offers: AppliedOffer[]; offerLabel: string }
  | { ok: false; error: string; needsServer?: boolean };

/** The pricing settings out of a full settings row (GET /api/menu?pos=true). */
export function pricingSettingsOf(settings: StoreSettings): PosPricingSettings {
  return {
    gst_percent: settings.gst_percent,
    gst_inclusive: settings.gst_inclusive,
    packaging_charge_inr: settings.packaging_charge_inr,
    hidden_categories: settings.hidden_categories ?? [],
    hidden_variant_labels: settings.hidden_variant_labels ?? [],
  };
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Shape check for a pricing context from the network or storage; null when unusable. */
export function parsePosPricing(v: unknown): PosPricingContext | null {
  if (!v || typeof v !== 'object') return null;
  const { settings, offers, spend_offers: spendOffers } = v as {
    settings?: unknown;
    offers?: unknown;
    spend_offers?: unknown;
  };
  if (!settings || typeof settings !== 'object' || !Array.isArray(offers)) return null;
  const s = settings as Record<string, unknown>;
  if (
    typeof s.gst_percent !== 'number' ||
    !Number.isFinite(s.gst_percent) ||
    typeof s.gst_inclusive !== 'boolean' ||
    typeof s.packaging_charge_inr !== 'number' ||
    !Number.isFinite(s.packaging_charge_inr)
  ) {
    return null;
  }
  return {
    settings: {
      gst_percent: s.gst_percent,
      gst_inclusive: s.gst_inclusive,
      packaging_charge_inr: s.packaging_charge_inr,
      hidden_categories: isStringList(s.hidden_categories) ? s.hidden_categories : [],
      hidden_variant_labels: isStringList(s.hidden_variant_labels) ? s.hidden_variant_labels : [],
    },
    // liveOffersByItem / liveSpendOffers skip anything malformed, so rows pass through as they are.
    offers: offers.filter((o): o is OfferRow => o !== null && typeof o === 'object'),
    spendOffers: Array.isArray(spendOffers)
      ? spendOffers.filter((o): o is SpendOfferRow => o !== null && typeof o === 'object')
      : [],
  };
}

/**
 * The bill for `items`, priced here exactly as POST /api/orders/quote prices a
 * cart with no coupon, Beanies or Ritual cups. `{ ok: false }` carries the same
 * message the server would give (an item 86'd, a size switched off).
 */
export function quoteLocally(input: {
  items: IncomingOrderItem[];
  menuItems: readonly MenuItem[];
  pricing: PosPricingContext;
  isDineIn: boolean;
  now?: Date;
}): LocalQuote {
  const now = input.now ?? new Date();
  // Only what the bill reads comes from the context; the rest of the row is a
  // documented default no bill depends on.
  const settings: StoreSettings = { ...FALLBACK_STORE_SETTINGS, ...input.pricing.settings };
  const menuById = new Map(input.menuItems.map((m) => [m.id, m]));
  const spendOffers = liveSpendOffers(input.pricing.spendOffers ?? [], now);
  const resolved = resolveOrderLines(
    input.items,
    menuById,
    switchesFromSettings(settings),
    liveOffersByItem(input.pricing.offers, now),
    new Set(spendOffers.map((o) => o.menu_item_id)),
  );
  if (!resolved.ok) return { ok: false, error: resolved.error };
  // No coupon or Beanies here (those carts go to the server), so a spend offer may apply.
  const priced = billOffers({ lines: resolved.lines, spendOffers, otherDiscountApplied: false });
  // A spend offer is once per customer: whether THIS customer can have it is
  // the server's to say (it holds who has had it), so a cart that qualifies is
  // priced there. A cart that doesn't qualify prices here exactly as before.
  if (priced.kind === 'spend') return { ok: false, error: '', needsServer: true };
  const offers = priced.offers;
  const offerDiscountInr = priced.discountInr;
  const bill = composeOrderBill({
    settings,
    subtotalInr: resolved.subtotalInr,
    taxableSubtotalInr: resolved.taxableSubtotalInr,
    offerDiscountInr,
    couponDiscountInr: 0,
    pointsDiscountInr: 0,
    passCoveredInr: 0,
    passCoveredTaxableInr: 0,
    isDineIn: input.isDineIn,
  });
  return { ok: true, bill, offers, offerLabel: priced.label };
}

/**
 * Whether this cart needs the server to price it: anything that depends on the
 * customer's account (a coupon, Beanies, Ritual cups or a pass to preview),
 * a missing pricing context (an older menu answer), or the server having
 * just corrected this screen's total.
 */
export function needsServerQuote(input: {
  hasPricing: boolean;
  couponCode: string;
  redeemPoints: number;
  passCups: number;
  /** The customer holds Ritual cups: the stepper needs the server's pass preview. */
  ritualAvailable: boolean;
  /** The server corrected a total on this order: stay with its pricing until the order is done. */
  serverPricingPinned: boolean;
}): boolean {
  return (
    !input.hasPricing ||
    input.serverPricingPinned ||
    input.couponCode !== '' ||
    input.redeemPoints > 0 ||
    input.passCups > 0 ||
    input.ritualAvailable
  );
}
