// Phase 7 · SUG-5 — the per-account taste profile, pure half
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.5). The read-through cache,
// staleness rules and the Supabase query that gathers `orders` live in
// lib/suggest/profileStore.ts ('server-only', a different ticket/agent) —
// this file only does the maths, so it's unit-testable without a database.
//
// Pure: no Supabase, no 'server-only'.

import { passesHardConstraints } from './filter';
import { daypartFor } from './daypart';
import type { MenuItem, OrderStatus } from '@/lib/types';
import type {
  Daypart,
  MenuItemTraits,
  OrderingMood,
  PriceComfort,
  ProfileSummary,
  SuggestInputs,
  TasteProfile,
} from './types';
import { SUGGEST_LIMITS } from './types';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * The one line item of a customer's order that buildTasteProfile needs.
 * NOTE: this is deliberately NOT `OrderItem` from lib/types — an order line
 * only snapshots `name_snapshot`/`menu_item_id`, never the item's category,
 * so a category can't be recovered from the line alone. Because this lib is
 * pure (no Supabase), it can't join menu_items itself either. The caller
 * (profileStore.ts, SUG-5) is expected to join category in from the menu
 * when it loads a customer's orders — one query it already has to make to
 * resolve `traitsById` anyway.
 */
export interface TasteProfileOrderItem {
  menu_item_id: string | null;
  category: string;
  quantity: number;
  voided: boolean;
}

/** The subset of an Order that buildTasteProfile needs, plus its lines. */
export interface TasteProfileOrder {
  status: OrderStatus;
  created_at: string;
  total_inr: number | null;
  subtotal_inr: number;
  items: TasteProfileOrderItem[];
}

export interface BuildTasteProfileArgs {
  /** The customer's orders (already resolved via user_id OR customer_user_id
   * — §5.5/F4). Rejected/cancelled orders may be included or excluded by the
   * caller; this function filters them out either way (belt and braces). */
  orders: TasteProfileOrder[];
  favorites: string[]; // menu_item_ids
  traitsById: Map<string, MenuItemTraits>;
  now: Date;
}

// ---------------------------------------------------------------------------
// Cut points (§5.5) — exported constants so a change is a reviewed diff.
// ---------------------------------------------------------------------------

export const PRICE_COMFORT_BUDGET_MAX_INR = 200; // median < this → 'budget'
export const PRICE_COMFORT_MID_MAX_INR = 400; // median < this → 'mid'; else 'premium'
export const ORDERING_MOOD_TREATING_MULTIPLIER = 1.3; // last-3 mean ≥ this × median → 'treating'
export const ORDERING_MOOD_SAVING_MULTIPLIER = 0.7; // last-3 mean ≤ this × median → 'saving'
export const ORDERING_MOOD_EXPLORER_DISTINCT_RATIO = 0.6; // distinct/lines ≥ this → 'explorer'
export const RECENT_ORDERS_FOR_ORDERING_MOOD = 3;

// Thresholds used only by summarizeProfile (below) to turn the profile's
// continuous numbers into the coarse bands the decider model is allowed to
// see (§5.4 "What Opus sees", playbook S-3).
export const ICED_LEAN_ICED_THRESHOLD = 0.65; // icedShare ≥ this → 'iced'
export const ICED_LEAN_HOT_THRESHOLD = 0.35; // icedShare ≤ this → 'hot'; between → 'mixed'
export const SWEET_LEAN_LOW_MAX = 1; // meanSweetness < this → 'low'
export const SWEET_LEAN_HIGH_MIN = 2; // meanSweetness ≥ this → 'high'; between → 'medium'

function emptyProfile(favorites: string[]): TasteProfile {
  return {
    topItems: [],
    categoryAffinity: {},
    traitLean: { icedShare: 0, meanSweetness: 0, caffeineShare: 0, foodAttachRate: 0 },
    ticket: { median: 0, p75: 0 },
    priceComfort: 'budget',
    orderingMood: 'routine',
    daypartHistogram: { morning: 0, afternoon: 0, evening: 0, late: 0 },
    favorites: [...favorites],
  };
}

/** Linear-interpolation percentile over an ascending-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// ---------------------------------------------------------------------------
// buildTasteProfile
// ---------------------------------------------------------------------------

export function buildTasteProfile(args: BuildTasteProfileArgs): TasteProfile {
  const { orders, favorites, traitsById, now } = args;

  const windowStartMs = now.getTime() - SUGGEST_LIMITS.profileWindowDays * 24 * 60 * 60 * 1000;
  // Non-rejected/non-cancelled, last 90 days, newest 50 (§5.5).
  const eligible = orders
    .filter((o) => o.status !== 'rejected' && o.status !== 'cancelled')
    .filter((o) => new Date(o.created_at).getTime() >= windowStartMs)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, SUGGEST_LIMITS.profileMaxOrders);

  if (eligible.length === 0) return emptyProfile(favorites);

  const itemCounts = new Map<string, { count: number; lastOrderedAt: string }>();
  const categoryLines = new Map<string, number>();
  let totalLines = 0;
  let hotOrIcedLines = 0;
  let icedLines = 0;
  let sweetnessSum = 0;
  let sweetnessLines = 0;
  let caffeineEligibleLines = 0;
  let caffeineLines = 0;
  let ordersWithFood = 0;

  for (const order of eligible) {
    let orderHasFood = false;
    for (const line of order.items) {
      // Voided lines never happened, financially or tastewise (F1/phase3).
      if (line.voided) continue;
      const qty = Math.max(1, line.quantity);
      totalLines += qty;
      categoryLines.set(line.category, (categoryLines.get(line.category) ?? 0) + qty);

      if (line.menu_item_id) {
        const cur = itemCounts.get(line.menu_item_id) ?? { count: 0, lastOrderedAt: order.created_at };
        cur.count += qty;
        if (order.created_at > cur.lastOrderedAt) cur.lastOrderedAt = order.created_at;
        itemCounts.set(line.menu_item_id, cur);

        const traits = traitsById.get(line.menu_item_id);
        if (traits) {
          if (traits.temperature === 'hot' || traits.temperature === 'iced') {
            hotOrIcedLines += qty;
            if (traits.temperature === 'iced') icedLines += qty;
          }
          sweetnessSum += traits.sweetness * qty;
          sweetnessLines += qty;
          if (traits.kind === 'drink') {
            caffeineEligibleLines += qty;
            if (traits.caffeine !== 'none') caffeineLines += qty;
          }
          if (traits.kind === 'food' || traits.kind === 'dessert') orderHasFood = true;
        }
      }
    }
    if (orderHasFood) ordersWithFood += 1;
  }

  const topItems = [...itemCounts.entries()]
    .map(([menu_item_id, v]) => ({ menu_item_id, count: v.count, lastOrderedAt: v.lastOrderedAt }))
    .sort((a, b) => b.count - a.count || a.menu_item_id.localeCompare(b.menu_item_id))
    .slice(0, 10);

  const categoryAffinity: Record<string, number> = {};
  for (const [cat, n] of categoryLines) {
    categoryAffinity[cat] = totalLines ? n / totalLines : 0;
  }

  const traitLean = {
    icedShare: hotOrIcedLines ? icedLines / hotOrIcedLines : 0,
    meanSweetness: sweetnessLines ? sweetnessSum / sweetnessLines : 0,
    caffeineShare: caffeineEligibleLines ? caffeineLines / caffeineEligibleLines : 0,
    foodAttachRate: eligible.length ? ordersWithFood / eligible.length : 0,
  };

  // ticket: order-level total_inr ?? subtotal_inr (§5.5), not line-level.
  const tickets = eligible.map((o) => o.total_inr ?? o.subtotal_inr).sort((a, b) => a - b);
  const median = Math.round(percentile(tickets, 0.5));
  const p75 = Math.round(percentile(tickets, 0.75));
  const ticket = { median, p75 };

  const priceComfort: PriceComfort =
    median < PRICE_COMFORT_BUDGET_MAX_INR ? 'budget' : median < PRICE_COMFORT_MID_MAX_INR ? 'mid' : 'premium';

  const recentTickets = eligible.slice(0, RECENT_ORDERS_FOR_ORDERING_MOOD).map((o) => o.total_inr ?? o.subtotal_inr);
  const recentMean = recentTickets.length ? recentTickets.reduce((a, b) => a + b, 0) / recentTickets.length : 0;
  const distinctItems = itemCounts.size;
  const explorerRatio = totalLines ? distinctItems / totalLines : 0;

  let orderingMood: OrderingMood;
  if (median > 0 && recentMean >= ORDERING_MOOD_TREATING_MULTIPLIER * median) {
    orderingMood = 'treating';
  } else if (median > 0 && recentMean <= ORDERING_MOOD_SAVING_MULTIPLIER * median) {
    orderingMood = 'saving';
  } else if (explorerRatio >= ORDERING_MOOD_EXPLORER_DISTINCT_RATIO) {
    orderingMood = 'explorer';
  } else {
    orderingMood = 'routine';
  }

  const daypartCounts: Record<Daypart, number> = { morning: 0, afternoon: 0, evening: 0, late: 0 };
  for (const o of eligible) {
    daypartCounts[daypartFor(new Date(o.created_at))] += 1;
  }
  const daypartHistogram: Record<Daypart, number> = {
    morning: daypartCounts.morning / eligible.length,
    afternoon: daypartCounts.afternoon / eligible.length,
    evening: daypartCounts.evening / eligible.length,
    late: daypartCounts.late / eligible.length,
  };

  return {
    topItems,
    categoryAffinity,
    traitLean,
    ticket,
    priceComfort,
    orderingMood,
    daypartHistogram,
    favorites: [...favorites],
  };
}

// ---------------------------------------------------------------------------
// summarizeProfile — the ONLY view of a customer the decider model may see
// (§5.4 "What Opus sees", playbook S-3): coarse bands, ≤3 categories, ≤5
// item ids. No name, phone, email, order ids, timestamps or rupee totals.
// ---------------------------------------------------------------------------

export function summarizeProfile(profile: TasteProfile): ProfileSummary {
  const topCategories = Object.entries(profile.categoryAffinity)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat]) => cat);

  const icedLean: ProfileSummary['icedLean'] =
    profile.traitLean.icedShare >= ICED_LEAN_ICED_THRESHOLD
      ? 'iced'
      : profile.traitLean.icedShare <= ICED_LEAN_HOT_THRESHOLD
        ? 'hot'
        : 'mixed';

  const sweetLean: ProfileSummary['sweetLean'] =
    profile.traitLean.meanSweetness < SWEET_LEAN_LOW_MAX
      ? 'low'
      : profile.traitLean.meanSweetness >= SWEET_LEAN_HIGH_MIN
        ? 'high'
        : 'medium';

  return {
    topCategories,
    icedLean,
    sweetLean,
    priceComfort: profile.priceComfort,
    orderingMood: profile.orderingMood,
    usualItemIds: profile.topItems.slice(0, 5).map((t) => t.menu_item_id),
  };
}

// ---------------------------------------------------------------------------
// pickUsual — the "Your usual" card (§3.2 step 3): the customer's
// most-ordered item that is still available and passes TODAY's hard
// constraints (§5.2), so a usual that's 86'd or now breaks a chosen filter
// (e.g. they picked "No caffeine" today) is never shown. Takes the full menu
// + traits (not a pre-filtered Candidate[]) because a usual item may not be
// in today's shortlist at all (it can fail the mood/extras scoring and still
// be a perfectly valid "usual") — only the hard constraints apply here.
// Returns the menu_item_id, or null when signed out / no history / nothing
// in their history clears today's filters.
// ---------------------------------------------------------------------------

export function pickUsual(
  profile: TasteProfile | null,
  items: MenuItem[],
  traitsById: Map<string, MenuItemTraits>,
  inputs: SuggestInputs,
): string | null {
  if (!profile) return null;
  const itemsById = new Map(items.map((i) => [i.id, i]));

  // topItems is already sorted most-ordered first (buildTasteProfile).
  for (const top of profile.topItems) {
    const item = itemsById.get(top.menu_item_id);
    if (!item) continue;
    if (passesHardConstraints(item, traitsById.get(item.id), inputs, [])) {
      return top.menu_item_id;
    }
  }
  return null;
}
