// POS quick-add shortform resolver (POS-1 fast-punch). Pure + dependency-light
// so the staff command bar, the browse grid, and the unit tests all agree on ONE
// matching rule. No React, no fetch, no money math — resolution only decides
// WHICH menu item a shortform means; pricing still comes solely from the quote
// endpoint via addLine (never computed here).
//
// Designed CODE-FIRST: the two `code` tiers read an optional owner-defined
// `short_code`. They sit at the top of the ranking but stay INERT until items
// actually carry a code (Phase 2), so enabling owner codes is purely additive —
// no rewrite of the ranking.

import type { MenuItem } from '@/lib/types';
import { isMenuItemAvailable } from '@/lib/menu/availability';

export type QuickMatchKind =
  | 'code' // exact owner short_code (Phase 2)
  | 'code-prefix' // short_code starts with the term (Phase 2)
  | 'name-exact'
  | 'name-prefix'
  | 'word-prefix' // any word in the name starts with the term
  | 'substring' // term appears contiguously anywhere in the name
  | 'subsequence'; // term chars appear in order (fuzzy fallback)

// Base score per tier. Higher = better. Checked in strict descending order so
// the FIRST predicate that hits is always the best tier for that item.
//
// NOTE (refines the design table): a contiguous `substring` is a stronger signal
// than a scattered `subsequence`, so substring (500) ranks above subsequence
// (400). Because every substring is also a subsequence, this keeps the resolver a
// strict SUPERSET of the old `name.includes(q)` search — nothing that matched
// before stops matching.
const TIER_SCORE: Record<QuickMatchKind, number> = {
  code: 1000,
  'code-prefix': 900,
  'name-exact': 800,
  'name-prefix': 700,
  'word-prefix': 600,
  substring: 500,
  subsequence: 400,
};

export interface QuickAddCandidate {
  item: MenuItem;
  available: boolean; // isMenuItemAvailable(item, now)
  kind: QuickMatchKind;
  score: number;
}

export interface ParsedQuickAdd {
  qty: number; // 1..99
  term: string; // the search text after the optional qty prefix
}

const MIN_QTY = 1;
const MAX_QTY = 99;
const DEFAULT_LIMIT = 8;

// Combining diacritical marks range (U+0300–U+036F), stripped after NFD.
const DIACRITICS = /[̀-ͯ]/g;

// lowercase, strip diacritics ("Crème" -> "creme"), collapse whitespace, trim.
export function normalizeToken(input: string): string {
  return input
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// The "add straight vs open the customize modal" rule — the SINGLE source of
// truth, reused by both the tile tap and the quick-add commit so they can't
// drift. An item is simple iff it has exactly one variant and no addon groups.
export function isSimpleItem(item: MenuItem): boolean {
  return item.variants.length === 1 && item.addon_groups.length === 0;
}

// Qty grammar for the command bar: "3*cap" | "3xcap" | "3 cap" -> qty 3.
// A bare number, or a number glued to letters ("3cap"), is NOT a qty prefix —
// it's a literal term. Parsed qty is clamped to 1..99.
export function parseQuickAddInput(raw: string): ParsedQuickAdd {
  const input = raw.trimStart();
  // number + (* or x) + rest   e.g. "3*cap", "3 x cap", "3Xcap"
  let m = input.match(/^(\d{1,4})\s*[*x]\s*(.+)$/i);
  if (!m) {
    // number + whitespace + rest  e.g. "3 cap"
    m = input.match(/^(\d{1,4})\s+(.+)$/);
  }
  if (m) {
    const qty = clampQty(parseInt(m[1], 10));
    return { qty, term: m[2].trim() };
  }
  return { qty: 1, term: input.trim() };
}

function clampQty(n: number): number {
  if (!Number.isFinite(n)) return MIN_QTY;
  return Math.max(MIN_QTY, Math.min(MAX_QTY, Math.trunc(n)));
}

// Rank menu items for a shortform term. Empty/whitespace term -> [].
export function resolveQuickAdd(
  term: string,
  items: MenuItem[],
  opts: { limit?: number; now?: Date } = {},
): QuickAddCandidate[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const now = opts.now ?? new Date();
  const q = normalizeToken(term);
  if (!q) return [];

  const scored: { candidate: QuickAddCandidate; normName: string }[] = [];
  for (const item of items) {
    const normName = normalizeToken(item.name);
    const kind = matchKind(item, normName, q);
    if (!kind) continue;
    scored.push({
      candidate: {
        item,
        available: isMenuItemAvailable(item, now),
        kind,
        score: TIER_SCORE[kind],
      },
      normName,
    });
  }

  scored.sort((a, b) => compare(a.candidate, a.normName, b.candidate, b.normName));
  return scored.slice(0, limit).map((s) => s.candidate);
}

function matchKind(item: MenuItem, normName: string, q: string): QuickMatchKind | null {
  const code = item.short_code ? normalizeToken(item.short_code) : '';
  if (code) {
    if (code === q) return 'code';
    if (code.startsWith(q)) return 'code-prefix';
  }
  if (normName === q) return 'name-exact';
  if (normName.startsWith(q)) return 'name-prefix';
  const words = normName.split(' ');
  if (words.some((w) => w.startsWith(q))) return 'word-prefix';
  if (normName.includes(q)) return 'substring';
  if (isSubsequence(q, normName)) return 'subsequence';
  return null;
}

// Fully deterministic ordering so "Enter picks the top match" is predictable:
//   1. tier/score desc   (best textual relevance wins — never silently substitute
//                          an available loose match for the exact item you typed)
//   2. available before 86'd  (within the same tier only)
//   3. shorter name first     (closer/tighter match)
//   4. sort_order asc
//   5. name asc, then id asc  (stable)
function compare(
  a: QuickAddCandidate,
  aName: string,
  b: QuickAddCandidate,
  bName: string,
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.available !== b.available) return a.available ? -1 : 1;
  if (aName.length !== bName.length) return aName.length - bName.length;
  if (a.item.sort_order !== b.item.sort_order) return a.item.sort_order - b.item.sort_order;
  if (aName !== bName) return aName < bName ? -1 : 1;
  if (a.item.id !== b.item.id) return a.item.id < b.item.id ? -1 : 1;
  return 0;
}

// True if every char of `needle` appears in `haystack` in order (not necessarily
// contiguous). Empty needle matches everything.
function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}
