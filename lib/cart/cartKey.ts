// A cart line is uniquely identified by item + variant + the exact set of
// chosen addon options + the special-instructions text (C4) — ordering the
// same drink two different ways (e.g. Large with oat milk vs. Large with no
// milk addon, or "extra hot" vs "no sugar") must be two separate cart lines,
// not one that silently overwrites/merges the other. Two lines with the same
// item/variant/addons but *identical* instructions text still merge (same
// key), matching the pre-existing addon-merge behavior.
//
// A sold-by-weight line's grams (lib/menu/weight.ts) are part of it too: a
// 250 g bag and a 500 g bag are two lines, two 250 g bags are one line ×2. The
// suffix is only added for a weighed line, so every other key is unchanged.
export function computeCartKey(
  menuItemId: string,
  variantId: string,
  addonOptionIds: string[],
  specialInstructions = '',
  weightGrams?: number | null,
): string {
  const sorted = [...addonOptionIds].sort();
  const base = `${menuItemId}::${variantId}::${sorted.join(',')}::${specialInstructions.trim()}`;
  return weightGrams == null ? base : `${base}::${weightGrams}g`;
}
