// A cart line is uniquely identified by item + variant + the exact set of
// chosen addon options + the special-instructions text (C4) — ordering the
// same drink two different ways (e.g. Large with oat milk vs. Large with no
// milk addon, or "extra hot" vs "no sugar") must be two separate cart lines,
// not one that silently overwrites/merges the other. Two lines with the same
// item/variant/addons but *identical* instructions text still merge (same
// key), matching the pre-existing addon-merge behavior.
export function computeCartKey(
  menuItemId: string,
  variantId: string,
  addonOptionIds: string[],
  specialInstructions = '',
): string {
  const sorted = [...addonOptionIds].sort();
  return `${menuItemId}::${variantId}::${sorted.join(',')}::${specialInstructions.trim()}`;
}
