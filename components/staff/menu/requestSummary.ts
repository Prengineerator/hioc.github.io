// Plain-words labels for a menu change request, shared by the pending list on
// the POS menu screen (PendingMenuRequests) and anything else that lists them.

import { MENU_CATEGORIES } from '@/lib/constants';
import type {
  MenuChangeAction,
  MenuChangeRequest,
  MenuItemChangePayload,
} from '@/lib/menu/changeRequestTypes';

export const ACTION_LABEL: Record<MenuChangeAction, string> = {
  create: 'New item',
  update: 'Edit',
  delete: 'Delete',
};

// What each payload field is called on the screen, in the order they're listed.
// parent_category folds into "category" (they change together).
const FIELD_LABEL: [keyof MenuItemChangePayload, string][] = [
  ['name', 'name'],
  ['description', 'description'],
  ['category', 'category'],
  ['parent_category', 'category'],
  ['variants', 'sizes & prices'],
  ['addon_group_ids', 'add-ons'],
  ['is_veg', 'veg / non-veg'],
  ['is_available', 'availability'],
  ['in_store_only', 'in-store only'],
  ['gst_exempt', 'GST'],
  ['sold_by_weight', 'sold by weight'],
  ['short_code', 'quick-add code'],
  ['sort_order', 'sort order'],
  ['image_url', 'photo'],
];

/** The changed fields of an update, in plain words ("name", "sizes & prices"…). */
export function changedFieldLabels(payload: MenuItemChangePayload | null): string[] {
  if (!payload) return [];
  const labels: string[] = [];
  for (const [key, label] of FIELD_LABEL) {
    if (payload[key] !== undefined && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function categoryLabel(slug: string | undefined): string | null {
  if (!slug) return null;
  return MENU_CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
}

function priceRange(payload: MenuItemChangePayload): string | null {
  const prices = (payload.variants ?? []).map((v) => v.price_inr).filter((p) => Number.isFinite(p));
  if (prices.length === 0) return null;
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const unit = payload.sold_by_weight ? '/kg' : '';
  return lo === hi ? `₹${lo}${unit}` : `₹${lo}–₹${hi}${unit}`;
}

/** One short line on what the request would change. */
export function describeChange(request: MenuChangeRequest): string {
  if (request.action === 'delete') return 'Remove from the menu';
  if (request.action === 'create') {
    const p = request.payload ?? {};
    const parts = [categoryLabel(p.category), priceRange(p)].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : 'New menu item';
  }
  const labels = changedFieldLabels(request.payload);
  return labels.length > 0 ? `Changes: ${labels.join(', ')}` : 'Details updated';
}
