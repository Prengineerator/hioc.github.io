// Pure decisions behind the two client-side preset events on /suggest
// (docs/COFFEY-SPEC.md §11.7): 'preset_removed' and 'preset_kept'. No React, no
// DOM, so the rules can be unit-tested (tests/suggestPresetEvents.test.ts).
//
// The wizard calls these; it owns the refs and the postSuggestEvent calls.

/** The part of a cart line these rules read (a subset of CartItem). */
export interface CartLineLike {
  key: string;
  menuItemId: string;
  qty: number;
  suggestionSessionId?: string;
  addons: { optionId: string }[];
}

/**
 * Did the line that went into the cart keep at least one of the pick's preset
 * add-on options? Sugar presets are not passed in: only add-on option ids.
 */
export function presetOutcome(
  presetOptionIds: readonly string[],
  lineAddonOptionIds: readonly string[],
): 'kept' | 'removed' {
  const onLine = new Set(lineAddonOptionIds);
  return presetOptionIds.some((id) => onLine.has(id)) ? 'kept' : 'removed';
}

/**
 * The once-per-pick rule for 'preset_removed': true the first time a pick is
 * reported in a response (and records it), false afterwards. The caller keeps
 * one Set per response and clears it when a new response arrives.
 */
export function claimRemovedReport(reported: Set<string>, pickId: string): boolean {
  if (reported.has(pickId)) return false;
  reported.add(pickId);
  return true;
}

/** A snapshot of the cart before an add: line key -> qty. */
export function snapshotLines(items: readonly Pick<CartLineLike, 'key' | 'qty'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.key] = i.qty;
  return out;
}

/**
 * Which cart line did the customise screen just add? The line for this menu
 * item that is NEW since `before`, or whose qty GREW since `before` (the add
 * merged into an identical line). Returns null, "cannot tell", unless exactly
 * one such line exists, and, for a new line, unless it carries this suggestion
 * session id (the cart stamps it on from the one-shot pending hint). Merged
 * lines keep whichever session id they already had, so only the qty growth
 * identifies them.
 */
export function findAddedLine<L extends CartLineLike>(
  before: Readonly<Record<string, number>>,
  after: readonly L[],
  menuItemId: string,
  sessionId: string,
): L | null {
  const changed = after.filter((l) => {
    if (l.menuItemId !== menuItemId) return false;
    const prev = before[l.key];
    if (prev === undefined) return l.suggestionSessionId === sessionId;
    return l.qty > prev;
  });
  return changed.length === 1 ? changed[0] : null;
}

/**
 * What to send when a pick that carries add-on presets really went into the
 * cart: 'preset_kept', 'preset_removed' (not if already reported for the pick),
 * or null for nothing. `lineAddonOptionIds` null means the added line could not
 * be identified: send neither.
 */
export function eventForAdd(
  presetOptionIds: readonly string[],
  lineAddonOptionIds: readonly string[] | null,
  alreadyRemoved: boolean,
): 'preset_kept' | 'preset_removed' | null {
  if (presetOptionIds.length === 0 || lineAddonOptionIds === null) return null;
  if (presetOutcome(presetOptionIds, lineAddonOptionIds) === 'kept') return 'preset_kept';
  return alreadyRemoved ? null : 'preset_removed';
}
