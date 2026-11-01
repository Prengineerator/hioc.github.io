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
// Spend offers (supabase/2026-11-spend-offers.sql) are the second kind: "spend
// ₹1099, get one Instant Coffee jar at ₹49". One unit of the item drops to the
// offer price when everything ELSE on the bill reaches the minimum (before GST
// and packaging, not counting what Ritual cups pay for). Once per customer, by
// phone number (spend_offer_redemptions; no number, no offer), and the bill
// earns no Beanies (lib/loyalty/ledger.ts earnForOrder). It can't be combined:
// with a coupon or Beanies on the bill it stays off (and says so), and against
// the multi-buy offers the bill takes whichever saves more, never both. The
// live spend offers whose item is on a bill are kept on the order
// (orders.spend_offers), so a correction re-checks the minimum against the
// offer as it was sold. billOffers is the one rule for both kinds.
//
// Pure: the server prices with it and the screens label with it, so the two
// can't disagree. Loading the live offers is lib/orders/offersServer.ts.

import { LOYALTY_UNIT } from '@/lib/loyalty/brand';

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
  if (normalizeOfferPrices(offer.tier_prices) === null) return false;
  return isWindowLive(offer, now);
}

/** Switched on, and inside the window (an empty edge is no limit). Either kind of offer. */
export function isWindowLive(
  offer: { active: boolean; valid_from: string | null; valid_to: string | null },
  now: Date = new Date(),
): boolean {
  if (!offer.active) return false;
  const t = now.getTime();
  if (offer.valid_from && t < Date.parse(offer.valid_from)) return false;
  if (offer.valid_to && t >= Date.parse(offer.valid_to)) return false;
  return true;
}

/** What a stored offer row needs for "is it live, and on what". */
export type OfferRow = Pick<MenuOffer, 'id' | 'name' | 'menu_item_id' | 'tier_prices' | 'active' | 'valid_from' | 'valid_to'>;

/**
 * The offers live at `now`, keyed by menu item — the ONE rule for it. The
 * server applies it to the rows it reads (offersServer.ts loadActiveOffers);
 * the POS applies it to the rows that came with its menu, at the moment it
 * prices a cart (lib/pos/localQuote.ts), so an offer that starts or ends
 * during the shift is honoured the same way on both sides.
 *
 * Malformed rows are skipped (never an offer), and one offer per item: should
 * two ever be live, the first wins rather than stacking.
 */
export function liveOffersByItem(rows: readonly Partial<OfferRow>[], now: Date = new Date()): Map<string, ActiveOffer> {
  const byItem = new Map<string, ActiveOffer>();
  for (const row of rows) {
    const prices = normalizeOfferPrices(row.tier_prices);
    if (
      typeof row.id !== 'string' ||
      typeof row.menu_item_id !== 'string' ||
      typeof row.name !== 'string' ||
      !prices ||
      !isOfferLive(
        { active: row.active === true, valid_from: row.valid_from ?? null, valid_to: row.valid_to ?? null, tier_prices: prices },
        now,
      )
    ) {
      continue;
    }
    if (!byItem.has(row.menu_item_id)) {
      byItem.set(row.menu_item_id, { id: row.id, name: row.name.trim(), tier_prices: prices });
    }
  }
  return byItem;
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
  /** The spend offer's id (spend offers only): what its once-per-customer record points at. */
  offer_id?: string;
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

// ---------------------------------------------------------------------------
// Spend offers: "spend ₹1099, get one Instant Coffee jar at ₹49"
// ---------------------------------------------------------------------------

/** A spend offer as stored (spend_offers). */
export interface StoredSpendOffer {
  id: string;
  name: string;
  /** The item one unit of which drops to price_inr. */
  menu_item_id: string;
  /** What everything else on the bill must reach, before GST and packaging. */
  min_spend_inr: number;
  price_inr: number;
  active: boolean;
  valid_from: string | null;
  valid_to: string | null;
  created_at?: string;
  updated_at?: string;
}

/** What a bill needs of a spend offer (also the orders.spend_offers snapshot). */
export interface SpendOffer {
  id: string;
  name: string;
  menu_item_id: string;
  min_spend_inr: number;
  price_inr: number;
}

export type SpendOfferRow = Pick<
  StoredSpendOffer,
  'id' | 'name' | 'menu_item_id' | 'min_spend_inr' | 'price_inr' | 'active' | 'valid_from' | 'valid_to'
>;

/** A spend offer's terms checked; null when unusable (never an offer). */
export function normalizeSpendOffer(row: unknown): SpendOffer | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.menu_item_id !== 'string' || typeof r.name !== 'string') return null;
  const min = r.min_spend_inr;
  const price = r.price_inr;
  if (typeof min !== 'number' || !Number.isInteger(min) || min <= 0) return null;
  if (typeof price !== 'number' || !Number.isInteger(price) || price < 0) return null;
  const name = r.name.trim();
  if (name === '') return null;
  return { id: r.id, name, menu_item_id: r.menu_item_id, min_spend_inr: min, price_inr: price };
}

/** The spend offers live at `now` — the ONE rule, for the server and the POS alike. */
export function liveSpendOffers(rows: readonly Partial<SpendOfferRow>[], now: Date = new Date()): SpendOffer[] {
  const live: SpendOffer[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const offer = normalizeSpendOffer(row);
    if (
      !offer ||
      seen.has(offer.menu_item_id) ||
      !isWindowLive({ active: row.active === true, valid_from: row.valid_from ?? null, valid_to: row.valid_to ?? null }, now)
    ) {
      continue;
    }
    seen.add(offer.menu_item_id);
    live.push(offer);
  }
  return live;
}

/** orders.spend_offers read back: the usable snapshots, anything else dropped. */
export function parseSpendSnapshot(value: unknown): SpendOffer[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeSpendOffer).filter((o): o is SpendOffer => o !== null);
}

/** The snapshot to keep on an order: `current`, plus any of `live` on an item the bill has, by id. */
export function mergeSpendSnapshot(
  current: readonly SpendOffer[],
  live: readonly SpendOffer[],
  itemIdsOnBill: Iterable<string>,
): SpendOffer[] {
  const onBill = new Set(itemIdsOnBill);
  const merged = [...current];
  for (const offer of live) {
    if (onBill.has(offer.menu_item_id) && !merged.some((o) => o.id === offer.id)) merged.push(offer);
  }
  return merged;
}

/** "Spend ₹1099 → one for ₹49" — how a spend offer reads in the owner's list. */
export function describeSpendOffer(offer: Pick<SpendOffer, 'min_spend_inr' | 'price_inr'>): string {
  return `Spend ₹${offer.min_spend_inr} → one for ₹${offer.price_inr}`;
}

/** A bill line as billOffers reads it. */
export interface BillOfferLine extends OfferLine {
  line_total_inr: number;
  /** One unit's price, add-ons included. */
  price_inr_snapshot?: number;
}

export interface BillOffersInput {
  lines: readonly BillOfferLine[];
  /** The spend offers to consider (live ones, or an order's snapshot). */
  spendOffers?: readonly SpendOffer[];
  /** What Ritual cups pay for on the bill: not spent today, so it doesn't count toward a minimum. */
  passCoveredInr?: number;
  /** A coupon or Beanies discount is on the bill: a spend offer can't be combined with it. */
  otherDiscountApplied?: boolean;
  /**
   * Spend offers this customer can't have, by offer id, with the note to show
   * should the bill qualify ('' = say nothing). Once per customer: no phone on
   * the order, or the number has had it already (spendOfferBlocks).
   */
  spendBlocked?: ReadonlyMap<string, string>;
}

export interface BillOffersResult extends OfferResult {
  /** The bill row's label for `offers` ("Instant Coffee offer"), or '' when there are none. */
  label: string;
  /** For the counter screen: why an offer the bill qualified for is not on it,
   * or what the offer on it means (a spend offer earns no Beanies). */
  notes: string[];
  /** Which kind is on the bill: a spend offer, multi-buy offers, or none. */
  kind: 'spend' | 'multi_buy' | 'none';
}

/** What a spend offer would take off these lines, or null when the bill doesn't qualify. */
function spendSaving(
  offer: SpendOffer,
  live: readonly BillOfferLine[],
  liveSubtotal: number,
  passCoveredInr: number,
): AppliedOffer | null {
  let best: { unit: number; full: number } | null = null;
  for (const line of live) {
    if (line.menu_item_id !== offer.menu_item_id) continue;
    const unit = line.offer_unit_inr;
    if (typeof unit !== 'number' || !Number.isInteger(unit) || unit < 0) continue;
    if (!best || unit > best.unit) {
      best = { unit, full: Math.max(unit, line.price_inr_snapshot ?? unit) };
    }
  }
  if (!best) return null;
  // Everything else on the bill: the subtotal less this one unit (with its
  // add-ons) and less what Ritual cups pay for.
  const rest = liveSubtotal - best.full - Math.max(0, passCoveredInr);
  if (rest < offer.min_spend_inr) return null;
  const discount = best.unit - offer.price_inr;
  if (discount <= 0) return null;
  return {
    offer_id: offer.id,
    menu_item_id: offer.menu_item_id,
    name: offer.name,
    units: 1,
    regular_inr: best.unit,
    offer_inr: offer.price_inr,
    discount_inr: discount,
  };
}

/**
 * The offers a bill gets — the ONE rule for both kinds, used by order create,
 * the quote, the POS's own pricing and every correction:
 *
 *   - the multi-buy offers on the lines (computeOffers), which stack with a
 *     coupon and Beanies as they always have;
 *   - a spend offer, when everything else on the bill reaches its minimum.
 *     It can't be combined with anything: off when a coupon or Beanies is on
 *     the bill (with a note saying so), and against the multi-buy offers the
 *     bill takes whichever saves more, never both. One spend offer per bill.
 */
export function billOffers(input: BillOffersInput): BillOffersResult {
  const live = input.lines.filter((l) => !l.voided);
  const multi = computeOffers(live);
  const liveSubtotal = live.reduce((sum, l) => sum + Math.max(0, l.line_total_inr), 0);

  let bestSpend: AppliedOffer | null = null;
  const blockedNotes: string[] = [];
  for (const offer of input.spendOffers ?? []) {
    const saving = spendSaving(offer, live, liveSubtotal, input.passCoveredInr ?? 0);
    if (!saving) continue;
    const blocked = input.spendBlocked?.get(offer.id);
    if (blocked !== undefined) {
      // The bill qualifies but this customer can't have it: say why (once per customer).
      if (blocked !== '') blockedNotes.push(blocked);
      continue;
    }
    if (!bestSpend || saving.discount_inr > bestSpend.discount_inr) bestSpend = saving;
  }

  const multiResult = (notes: string[]): BillOffersResult => ({
    ...multi,
    label: multi.offers.length > 0 ? offerLabel(multi.offers.map((o) => o.name)) : '',
    notes,
    kind: multi.offers.length > 0 ? 'multi_buy' : 'none',
  });

  if (!bestSpend) return multiResult(blockedNotes);
  if (input.otherDiscountApplied) {
    return multiResult([
      `${bestSpend.name} isn't applied: it can't be combined with a coupon or ${LOYALTY_UNIT.many}.`,
    ]);
  }
  if (bestSpend.discount_inr <= multi.discountInr) return multiResult([]);
  return {
    discountInr: bestSpend.discount_inr,
    offers: [bestSpend],
    label: bestSpend.name,
    notes: [spendNoBeaniesNote(bestSpend.name)],
    kind: 'spend',
  };
}

/** The offer row's label for a stored order: the label it was billed with, else its lines' offers. */
export function orderOfferLabel(order: {
  offer_name?: string | null;
  items: readonly Pick<OfferLine, 'name_snapshot' | 'voided' | 'offer_prices' | 'offer_name'>[];
}): string {
  const stored = (order.offer_name ?? '').trim();
  return stored !== '' ? stored : offerLabelForLines(order.items);
}

// ---------------------------------------------------------------------------
// Once per customer
// ---------------------------------------------------------------------------

/** The note on a bill a spend offer is on: it earns no Beanies (earnForOrder skips it). */
export function spendNoBeaniesNote(name: string): string {
  return `${name}: no ${LOYALTY_UNIT.many} are earned on this bill.`;
}

/** The note when a bill qualifies for a spend offer but no phone number is on the order. */
export function spendNeedsPhoneNote(name: string): string {
  return `${name}: add the customer's phone number to give it (once per customer).`;
}

/** The note when the customer's number has had the spend offer already. */
export function spendAlreadyUsedNote(name: string): string {
  return `${name} isn't applied: this customer has already had it (once per customer).`;
}

/**
 * Which spend offers this customer can't have, for billOffers' spendBlocked:
 * every one when there is no phone number, else the ones `usedOfferIds` says
 * the number has had (a redemption on an order that wasn't cancelled).
 */
export function spendOfferBlocks(
  offers: readonly SpendOffer[],
  phone: string | null,
  usedOfferIds: ReadonlySet<string>,
): Map<string, string> {
  const blocked = new Map<string, string>();
  for (const offer of offers) {
    if (!phone) blocked.set(offer.id, spendNeedsPhoneNote(offer.name));
    else if (usedOfferIds.has(offer.id)) blocked.set(offer.id, spendAlreadyUsedNote(offer.name));
  }
  return blocked;
}

/**
 * Whether a stored order has a spend offer on its bill (the ₹49 jar). Such a
 * bill earns no Beanies: the offer can't be combined with them, earning
 * included. orders.offer_name is only ever set for a spend offer.
 */
export function spendOfferOnBill(order: { offer_name?: string | null; offer_discount_inr?: number | null }): boolean {
  return (order.offer_name ?? '').trim() !== '' && (order.offer_discount_inr ?? 0) > 0;
}

/**
 * What share of an offer discount sits on GST-liable lines (0..1), for GST:
 * an offer is a discount on its OWN item, so it comes out of that item's value
 * — a ₹350 offer on a GST-free jar leaves the café items' GST untouched,
 * instead of being spread over the whole bill like a coupon.
 *
 * Shared over the lines that carry an offer snapshot (offer_unit_inr: the lines
 * of an item with a live offer when sold), by their totals. The bill (create,
 * quote, the POS, every correction) and the GST export (lib/reports/exports/
 * orderData.ts) use this same rule, so the stored GST and the report agree.
 * With no such line (data that shouldn't exist) the offer is spread over every
 * line, as a coupon is.
 */
export function offerTaxableShare(
  lines: readonly { voided?: boolean | null; line_total_inr: number; gst_exempt?: boolean | null; offer_unit_inr?: number | null }[],
): number {
  const live = lines.filter((l) => !l.voided && l.line_total_inr > 0);
  const carriers = live.filter((l) => typeof l.offer_unit_inr === 'number');
  const pool = carriers.length > 0 ? carriers : live;
  const total = pool.reduce((s, l) => s + l.line_total_inr, 0);
  if (total <= 0) return 0;
  return pool.filter((l) => l.gst_exempt !== true).reduce((s, l) => s + l.line_total_inr, 0) / total;
}
