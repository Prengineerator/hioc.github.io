// Coffey add-ons & pairings — the checkout "Pairs well with your order" ranker
// (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.1).
//
// Given what is already in the cart, pick up to three things that go with it:
// each menu item the customer could add is scored against every cart item (its
// "anchor") on five terms — does it complete the order (complement), do people
// really order the two together (coOrder), do their flavours agree or make a
// pleasing contrast (harmony), is it popular (popularity), and does it suit the
// time of day (daypartFit) — and keeps its best anchor. A greedy pass then takes
// the best-scoring candidates from distinct categories, at most one of them a
// drink, and writes a one-line reason that names the anchor.
//
// Deterministic and cheap by design: no model call, no randomness, no clock but
// the `now` the caller hands in. Same inputs ⇒ same picks, in the same order,
// with the same words. Ties break on menuItemId ascending (candidates) and on
// anchor id ascending (a candidate that scores the same against two cart items
// names the lower id), so the result never depends on menu or cart order.
//
// Pure: no Supabase, no 'server-only', no React. Server code feeds it the menu,
// the traits, the co-order stats and the popularity map it has already loaded
// (lib/suggest/serverData.ts); tests feed it fixtures.

import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { MenuItem } from '@/lib/types';
import { daypartFor } from './daypart';
import { flavourFamiliesOf } from './flavor';
import { sweetnessLevel } from './sweetness';
import { lintReason } from './tone';
import { FLAVOUR_FAMILY_INFO } from './traitVocabulary';
import type { CoOrderStats, Daypart, FlavourFamily, MenuItemTraits, PairingPick, TraitKind } from './types';
import { PAIRING_LIMITS } from './types';

// ---------------------------------------------------------------------------
// Weights and term constants (§4.1) — change with a reviewed diff
// ---------------------------------------------------------------------------

/** How much each term counts towards a pairing's score. Sums to 1, so a score is
 * on 0–1 and compares directly with PAIRING_LIMITS.minScore. */
export const PAIRING_WEIGHTS = {
  complement: 0.4,
  coOrder: 0.25,
  harmony: 0.2,
  popularity: 0.1,
  daypart: 0.05,
} as const;

/** A co-order rate of this share of the anchor's orders is "as good as it gets"
 * for the confidence half of the coOrder term. */
const CO_ORDER_FULL_CONFIDENCE = 0.25;
/** Lift above 1 counts in full once it reaches 1 + this (lift 4 ⇒ 1). */
const CO_ORDER_LIFT_SPAN = 3;
/** A reason that opens "Often ordered with" needs the coOrder term at least this strong. */
const OFTEN_ORDERED_MIN_CO_ORDER = 0.6;

const HARMONY_SHARED_FAMILY = 0.6;
const HARMONY_CONTRAST = 0.4;
/** A coffee drink counts as "bold" for the sweet-dessert contrast at or below this sweetness (0–10)… */
const BOLD_COFFEE_MAX_SWEETNESS = 4;
/** …and a dessert counts as "sweet" at or above this one. */
const SWEET_DESSERT_MIN_SWEETNESS = 6;

/** A medium- or high-caffeine drink loses appeal as the day winds down. */
const DAYPART_FIT_CAFFEINATED: Record<Daypart, number> = { morning: 1, afternoon: 1, evening: 0.5, late: 0 };

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Co-order statistics
// ---------------------------------------------------------------------------

/** The key a pair of items is counted under in CoOrderStats.pairs: the two ids
 * sorted and joined with '|', so (a, b) and (b, a) are one pair. */
export function pairKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Counts, over a batch of orders, how many orders there were, how many
 * contained each item, and how many contained each pair of items.
 *
 * Each order counts an item once however many lines it has (ids are
 * de-duplicated within the order), so `itemOrders` and `pairs` are numbers of
 * ORDERS, which is what confidence and lift need. An order with no ids (an empty
 * array, or only blank ids) is skipped entirely: it is not an order that could
 * have paired anything, and counting it would only dilute every lift. An order
 * with a single distinct item does count (towards `orders` and that item's
 * `itemOrders`), because it is evidence the item is often bought on its own.
 */
export function buildCoOrderStats(orders: { itemIds: string[] }[]): CoOrderStats {
  let total = 0;
  const itemOrders = new Map<string, number>();
  const pairs = new Map<string, number>();

  for (const order of orders) {
    const ids = [...new Set((order?.itemIds ?? []).filter((id) => typeof id === 'string' && id.length > 0))];
    if (ids.length === 0) continue;
    total += 1;
    for (const id of ids) itemOrders.set(id, (itemOrders.get(id) ?? 0) + 1);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = pairKey(ids[i], ids[j]);
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  return { orders: total, itemOrders, pairs };
}

// ---------------------------------------------------------------------------
// The five terms (§4.1) — each 0–1
// ---------------------------------------------------------------------------

/**
 * How well a candidate of `kind` completes a cart holding `cartKinds`. A drink
 * for a cart with none is perfect, a second drink is a stretch; a dessert is best
 * after a drink and pointless on top of another dessert; food sits between.
 */
export function complementFit(kind: TraitKind, cartKinds: ReadonlySet<TraitKind>): number {
  if (kind === 'drink') return cartKinds.has('drink') ? 0.2 : 1;
  if (kind === 'dessert') {
    if (cartKinds.has('dessert')) return 0.15;
    return cartKinds.has('drink') ? 1 : 0.6;
  }
  // food
  if (cartKinds.has('food')) return 0.15;
  return cartKinds.has('drink') ? 0.8 : 0.6;
}

/**
 * How strongly recent orders pair the cart item with the candidate. 0 below
 * PAIRING_LIMITS.minCoOrders joint orders (too few to be a pattern). Otherwise
 * half confidence (share of the anchor's orders that also had the candidate,
 * full marks at 25%) and half lift (how much likelier than chance, full marks at
 * 4×).
 */
export function coOrderFit(anchorId: string, candidateId: string, stats: CoOrderStats): number {
  const pairs = stats.pairs.get(pairKey(anchorId, candidateId)) ?? 0;
  if (pairs < PAIRING_LIMITS.minCoOrders) return 0;
  const anchorOrders = stats.itemOrders.get(anchorId) ?? 0;
  const candidateOrders = stats.itemOrders.get(candidateId) ?? 0;
  if (stats.orders <= 0 || anchorOrders <= 0 || candidateOrders <= 0) return 0; // inconsistent stats
  const confidence = pairs / anchorOrders;
  const lift = (pairs * stats.orders) / (anchorOrders * candidateOrders);
  return clamp01(
    0.5 * Math.min(1, confidence / CO_ORDER_FULL_CONFIDENCE) + 0.5 * clamp01((lift - 1) / CO_ORDER_LIFT_SPAN),
  );
}

/** What harmony needs to know about an item. */
export interface PairingSubject {
  name: string;
  traits: MenuItemTraits;
}

function isBoldCoffee(traits: MenuItemTraits): boolean {
  return traits.kind === 'drink' && traits.is_coffee && sweetnessLevel(traits) <= BOLD_COFFEE_MAX_SWEETNESS;
}

function isSweetDessert(traits: MenuItemTraits): boolean {
  return traits.kind === 'dessert' && sweetnessLevel(traits) >= SWEET_DESSERT_MIN_SWEETNESS;
}

/** A sweet dessert next to a bold coffee, or the other way round. */
function isSweetCoffeeContrast(a: MenuItemTraits, b: MenuItemTraits): boolean {
  return (isBoldCoffee(a) && isSweetDessert(b)) || (isSweetDessert(a) && isBoldCoffee(b));
}

/** The first flavour family (FLAVOUR_FAMILIES order) both lists have, or null. */
function firstSharedFamily(a: readonly FlavourFamily[], b: readonly FlavourFamily[]): FlavourFamily | null {
  return a.find((family) => b.includes(family)) ?? null;
}

function harmonyOf(sharedFamily: FlavourFamily | null, contrast: boolean): number {
  return Math.min(1, HARMONY_SHARED_FAMILY * (sharedFamily ? 1 : 0) + HARMONY_CONTRAST * (contrast ? 1 : 0));
}

/**
 * Do the two items taste well together? 0.6 for sharing a flavour family
 * (lib/suggest/flavor.ts: name or flavour notes), plus 0.4 for the classic
 * contrast of a sweet dessert (sweetness ≥ 6) with a bold coffee (≤ 4), in
 * either direction; capped at 1.
 */
export function harmonyFit(anchor: PairingSubject, candidate: PairingSubject): number {
  const shared = firstSharedFamily(
    flavourFamiliesOf(anchor.name, anchor.traits.flavor_notes),
    flavourFamiliesOf(candidate.name, candidate.traits.flavor_notes),
  );
  return harmonyOf(shared, isSweetCoffeeContrast(anchor.traits, candidate.traits));
}

/** Does the item suit this daypart? Only a drink with medium or high caffeine is
 * marked down for the evening and the late hours; everything else fits all day. */
export function daypartFit(traits: Pick<MenuItemTraits, 'kind' | 'caffeine'>, daypart: Daypart): number {
  if (traits.kind === 'drink' && (traits.caffeine === 'medium' || traits.caffeine === 'high')) {
    return DAYPART_FIT_CAFFEINATED[daypart];
  }
  return 1;
}

// The same normaliser as lib/suggest/score.ts popularityNormalizer (private
// there): 30-day units, min-max normalised across the WHOLE menu, and 0 for
// everyone when there is no spread. Mirrored rather than imported so this file
// stays free of score.ts's weight; change the two together.
function popularityNormalizer(popularity: Map<string, number>): (menuItemId: string) => number {
  const values = [...popularity.values()];
  if (values.length === 0) return () => 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return () => 0; // no spread — no signal either way.
  return (menuItemId: string) => clamp01(((popularity.get(menuItemId) ?? 0) - min) / (max - min));
}

// ---------------------------------------------------------------------------
// Reasons (§4.1) — the first matching template, the anchor shortened to fit
// ---------------------------------------------------------------------------

/** Shown when no template survives the tone lint (an anchor name with a banned
 * word or an angle bracket in it, say): it names nothing, so it always passes. */
const GENERIC_REASON = 'Pairs well with your order.';

interface ReasonParts {
  prefix: string;
  suffix: string;
}

/** `prefix + anchor + suffix`, with the anchor cut and ended in "…" when the
 * whole line would be over the cap. Null when there is no room for even a
 * character of it. */
function composeReason({ prefix, suffix }: ReasonParts, anchorName: string): string | null {
  const room = PAIRING_LIMITS.reasonMaxChars - prefix.length - suffix.length;
  if (anchorName.length <= room) return `${prefix}${anchorName}${suffix}`;
  if (room < 2) return null;
  let cut = anchorName.slice(0, room - 1);
  // Don't leave half of a surrogate pair (an emoji) at the cut.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  cut = cut.trimEnd();
  if (cut.length === 0) return null;
  return `${prefix}${cut}…${suffix}`;
}

/**
 * The one-line "why" for a pairing, ≤ PAIRING_LIMITS.reasonMaxChars and tone-linted
 * (lintReason). The first template that applies wins:
 *   1. coOrder ≥ 0.6        — "Often ordered with your <A>."
 *   2. a shared family      — "Pairs well with your <A> — <that family's phrase>."
 *   3. a dessert            — "Pairs well with your <A> — a sweet finish."
 *   4. food                 — "Pairs well with your <A> — a savoury bite on the side."
 *   5. a drink              — "Pairs well with your <A> — something to sip alongside."
 * If the chosen line fails the lint, the plain "Pairs well with your <A>." is
 * tried; if that fails too, a line that names nothing.
 */
export function pairingReason(args: {
  anchorName: string;
  coOrder: number;
  sharedFamily: FlavourFamily | null;
  kind: TraitKind;
}): string {
  const anchorName = args.anchorName.replace(/\s+/g, ' ').trim();
  const lead = 'Pairs well with your ';

  let templated: ReasonParts;
  if (args.coOrder >= OFTEN_ORDERED_MIN_CO_ORDER) {
    templated = { prefix: 'Often ordered with your ', suffix: '.' };
  } else if (args.sharedFamily) {
    templated = { prefix: lead, suffix: ` — ${FLAVOUR_FAMILY_INFO[args.sharedFamily].phrase}.` };
  } else if (args.kind === 'dessert') {
    templated = { prefix: lead, suffix: ' — a sweet finish.' };
  } else if (args.kind === 'food') {
    templated = { prefix: lead, suffix: ' — a savoury bite on the side.' };
  } else {
    templated = { prefix: lead, suffix: ' — something to sip alongside.' };
  }

  for (const parts of [templated, { prefix: lead, suffix: '.' }]) {
    const text = composeReason(parts, anchorName);
    if (text !== null && text.length <= PAIRING_LIMITS.reasonMaxChars && lintReason(text).ok) return text;
  }
  return GENERIC_REASON;
}

// ---------------------------------------------------------------------------
// The ranker
// ---------------------------------------------------------------------------

export interface PairingsArgs {
  /** The menu item ids in the cart. Ids with no menu row or no traits are ignored. */
  cartItemIds: string[];
  /** The orderable menu (the caller has already removed in-store-only, hidden-category
   * and switched-off items). Availability snoozes are still checked here, against `now`. */
  menu: MenuItem[];
  traitsById: Map<string, MenuItemTraits>;
  coOrders: CoOrderStats;
  /** menuItemId → units sold in the last 30 days, across the whole menu. */
  popularity: Map<string, number>;
  now: Date;
  /** Defaults to PAIRING_LIMITS.picks. */
  limit?: number;
}

/** What the ranker keeps about an item it has looked at once. */
interface Subject {
  item: MenuItem;
  traits: MenuItemTraits;
  families: FlavourFamily[];
  /** Cheapest size; Infinity when the item has no variants. */
  minPrice: number;
}

function subjectOf(item: MenuItem, traits: MenuItemTraits): Subject {
  const prices = (item.variants ?? []).map((v) => v.price_inr);
  return {
    item,
    traits,
    families: flavourFamiliesOf(item.name, traits.flavor_notes),
    minPrice: prices.length > 0 ? Math.min(...prices) : Infinity,
  };
}

interface Scored {
  subject: Subject;
  anchor: Subject;
  score: number;
  coOrder: number;
  sharedFamily: FlavourFamily | null;
}

/**
 * Up to `limit` (default 3) menu items that go with the cart, best first
 * (COFFEY-ADDONS-PAIRINGS-SPEC §4.1).
 *
 * - Pool: items not in the cart that are available (at `now`), have a traits row,
 *   and whose cheapest size is ≤ max(PAIRING_LIMITS.minPriceCapInr, the dearest
 *   cheapest size in the cart).
 * - Score: `0.40·complement + 0.25·coOrder + 0.20·harmony + 0.10·popularity +
 *   0.05·daypartFit` against each cart item, keeping the best anchor.
 * - Select: drop scores under PAIRING_LIMITS.minScore, then take candidates in
 *   descending score order (ties by menuItemId ascending), skipping a category
 *   already taken and any second drink.
 *
 * An empty cart, or one whose items are all unknown or untagged, gives [].
 */
export function pairingsFor(args: PairingsArgs): PairingPick[] {
  const { cartItemIds, menu, traitsById, coOrders, popularity, now } = args;
  const limit = Number.isFinite(args.limit) ? Math.floor(args.limit as number) : PAIRING_LIMITS.picks;
  if (limit <= 0) return [];

  const menuById = new Map<string, MenuItem>();
  for (const item of menu) if (!menuById.has(item.id)) menuById.set(item.id, item);

  const cartIds = new Set(cartItemIds);
  const anchors: Subject[] = [];
  for (const id of [...cartIds].sort()) {
    const item = menuById.get(id);
    const traits = traitsById.get(id);
    if (item && traits) anchors.push(subjectOf(item, traits));
  }
  if (anchors.length === 0) return [];

  const cartKinds = new Set<TraitKind>(anchors.map((a) => a.traits.kind));
  const cartPrices = anchors.map((a) => a.minPrice).filter(Number.isFinite);
  const priceCap = Math.max(PAIRING_LIMITS.minPriceCapInr, ...cartPrices);

  const popularityFor = popularityNormalizer(popularity);
  const daypart = daypartFor(now); // once: building an Intl formatter per item is wasteful

  const scored: Scored[] = [];
  for (const item of menuById.values()) {
    if (cartIds.has(item.id)) continue;
    const traits = traitsById.get(item.id);
    if (!traits || !isMenuItemAvailable(item, now)) continue;
    const subject = subjectOf(item, traits);
    if (!(subject.minPrice <= priceCap)) continue;

    // Everything except coOrder and harmony is the same whichever anchor it is against.
    const base =
      PAIRING_WEIGHTS.complement * complementFit(traits.kind, cartKinds) +
      PAIRING_WEIGHTS.popularity * popularityFor(item.id) +
      PAIRING_WEIGHTS.daypart * daypartFit(traits, daypart);

    let best: Scored | null = null;
    for (const anchor of anchors) {
      const coOrder = coOrderFit(anchor.item.id, item.id, coOrders);
      const sharedFamily = firstSharedFamily(anchor.families, subject.families);
      const harmony = harmonyOf(sharedFamily, isSweetCoffeeContrast(anchor.traits, traits));
      const score = clamp01(base + PAIRING_WEIGHTS.coOrder * coOrder + PAIRING_WEIGHTS.harmony * harmony);
      if (best === null || score > best.score) best = { subject, anchor, score, coOrder, sharedFamily };
    }
    if (best && best.score >= PAIRING_LIMITS.minScore) scored.push(best);
  }

  scored.sort((a, b) => b.score - a.score || (a.subject.item.id < b.subject.item.id ? -1 : 1));

  const picks: PairingPick[] = [];
  const takenCategories = new Set<string>();
  let hasDrink = false;
  for (const s of scored) {
    if (picks.length >= limit) break;
    const isDrink = s.subject.traits.kind === 'drink';
    if (takenCategories.has(s.subject.item.category) || (isDrink && hasDrink)) continue;
    takenCategories.add(s.subject.item.category);
    if (isDrink) hasDrink = true;
    picks.push({
      menuItemId: s.subject.item.id,
      anchorItemId: s.anchor.item.id,
      reason: pairingReason({
        anchorName: s.anchor.item.name,
        coOrder: s.coOrder,
        sharedFamily: s.sharedFamily,
        kind: s.subject.traits.kind,
      }),
      score: s.score,
    });
  }
  return picks;
}
