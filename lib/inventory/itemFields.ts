// Validation for a stock item's editable fields (POST/PATCH
// /api/inventory/items). Pure, so the rules are tested without a route.

import { isInventoryUnit, parseQty, type InventoryUnit } from '@/lib/inventory/rules';

export interface ItemFields {
  name?: string;
  unit?: InventoryUnit;
  category?: string;
  par_level?: number;
  reorder_qty?: number;
  tracks_expiry?: boolean;
  is_active?: boolean;
}

const MAX_NAME = 80;
const MAX_CATEGORY = 40;

/** Accepts camelCase from the screens. `requireAll` (create) needs a name
 * and a unit; an edit sends only what changed. */
export function parseItemFields(
  body: Record<string, unknown>,
  { requireAll }: { requireAll: boolean },
): { ok: true; fields: ItemFields } | { ok: false; message: string } {
  const fields: ItemFields = {};

  if (body.name !== undefined || requireAll) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) return { ok: false, message: 'Give the item a name.' };
    const name = body.name.trim().replace(/\s+/g, ' ');
    if (name.length > MAX_NAME) return { ok: false, message: `Keep the name under ${MAX_NAME} characters.` };
    fields.name = name;
  }
  if (body.unit !== undefined || requireAll) {
    if (!isInventoryUnit(body.unit)) return { ok: false, message: 'Pick a unit: g, kg, ml, l, pcs or pack.' };
    fields.unit = body.unit;
  }
  if (body.category !== undefined) {
    if (typeof body.category !== 'string') return { ok: false, message: 'category must be text.' };
    const category = body.category.trim();
    if (category.length > MAX_CATEGORY) return { ok: false, message: `Keep the category under ${MAX_CATEGORY} characters.` };
    fields.category = category;
  }
  for (const [key, col] of [
    ['parLevel', 'par_level'],
    ['reorderQty', 'reorder_qty'],
  ] as const) {
    if (body[key] === undefined) continue;
    const q = parseQty(body[key], { allowZero: true });
    if (q === null) return { ok: false, message: `${key === 'parLevel' ? 'Low-stock level' : 'Reorder quantity'} must be 0 or more.` };
    fields[col] = q;
  }
  if (body.tracksExpiry !== undefined) {
    if (typeof body.tracksExpiry !== 'boolean') return { ok: false, message: 'tracksExpiry must be true or false.' };
    fields.tracks_expiry = body.tracksExpiry;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { ok: false, message: 'isActive must be true or false.' };
    fields.is_active = body.isActive;
  }
  if (!requireAll && Object.keys(fields).length === 0) return { ok: false, message: 'Nothing to change.' };
  return { ok: true, fields };
}
