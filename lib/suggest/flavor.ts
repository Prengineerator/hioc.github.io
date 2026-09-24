// Phase 7 — flavour-preference matching for the 'chocolatey' and 'fruity'
// step-1 extras (owner addition). These are SOFT scoring preferences
// (lib/suggest/score.ts's extras term), never hard filters
// (lib/suggest/filter.ts's composition rule) — a chocolatey request with no
// chocolate drink left over must still get good picks, just not a boosted
// score for this term.
//
// Pure: no Supabase, no 'server-only'.

const CHOCOLATEY_RE = /chocolate|cocoa|choco|nutella|oreo|kitkat|kit-kat|brownie|fudge|truffle/i;
const FRUITY_RE =
  /fruit|berry|berries|citrus|lemon|lime|orange|mango|strawberry|raspberry|blueberry|cranberry|peach|apple|passion|pineapple|kiwi|watermelon|litchi|lychee/i;

function matchesAny(re: RegExp, name: string, flavorNotes: readonly string[]): boolean {
  if (re.test(name)) return true;
  return flavorNotes.some((note) => re.test(note));
}

/** True when the item's name or any flavor note reads as chocolatey. */
export function isChocolatey(name: string, flavorNotes: readonly string[]): boolean {
  return matchesAny(CHOCOLATEY_RE, name, flavorNotes);
}

/** True when the item's name or any flavor note reads as fruity. */
export function isFruity(name: string, flavorNotes: readonly string[]): boolean {
  return matchesAny(FRUITY_RE, name, flavorNotes);
}
