// Multi-buy offers: "Instant Coffee — 1 for ₹299, 2 for ₹499, 3 for ₹599"
// (supabase/2026-10-item-offers.sql).
//
// An offer is its own record (menu_offers), created by the owner in
// Promotions → Offers — the menu item itself is never changed. The item keeps
// its regular price on the menu and on every order line (₹399 a jar), and the
// offer comes off the bill as its own discount row, so the customer sees what
// they saved:
//
//   2 × Instant Coffee        ₹798
//   Instant Coffee offer     −₹299
//
// An offer names one menu item and lists what 1, 2, 3 … units cost together
// (tier_prices). Any mix of the item's sizes counts (a Classic and a Hazelnut
// are 2 jars). Beyond the last tier the units go in full groups of the biggest
// tier, then the tier for what is left: with [299, 499, 599], 4 jars are
// 599 + 299 and 5 are 599 + 499. Add-ons are never part of the offer: a unit
// counts at its size's price (`offer_unit_inr`) and its add-ons are charged in
// full on top.
//
// Every order line an offer applies to carries a snapshot of it
// (order_items.offer_id / offer_name / offer_prices / offer_unit_inr), so the
// discount is worked out again from the lines that remain whenever a line is
// voided, reduced or added (lib/orders/amend.ts), with the offer as it was when
// that line was sold — switching an offer off never changes an open bill.
//
// The discount is stored inside orders.discount_inr (which is "everything
// taken off before GST", so totals, GST and every report keep their formulas)
// and, separately, as orders.offer_discount_inr, which says how much of it is
// the offer: the bill shows the offer row and the coupon / Beanies row apart.
//
// Pure: the server prices with it and the screens label with it, so the two
// can't disagree. Loading the live offers is lib/orders/offersServer.ts.

/** An offer as stored (menu_offers). */
export interface MenuOffer {
  id: string;
  name: string;
  menu_item_id: string;
  tier_prices: number[];
  active: boolean;
  /** Optional window; null = no limit on that side. */
  valid_from: string | null;
  valid_to: string | null;
  created_at?: string;
  updated_at?: string;
}

/** What an order line needs from the offer on its item. */
export interface ActiveOffer {
  id: string;
  name: string;
  tier_prices: number[];
}

/** The longest name an offer may have (it is printed on the bill). */
export const MAX_OFFER_NAME_LENGTH = 60;

/** The most tiers an offer may have (a bound, far beyond any real offer). */
export const MAX_OFFER_TIERS = 10;

/**
 * An offer's tier prices, checked: 1–10 whole rupee prices above zero, never
 * less for more units. Anything else means no offer, so a mistyped offer can't
 * charge less for a bigger order than a smaller one, or price anything at ₹0.
 */
export function normalizeOfferPrices(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OFFER_TIERS) return null;
  for (let i = 0; i < value.length; i++) {
    const price = value[i];
    if (typeof price !== 'number' || !Number.isInteger(price) || price <= 0) return null;
    if (i > 0 && price < (value[i - 1] as number)) return null;
  }
  return [...value] as number[];
}

/**
 * Whether an offer applies at `now`: switched on, and inside its window (a
 * window edge left empty is no limit), with prices that pass the checks.
 */
export function isOfferLive(
  offer: Pick<MenuOffer, 'active' | 'valid_from' | 'valid_to' | 'tier_prices'>,
  now: Date = new Date(),
): boolean {
  if (!offer.active || normalizeOfferPrices(offer.tier_prices) === null) return false;
  const t = now.getTime();
  if (offer.valid_from && t < Date.parse(offer.valid_from)) return false;
  if (offer.valid_to && t >= Date.parse(offer.valid_to)) return false;
  return true;
}

/** "1 for ₹299 · 2 for ₹499 · 3 for ₹599" — how an offer reads in the owner's list. */
export function describeTiers(prices: readonly number[]): string {
  return prices.map((p, i) => `${i + 1} for ₹${p}`).join(' · ');
}

/** What `units` cost under the offer: full groups of the biggest tier, then the tier for the rest. */
export function offerPriceFor(prices: readonly number[], units: number): number {
  if (prices.length === 0 || !Number.isInteger(units) || units <= 0) return 0;
  const size = prices.length;
  const groups = Math.floor(units / size);
  const rest = units % size;
  return groups * prices[size - 1] + (rest > 0 ? prices[rest - 1] : 0);
}

/** The parts of an order line an offer reads. A line with no offer snapshot is ignored. */
export interface OfferLine {
  /** Null on a stored line whose menu item has since been deleted (it keeps its snapshot). */
  menu_item_id: string | null;
  name_snapshot: string;
  quantity: number;
  voided?: boolean;
  offer_prices?: readonly number[] | null;
  /** The price of one unit before add-ons, when the line was sold. */
  offer_unit_inr?: number | null;
  /** The offer's name when the line was sold ("Instant Coffee offer"). */
  offer_name?: string | null;
}

/** One offer on a bill: which item, how many units, and what came off. */
export interface AppliedOffer {
  menu_item_id: string;
  name: string;
  units: number;
  /** The units at their regular price. */
  regular_inr: number;
  /** What the units cost under the offer. */
  offer_inr: number;
  discount_inr: number;
}

export interface OfferResult {
  /** Σ discount_inr over `offers`. */
  discountInr: number;
  offers: AppliedOffer[];
}

/**
 * The offers a set of order lines earns. Lines of one item with the same offer
 * count together, whatever their size; a voided line counts for nothing.
 */
export function computeOffers(lines: readonly OfferLine[]): OfferResult {
  const groups = new Map<string, { prices: number[]; offer: AppliedOffer }>();
  for (const line of lines) {
    if (line.voided) continue;
    const prices = normalizeOfferPrices(line.offer_prices);
    const unit = line.offer_unit_inr;
    if (!prices || typeof unit !== 'number' || !Number.isInteger(unit) || unit < 0) continue;
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) continue;
    const key = `${line.menu_item_id}|${prices.join(',')}`;
    const group = groups.get(key) ?? {
      prices,
      offer: {
        menu_item_id: line.menu_item_id ?? '',
        name: offerNameOf(line),
        units: 0,
        regular_inr: 0,
        offer_inr: 0,
        discount_inr: 0,
      },
    };
    group.offer.units += line.quantity;
    group.offer.regular_inr += unit * line.quantity;
    groups.set(key, group);
  }

  const offers: AppliedOffer[] = [];
  for (const { prices, offer } of groups.values()) {
    offer.offer_inr = offerPriceFor(prices, offer.units);
    // Never more than the units' own price: an offer can't push a bill below
    // what it would have been without it.
    offer.discount_inr = Math.max(0, offer.regular_inr - offer.offer_inr);
    if (offer.discount_inr > 0) offers.push(offer);
  }
  return { discountInr: offers.reduce((sum, o) => sum + o.discount_inr, 0), offers };
}

/** A line's offer name: the snapshot, or "<item> offer" for a line without one. */
function offerNameOf(line: Pick<OfferLine, 'name_snapshot' | 'offer_name'>): string {
  const name = (line.offer_name ?? '').trim();
  return name !== '' ? name : `${line.name_snapshot} offer`;
}

/** The bill row's label: the offer's name, or "Offers" when the bill has several. */
export function offerLabel(names: readonly string[]): string {
  const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))];
  if (unique.length === 1) return unique[0];
  return unique.length > 1 ? 'Offers' : 'Offer';
}

/** offerLabel for a stored order: the offers its lines were sold under. */
export function offerLabelForLines(
  lines: readonly Pick<OfferLine, 'name_snapshot' | 'voided' | 'offer_prices' | 'offer_name'>[],
): string {
  return offerLabel(
    lines.filter((l) => !l.voided && normalizeOfferPrices(l.offer_prices) !== null).map(offerNameOf),
  );
}

/**
 * How a stored order's discount_inr splits into the offer and the rest (coupon
 * + Beanies). An order from before the offers migration has no offer part.
 */
export function splitOrderDiscount(order: { discount_inr: number; offer_discount_inr?: number | null }): {
  offerInr: number;
  otherInr: number;
} {
  const total = Math.max(0, order.discount_inr ?? 0);
  const offerInr = Math.min(Math.max(0, order.offer_discount_inr ?? 0), total);
  return { offerInr, otherInr: total - offerInr };
}

/** One discount row on a bill: a label and the rupees it takes off (positive). */
export interface DiscountRow {
  label: string;
  amountInr: number;
}

/**
 * The discount rows a bill shows, in order: the offer (e.g. "Instant Coffee
 * offer"), then the rest of discount_inr (coupon + Beanies) under `otherLabel`.
 * A bill without an offer gets the one row it always had.
 */
export function discountRows(
  bill: { discount_inr: number; offer_discount_inr?: number | null },
  offerLabelText: string,
  otherLabel = 'Discount',
): DiscountRow[] {
  const { offerInr, otherInr } = splitOrderDiscount(bill);
  const rows: DiscountRow[] = [];
  if (offerInr > 0) rows.push({ label: offerLabelText, amountInr: offerInr });
  if (otherInr > 0) rows.push({ label: otherLabel, amountInr: otherInr });
  return rows;
}
