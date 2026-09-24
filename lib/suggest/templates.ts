// Phase 7 · SUG-3 — deterministic, house-tone copy (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §4 tone guide, §5.4 "Validation" fallback, §3.2 step-3 header). Every
// string this file produces is deterministic (same inputs ⇒ same text,
// unlike the Opus decider) and is the thing shown whenever the LLM is
// skipped, times out, or writes something lintReason() rejects.
//
// Pure: no Supabase, no 'server-only'.

import { isChocolatey, isFruity } from './flavor';
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

/** When the customer chose 'chocolatey'/'fruity' (owner addition, soft
 * preference — §5.3) and this item actually matches it, name that flavour
 * specifically instead of the generic flavor-note join — "rich, chocolatey
 * notes" reads better than a bare tag list, and it's what the customer
 * explicitly asked for. */
function extraFlavorClause(inputs: SuggestInputs, traits: MenuItemTraits, name: string): string | null {
  if (inputs.extras.includes('chocolatey') && isChocolatey(name, traits.flavor_notes)) {
    return 'rich, chocolatey notes';
  }
  if (inputs.extras.includes('fruity') && isFruity(name, traits.flavor_notes)) {
    return 'a bright, fruity flavour';
  }
  return null;
}

function flavorPhrase(traits: MenuItemTraits, inputs: SuggestInputs, name: string): string {
  return extraFlavorClause(inputs, traits, name) ?? traits.flavor_notes.slice(0, 2).join(' and ');
}

/**
 * A single-sentence, tone-linted reason for one item. `reasonCode` decides
 * the shape: a Mood writes that mood's clause, 'usual' and 'popular' get
 * their own framing, and 'trait' (the general catch-all) leans on the
 * item's flavor notes alone. `name` is optional — it's only needed to match
 * the 'chocolatey'/'fruity' extras against the item's own name (flavor_notes
 * alone still work without it, e.g. from the 'usual' card's call site).
 */
export function templateReason(
  traits: MenuItemTraits,
  inputs: SuggestInputs,
  reasonCode: SuggestionPick['reasonCode'],
  name = '',
): string {
  const notes = flavorPhrase(traits, inputs, name);
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

// A "tie" for the purposes of the variety tie-break below (§5.3 diversity):
// candidates whose scores are within this of each other are close enough
// that category variety, not the score itself, should decide which comes
// next. Ours to choose (the spec fixes only the top-level scoring weights).
const TIE_BREAK_SCORE_DELTA = 0.05;

/**
 * Picks the top `count` candidates from an already score-sorted list, but
 * treats near-equal scores as a tie: when the next top-scored remaining
 * candidate is within TIE_BREAK_SCORE_DELTA of the last pick AND shares its
 * category (e.g. "all hot coffees" now that the shortlist is no longer
 * capped at 2 per category — root cause #2), prefer the highest-scored
 * DIFFERENT-category candidate that's still within that same tie band over
 * it. Score always wins outside a tie — this never demotes a clearly better
 * item just for variety's sake.
 */
function pickWithVarietyTieBreak(sorted: Candidate[], count: number): Candidate[] {
  const remaining = [...sorted];
  const picked: Candidate[] = [];

  while (picked.length < count && remaining.length > 0) {
    const last = picked[picked.length - 1];
    let chosenIndex = 0;

    if (last) {
      const top = remaining[0];
      const isTie = Math.abs(top.score - last.score) <= TIE_BREAK_SCORE_DELTA;
      if (isTie && top.category === last.category) {
        const altIndex = remaining.findIndex(
          (c) => c.category !== last.category && Math.abs(c.score - last.score) <= TIE_BREAK_SCORE_DELTA,
        );
        if (altIndex !== -1) chosenIndex = altIndex;
      }
    }

    picked.push(remaining[chosenIndex]);
    remaining.splice(chosenIndex, 1);
  }

  return picked;
}

/**
 * The deterministic ranking's own top picks (§5.4 "Validation" — what tops
 * up a short Opus response, and what the whole response is when the LLM is
 * skipped). `reasonCode` is the chosen mood when the item is tagged for it;
 * 'popular' needs a popularity signal this function isn't given (that's the
 * scorer's job upstream), so the catch-all here is 'trait'. Variety across
 * the picks is only a TIE-BREAK (§5.3) — the top-scored items still win
 * whenever they're not genuinely close.
 */
export function deterministicPicks(shortlist: Candidate[], inputs: SuggestInputs): SuggestionPick[] {
  const picks = pickWithVarietyTieBreak(shortlist, SUGGEST_LIMITS.picks);
  return picks.map((c) => {
    const reasonCode: SuggestionPick['reasonCode'] = c.traits.moods.includes(inputs.mood) ? inputs.mood : 'trait';
    return {
      menuItemId: c.menuItemId,
      reason: templateReason(c.traits, inputs, reasonCode, c.name),
      reasonCode,
    };
  });
}
