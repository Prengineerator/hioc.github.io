// Phase 7 · SUG-3 — deterministic, house-tone copy (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §4 tone guide, §5.4 "Validation" fallback, §3.2 step-3 header). Every
// string this file produces is deterministic (same inputs ⇒ same text,
// unlike the Opus decider) and is the thing shown whenever the LLM is
// skipped, times out, or writes something lintReason() rejects.
//
// Pure: no Supabase, no 'server-only'.

import { sanitizeNote } from './tone';
import type { Candidate, Mood, MenuItemTraits, SuggestInputs, SuggestionPick } from './types';
import { SUGGEST_LIMITS } from './types';

function capReason(text: string): string {
  const clean = sanitizeNote(text);
  if (clean.length <= SUGGEST_LIMITS.reasonMaxChars) return clean;
  // Never triggered by the templates below (all comfortably under the cap
  // even with two flavor notes appended) — a safety net, not the normal path.
  return `${clean.slice(0, SUGGEST_LIMITS.reasonMaxChars - 1).trimEnd()}…`;
}

// One warm clause per mood (§4 "Do": name the taste, not the sale).
const MOOD_CLAUSE: Record<Mood, string> = {
  boost: 'a good lift when you need the energy',
  cosy: 'warm and unhurried, a cosy choice',
  celebrate: 'a little indulgence, lovely for celebrating',
  comfort: 'rich and comforting',
  cool: 'cold and refreshing for a warm day',
  surprise: 'a little different from your usual, worth a try',
};

function flavorPhrase(traits: MenuItemTraits): string {
  return traits.flavor_notes.slice(0, 2).join(' and ');
}

/**
 * A single-sentence, tone-linted reason for one item. `reasonCode` decides
 * the shape: a Mood writes that mood's clause, 'usual' and 'popular' get
 * their own framing, and 'trait' (the general catch-all) leans on the
 * item's flavor notes alone.
 */
export function templateReason(
  traits: MenuItemTraits,
  inputs: SuggestInputs,
  reasonCode: SuggestionPick['reasonCode'],
): string {
  const notes = flavorPhrase(traits);
  let text: string;

  if (reasonCode === 'usual') {
    text = notes ? `Your usual — ${notes}, always a good choice.` : 'Your usual — always a good choice.';
  } else if (reasonCode === 'popular') {
    text = notes ? `Our regulars love this one, with ${notes}.` : 'Our regulars love this one.';
  } else if (reasonCode === 'trait') {
    text = notes ? `A lovely pick, with ${notes}.` : 'A lovely pick for what you asked for.';
  } else {
    // reasonCode is a Mood. `inputs` isn't needed for the mood clause itself
    // (the mood is already in reasonCode) — kept in the signature to match
    // this ticket's contract and because a future mood-specific wording
    // (e.g. reading inputs.extras) is a natural, localised extension here.
    const clause = MOOD_CLAUSE[reasonCode];
    text = notes ? `A lovely pick — ${notes}, ${clause}.` : `A lovely pick — ${clause}.`;
  }

  return capReason(text);
}

// One header per mood (§3.2 step 3, e.g. "Here's what we'd pour for you ☕").
const MOOD_HEADER: Record<Mood, string> = {
  boost: "Here's a little lift for you ☕",
  cosy: "Here's something warm and cosy for you ☕",
  celebrate: "Here's what we'd pour to celebrate 🎉",
  comfort: "Here's something comforting for you ☕",
  cool: "Here's something cool for you 🧊",
  surprise: "Here's a little surprise for you ✨",
};

export function templateHeader(mood: Mood): string {
  return MOOD_HEADER[mood];
}

/**
 * The deterministic ranking's own top picks (§5.4 "Validation" — what tops
 * up a short Opus response, and what the whole response is when the LLM is
 * skipped). `reasonCode` is the chosen mood when the item is tagged for it;
 * 'popular' needs a popularity signal this function isn't given (that's the
 * scorer's job upstream), so the catch-all here is 'trait'.
 */
export function deterministicPicks(shortlist: Candidate[], inputs: SuggestInputs): SuggestionPick[] {
  return shortlist.slice(0, SUGGEST_LIMITS.picks).map((c) => {
    const reasonCode: SuggestionPick['reasonCode'] = c.traits.moods.includes(inputs.mood) ? inputs.mood : 'trait';
    return {
      menuItemId: c.menuItemId,
      reason: templateReason(c.traits, inputs, reasonCode),
      reasonCode,
    };
  });
}
