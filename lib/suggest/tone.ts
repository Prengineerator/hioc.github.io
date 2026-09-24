// Phase 7 · SUG-3 — tone enforcement (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §4).
//
// Every model-written reason and header, and every deterministic template we
// write ourselves, goes through lintReason() before it is ever shown. A
// failing reason is never patched up — the caller (lib/suggest/validate.ts)
// replaces it wholesale with a deterministic template. Pure, no deps.

import { SUGGEST_LIMITS } from './types';

// One entry per "Never" bullet in §4. Phrases are matched case-insensitively
// and word-boundary-aware (so "spend" doesn't also flag "spending less" vs.
// "suspended" — see escapeRegExp/matchesBannedPhrase below). Multi-word
// phrases are literal substrings with boundaries only at their outer edges.
export const BANNED_PHRASES = [
  // §4 "Never" #1 — spending, income, budget level, past-order counts.
  'spend',
  'spent',
  'spending',
  'income',
  'budget',
  'you always order',
  'you usually order',
  'order count',
  'order history',
  'past orders',

  // §4 "Never" #2 — pressure / urgency.
  'hurry',
  "don't miss",
  'dont miss',
  'only today',
  'you should',
  'you must',
  'best deal',
  'limited time',
  'limited stock',
  'act now',
  'last chance',
  'while it lasts',
  "before it's gone",
  'before its gone',

  // §4 "Never" #3 — health / medical claims.
  'healthy',
  'boosts immunity',
  'boost immunity',
  'good for stress',
  'cures',
  'cure for',
  'medicinal',
  'immune system',
  'detox',

  // §4 "Never" #4 — guessing at feelings beyond what the customer chose.
  'you seem',
  "you're feeling",
  'you are feeling',
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BANNED_PHRASE_MATCHERS = BANNED_PHRASES.map(
  (phrase) => [phrase, new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i')] as const,
);

// Common emoji blocks, matched without the `u` regex flag (unicode property
// escapes like \p{Emoji} need target es2018+; this repo's tsconfig targets
// es2017) — covers the ranges any of our own templates or a model would
// plausibly use (faces, symbols, food/drink, hands) which is what the ≤1
// emoji rule needs to police.
const EMOJI_RE =
  /[☀-➿]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDE4F\uDE80-\uDEFF]|\uD83E[\uDD00-\uDDFF]/g;

function countEmoji(text: string): number {
  return text.match(EMOJI_RE)?.length ?? 0;
}

export interface LintResult {
  ok: boolean;
  problem?: string;
}

/**
 * Enforces §4 on a single model- or template-written string (a `reason` or
 * `header`). Never mutates the text — a failure means "replace this with a
 * template", decided by the caller.
 */
export function lintReason(text: string): LintResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, problem: 'empty' };
  }
  if (text.length > SUGGEST_LIMITS.reasonMaxChars) {
    return { ok: false, problem: 'too_long' };
  }
  // S-2: never rendered as HTML, so angle brackets are refused outright
  // rather than escaped — a linted string must already be plain text.
  if (/[<>]/.test(text)) {
    return { ok: false, problem: 'html' };
  }
  if (/https?:\/\/|www\./i.test(text)) {
    return { ok: false, problem: 'url' };
  }
  if (countEmoji(text) > 1) {
    return { ok: false, problem: 'too_many_emoji' };
  }
  for (const [phrase, re] of BANNED_PHRASE_MATCHERS) {
    if (re.test(text)) {
      return { ok: false, problem: `banned_phrase:${phrase}` };
    }
  }
  return { ok: true };
}

/**
 * Cleans the customer's free-text note (§3.2, ≤140 chars, untrusted —
 * §5.4 `<customer_note>`). Trims, collapses internal whitespace, strips
 * control characters and angle brackets (never rendered as HTML, never lets
 * a customer break out of the `<customer_note>` prompt fencing with a stray
 * tag), and caps at SUGGEST_LIMITS.noteMaxChars.
 */
export function sanitizeNote(raw: string): string {
  const stripped = (raw ?? '')
    // eslint-disable-next-line no-control-regex -- deliberately stripping control chars
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, SUGGEST_LIMITS.noteMaxChars);
}
