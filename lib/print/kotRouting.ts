// KOT counters — which counter prepares which menu categories, and how one
// order's KOT splits into a slip per counter (supabase/2026-09-kot-counters.sql).
//
// The cafe has ONE printer and several counters (coffee bar, waffle counter,
// kitchen). A single KOT listing every item meant someone had to read it and
// carry each line to the right counter; with counters configured the KOT prints
// as one slip per counter instead, cut apart, each carrying only its own items.
//
// Pure: no Supabase, no React. The ticket model (lib/print/ticketModel.ts), the
// HTML ticket (components/print/StaffTickets.tsx) and the settings API all
// share these rules, so the paper and the settings screen can't disagree.

export interface KotCounter {
  name: string;
  categories: string[];
}

export interface KotRouting {
  counters: KotCounter[];
  /** Also print a slip with EVERY item, for whoever checks the order is complete. */
  full_copy: boolean;
}

/** No counters: the single KOT the cafe always had. Mirrors the column default. */
export const DEFAULT_KOT_ROUTING: KotRouting = { counters: [], full_copy: false };

export const KOT_COUNTER_LIMITS = { maxCounters: 12, maxNameLength: 40, maxCategoryLength: 80 } as const;

/** Title of the slip for items whose category is on no counter. */
export const OTHER_ITEMS_TITLE = 'Other items';
/** Title of the optional every-item slip. */
export const FULL_ORDER_TITLE = 'Full order';

type Validated = { ok: true; routing: KotRouting } | { ok: false; error: string };

/**
 * Strict validation for a save (PUT /api/pos/kot-routing). Trims names and
 * categories, drops empty/duplicate categories within a counter, and refuses:
 * a blank or duplicate counter name, more than `maxCounters` counters, an
 * over-long name, and a category claimed by two counters — an item can only
 * be prepared in one place, and silently picking one would route it somewhere
 * the owner never chose.
 */
export function normalizeKotRouting(input: unknown): Validated {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Expected an object' };
  const raw = input as { counters?: unknown; full_copy?: unknown };

  if (raw.full_copy !== undefined && typeof raw.full_copy !== 'boolean') {
    return { ok: false, error: 'full_copy must be true or false' };
  }
  if (!Array.isArray(raw.counters)) return { ok: false, error: 'counters must be a list' };
  if (raw.counters.length > KOT_COUNTER_LIMITS.maxCounters) {
    return { ok: false, error: `At most ${KOT_COUNTER_LIMITS.maxCounters} counters` };
  }

  const counters: KotCounter[] = [];
  const names = new Set<string>();
  const owner = new Map<string, string>(); // lowercased category -> counter name

  for (const c of raw.counters) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Each counter must be an object' };
    const { name, categories } = c as { name?: unknown; categories?: unknown };
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'Every counter needs a name' };
    const trimmed = name.trim();
    if (trimmed.length > KOT_COUNTER_LIMITS.maxNameLength) {
      return { ok: false, error: `Counter names can be at most ${KOT_COUNTER_LIMITS.maxNameLength} characters` };
    }
    if (names.has(trimmed.toLowerCase())) return { ok: false, error: `Two counters are both called "${trimmed}"` };
    names.add(trimmed.toLowerCase());

    if (!Array.isArray(categories)) return { ok: false, error: `Categories for "${trimmed}" must be a list` };
    const cats: string[] = [];
    for (const cat of categories) {
      if (typeof cat !== 'string') return { ok: false, error: `Categories for "${trimmed}" must be text` };
      const t = cat.trim();
      if (!t || t.length > KOT_COUNTER_LIMITS.maxCategoryLength) continue;
      const key = t.toLowerCase();
      const claimedBy = owner.get(key);
      if (claimedBy === trimmed) continue; // same category twice on one counter
      if (claimedBy) return { ok: false, error: `"${t}" is on both "${claimedBy}" and "${trimmed}"` };
      owner.set(key, trimmed);
      cats.push(t);
    }
    counters.push({ name: trimmed, categories: cats });
  }

  return { ok: true, routing: { counters, full_copy: raw.full_copy === true } };
}

/**
 * Lenient read of the stored setting for printing. Printing must never fail
 * over configuration, so anything unreadable (column missing because the
 * migration isn't applied, a hand-edited row) falls back to the default —
 * the single classic KOT — rather than throwing.
 */
export function readKotRouting(raw: unknown): KotRouting {
  const result = normalizeKotRouting(raw);
  return result.ok ? result.routing : DEFAULT_KOT_ROUTING;
}

export interface KotSlip<T> {
  /** null only for the classic, unsplit KOT (no counters configured). */
  title: string | null;
  kind: 'counter' | 'other' | 'full';
  items: T[];
}

/**
 * Splits an order's lines into KOT slips.
 *
 * - No counters configured: ONE untitled slip with every line — exactly the
 *   KOT printed before counters existed.
 * - Otherwise: one slip per counter, in the owner's order, holding the lines
 *   whose menu category is on that counter; a counter with nothing on this
 *   order gets no slip. Lines whose category is on no counter (or unknown —
 *   a deleted menu item, a custom line) go on an "Other items" slip, so a
 *   line is never silently dropped. With `full_copy`, a final slip carries
 *   every line.
 *
 * Voided lines follow their counter like any other line: a reprint must show
 * that counter what was cancelled.
 */
export function splitKotItems<T extends { menu_item_id: string | null }>(
  items: T[],
  categoryByMenuItemId: Record<string, string>,
  routing: KotRouting,
): KotSlip<T>[] {
  if (routing.counters.length === 0) return [{ title: null, kind: 'full', items }];

  const counterIndexByCategory = new Map<string, number>();
  routing.counters.forEach((c, i) => {
    for (const cat of c.categories) counterIndexByCategory.set(cat.trim().toLowerCase(), i);
  });

  const perCounter: T[][] = routing.counters.map(() => []);
  const other: T[] = [];
  for (const item of items) {
    const category = item.menu_item_id ? categoryByMenuItemId[item.menu_item_id] : undefined;
    const index = category === undefined ? undefined : counterIndexByCategory.get(category.trim().toLowerCase());
    if (index === undefined) other.push(item);
    else perCounter[index].push(item);
  }

  const slips: KotSlip<T>[] = [];
  routing.counters.forEach((c, i) => {
    if (perCounter[i].length > 0) slips.push({ title: c.name, kind: 'counter', items: perCounter[i] });
  });
  if (other.length > 0) slips.push({ title: OTHER_ITEMS_TITLE, kind: 'other', items: other });
  if (routing.full_copy) slips.push({ title: FULL_ORDER_TITLE, kind: 'full', items });

  // An order with no lines at all still prints its (empty) ticket, as before.
  return slips.length > 0 ? slips : [{ title: null, kind: 'full', items }];
}
