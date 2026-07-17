// A cart line is uniquely identified by item + variant + the exact set of
// chosen addon options — ordering the same drink two different ways (e.g.
// Large with oat milk vs. Large with no milk addon) must be two separate
// cart lines, not one that silently overwrites the other.
export function computeCartKey(
  menuItemId: string,
  variantId: string,
  addonOptionIds: string[],
): string {
  const sorted = [...addonOptionIds].sort();
  return `${menuItemId}::${variantId}::${sorted.join(',')}`;
}
