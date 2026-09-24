// Pure customization logic shared by the customer MenuItemCustomizeModal and
// the staff PosCustomizeModal. Kept dependency-free (no React) so it can be
// unit-tested directly (tests/menuCustomization.test.ts) and so the two
// modals literally cannot drift on the variant/addon selection rules — see
// the header comment on PosCustomizeModal.tsx for why that matters.

import type { CartAddonSelection } from '@/lib/cart/CartContext';
import type { AddonGroup, MenuItem } from '@/lib/types';

// Mirrors app/api/orders/route.ts MAX_INSTRUCTION_LENGTH.
export const MAX_INSTRUCTIONS_LEN = 200;

/** A group must be answered before the item can be added to the cart/order. */
export function isRequired(group: AddonGroup): boolean {
  return group.min_select > 0;
}

/** Long-form selection rule, e.g. "Choose 2–3". Used for a11y descriptions. */
export function selectionLabel(group: AddonGroup): string {
  if (group.min_select === group.max_select) {
    return `Choose exactly ${group.min_select}`;
  }
  if (group.min_select === 0) {
    return `Choose up to ${group.max_select}`;
  }
  return `Choose ${group.min_select}–${group.max_select}`;
}

/** Compact form of the same rule for the group header pill, e.g. "Up to 3". */
export function compactHint(group: AddonGroup): string {
  const { min_select: min, max_select: max } = group;
  if (min === max) return `Pick ${min}`;
  if (min === 0) return `Up to ${max}`;
  return `Pick ${min}–${max}`;
}

// A "sensible default" name — the option a customer would pick if they had no
// preference (as opposed to an upsell/upgrade). Matched case-insensitively at
// the start of the option name so e.g. "Normal Ice" and "Normal" both count.
const DEFAULT_NAME_RE = /^(normal|default|regular|standard|classic)\b/i;

/**
 * Prefill for a required group (min_select > 0); [] for an optional one —
 * customers shouldn't have to answer a question the menu already has an
 * obvious answer to (e.g. "Choice of Sugar" defaults to "Normal"), while
 * optional add-ons/upsells stay opt-in.
 *
 * Ranking: (a) free options whose name reads like a "no preference" default
 * (Normal/Default/Regular/Standard/Classic), (b) other free options, (c)
 * everything else by ascending price — each tier keeping the menu's own
 * sort_order. The first min_select ids from that ranking are prefilled,
 * capped by both the option count and max_select; a single-select group
 * never gets more than one.
 */
export function defaultOptionIds(group: AddonGroup): string[] {
  if (!isRequired(group) || group.options.length === 0) return [];

  const byOrder = [...group.options].sort((a, b) => a.sort_order - b.sort_order);
  const namedDefaults = byOrder.filter((o) => o.price_inr === 0 && DEFAULT_NAME_RE.test(o.name));
  const otherFree = byOrder.filter((o) => o.price_inr === 0 && !DEFAULT_NAME_RE.test(o.name));
  const paid = byOrder
    .filter((o) => o.price_inr > 0)
    .sort((a, b) => a.price_inr - b.price_inr || a.sort_order - b.sort_order);

  const ranked = [...namedDefaults, ...otherFree, ...paid];
  const take = Math.min(
    group.min_select,
    group.options.length,
    group.max_select,
    group.selection_type === 'single' ? 1 : Infinity,
  );
  return ranked.slice(0, take).map((o) => o.id);
}

/** Builds the modal's initial selection state: prefilled required groups, empty optional ones. */
export function initialSelection(item: MenuItem): Record<string, string[]> {
  const selection: Record<string, string[]> = {};
  for (const group of item.addon_groups) {
    selection[group.id] = defaultOptionIds(group);
  }
  return selection;
}

/**
 * Applies a tap on `optionId` within `group`. Single-select replaces the
 * current pick (deselecting back to nothing only when the group is
 * optional); multi-select toggles the option, refusing to add past max_select.
 */
export function toggleOption(
  selection: Record<string, string[]>,
  group: AddonGroup,
  optionId: string,
): Record<string, string[]> {
  const current = selection[group.id] ?? [];
  if (group.selection_type === 'single') {
    const next = current[0] === optionId && group.min_select === 0 ? [] : [optionId];
    return { ...selection, [group.id]: next };
  }
  const isSelected = current.includes(optionId);
  if (isSelected) {
    return { ...selection, [group.id]: current.filter((id) => id !== optionId) };
  }
  if (current.length >= group.max_select) {
    return selection;
  }
  return { ...selection, [group.id]: [...current, optionId] };
}

/** Flattens the selection into the shape the cart/order API expects. */
export function flattenAddons(
  item: MenuItem,
  selection: Record<string, string[]>,
): CartAddonSelection[] {
  const flat: CartAddonSelection[] = [];
  for (const group of item.addon_groups) {
    const ids = selection[group.id] ?? [];
    for (const id of ids) {
      const option = group.options.find((o) => o.id === id);
      if (option) {
        flat.push({
          optionId: option.id,
          groupName: group.display_name,
          optionName: option.name,
          priceInr: option.price_inr,
        });
      }
    }
  }
  return flat;
}

/** Groups whose current selection violates their min/max_select rule. */
export function invalidGroups(item: MenuItem, selection: Record<string, string[]>): AddonGroup[] {
  return item.addon_groups.filter((group) => {
    const count = (selection[group.id] ?? []).length;
    return count < group.min_select || count > group.max_select;
  });
}
