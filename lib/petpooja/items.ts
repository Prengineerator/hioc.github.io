// Petpooja's 'Items' cell is a comma+space separated list of DISTINCT item
// names — no quantities, no per-item prices (verified against the real
// export: a single-item bill at 2x the unit price still lists the item
// once). Each entry is `Name [n]? (Variant)?`: the ' [n]' marker carries no
// usable information (quantity is unknown either way) and is discarded, and
// a trailing '(...)' is the variant label — which can itself contain
// parens, e.g. 'Ginger Orange Honey Tea (Mini(For Store))', so it has to be
// pulled out with balanced matching rather than a naive '\([^)]*\)$' regex.

const MARKER_RE = / \[n\]$/;

function extractTrailingParens(s: string): { rest: string; inside: string } {
  if (!s.endsWith(')')) return { rest: s, inside: '' };
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === ')') depth++;
    else if (c === '(') {
      depth--;
      if (depth === 0) {
        return { rest: s.slice(0, i).trimEnd(), inside: s.slice(i + 1, s.length - 1) };
      }
    }
  }
  return { rest: s, inside: '' }; // unbalanced parens (shouldn't happen) — keep the whole string as the name
}

/**
 * Splits an `Items` cell into its entries. `raw_name` is exactly the
 * comma-split entry (unmodified); `item_name` has the ' [n]' marker and the
 * trailing '(Variant)' stripped; `variant_label` is '' when the entry has
 * no variant, e.g. `"Choco Chip Cupcake"`.
 */
export function splitItems(
  itemsText: string,
): { raw_name: string; item_name: string; variant_label: string }[] {
  if (!itemsText || !itemsText.trim()) return [];
  return itemsText.split(', ').map((raw_name) => {
    const { rest, inside: variant_label } = extractTrailingParens(raw_name);
    const item_name = rest.replace(MARKER_RE, '').trim();
    return { raw_name, item_name, variant_label };
  });
}
