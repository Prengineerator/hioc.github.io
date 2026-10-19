// The menu item writes, in one place: validating a create / edit body, writing it,
// deleting, and the photo upload. Three callers share them so a change means the
// same thing whoever makes it:
//   - the staff menu routes, when the owner edits from the POS (and for the
//     sold-out / snooze toggles, which never need approval);
//   - the owner menu routes (app/api/owner/menu/**), edits from the owner app;
//   - the owner approving a request (lib/menu/changeRequests.ts), which replays
//     the stored payload through the same validators and writers.
// Nothing here checks who is asking: the route does that first.

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorResponse } from '@/lib/api/http';
import { isMenuCategory, MENU_CATEGORIES } from '@/lib/api/constants';
import { isInStoreOnlyCategory } from '@/lib/menu/inStore';
import { flags } from '@/lib/flags';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { SELL_BY_WEIGHT_MIGRATION_HINT } from '@/lib/menu/weight';
import type { MenuChangeVariant } from '@/lib/menu/changeRequestTypes';
import type { AddonGroup, MenuItem } from '@/lib/types';

type Admin = SupabaseClient;

/**
 * A failed step: `status`/`message` are what the route answers with, `extra`
 * (when set) is merged into the JSON beside `error`.
 */
export interface Failure {
  ok: false;
  status: number;
  message: string;
  extra?: Record<string, unknown>;
}

export type Outcome<T> = { ok: true; value: T } | Failure;

export function failure(status: number, message: string): Failure {
  return { ok: false, status, message };
}

export function failureResponse(f: Failure) {
  if (f.extra) return NextResponse.json({ error: f.message, ...f.extra }, { status: f.status });
  return errorResponse(f.status, f.message);
}

// ---------------------------------------------------------------------------
// Reading an item back
// ---------------------------------------------------------------------------

// `*` already carries menu_items.pass_eligible (HIOC Ritual, 2026-10-coffee-pass.sql)
// once the column exists, and simply leaves it out before, so the select needs no
// change and a database without the migration keeps serving the menu. See the
// GET in app/api/menu/route.ts for how the field is shaped.
export const MENU_ITEM_SELECT = `
  *,
  menu_item_variants(*),
  menu_item_addon_groups(
    addon_groups(*, options:addon_options(*))
  )
`;

// Nested-select shape returned by Supabase for MENU_ITEM_SELECT.
export type MenuItemRow = Omit<MenuItem, 'variants' | 'addon_groups'> & {
  menu_item_variants: MenuItem['variants'];
  menu_item_addon_groups: { addon_groups: AddonGroup | null }[];
};

export function shapeMenuItem(row: MenuItemRow): MenuItem {
  const { menu_item_variants, menu_item_addon_groups, ...rest } = row;

  const variants = [...(menu_item_variants ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order,
  );

  const addon_groups = (menu_item_addon_groups ?? [])
    .map((link) => link.addon_groups)
    .filter((g): g is AddonGroup => g !== null)
    .map((g) => ({
      ...g,
      options: [...(g.options ?? [])].sort((a, b) => a.sort_order - b.sort_order),
    }))
    .sort((a, b) => a.sort_order - b.sort_order);

  return { ...rest, variants, addon_groups } as MenuItem;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// short_code (2026-07-menu-short-code): optional owner POS shortform. undefined /
// null / blank clears it; otherwise ^[A-Za-z0-9]{1,8}$, stored UPPERCASE. DB
// uniqueness (partial index) is surfaced as a 409 by the insert/update callers.
export function parseShortCode(value: unknown): { code: string | null } | { error: string } {
  if (value === undefined || value === null) return { code: null };
  if (typeof value !== 'string') return { error: 'short_code must be a string' };
  const trimmed = value.trim();
  if (trimmed === '') return { code: null };
  if (!/^[A-Za-z0-9]{1,8}$/.test(trimmed)) {
    return { error: 'short_code must be 1–8 letters or digits' };
  }
  return { code: trimmed.toUpperCase() };
}

function isVariantList(value: unknown): value is { label: string; price_inr: number }[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    !value.some(
      (v: unknown) =>
        typeof (v as { label?: unknown })?.label !== 'string' ||
        (v as { label: string }).label.trim().length === 0 ||
        typeof (v as { price_inr?: unknown })?.price_inr !== 'number' ||
        !Number.isInteger((v as { price_inr: number }).price_inr) ||
        (v as { price_inr: number }).price_inr < 0,
    )
  );
}

function trimVariants(variants: { label: string; price_inr: number }[]): MenuChangeVariant[] {
  return variants.map((v) => ({ label: v.label.trim(), price_inr: v.price_inr }));
}

/** A new item, checked and with its defaults filled in. */
export interface MenuCreateValues {
  name: string;
  description: string;
  category: string;
  parent_category: string;
  is_veg: boolean;
  is_available: boolean;
  sort_order: number;
  image_url: string;
  unavailable_until: string | null;
  short_code: string | null;
  in_store_only: boolean;
  gst_exempt: boolean;
  sold_by_weight: boolean;
  variants: MenuChangeVariant[];
  addon_group_ids: string[];
}

export function validateCreateBody(body: Record<string, unknown>): Outcome<MenuCreateValues> {
  const {
    name,
    description,
    category,
    parent_category,
    is_veg,
    is_available,
    sort_order,
    variants,
    addon_group_ids,
    image_url,
    unavailable_until,
    short_code,
    in_store_only,
    gst_exempt,
    sold_by_weight,
  } = body;

  if (typeof name !== 'string' || name.trim().length === 0) {
    return failure(400, 'name is required and must be a non-empty string');
  }

  if (!isMenuCategory(category)) {
    return failure(400, `category is required and must be one of: ${MENU_CATEGORIES.join(', ')}`);
  }

  if (description !== undefined && typeof description !== 'string') {
    return failure(400, 'description must be a string');
  }

  if (parent_category !== undefined && typeof parent_category !== 'string') {
    return failure(400, 'parent_category must be a string');
  }

  if (is_veg !== undefined && typeof is_veg !== 'boolean') {
    return failure(400, 'is_veg must be a boolean');
  }

  if (is_available !== undefined && typeof is_available !== 'boolean') {
    return failure(400, 'is_available must be a boolean');
  }

  if (in_store_only !== undefined && typeof in_store_only !== 'boolean') {
    return failure(400, 'in_store_only must be a boolean');
  }

  if (gst_exempt !== undefined && typeof gst_exempt !== 'boolean') {
    return failure(400, 'gst_exempt must be a boolean');
  }

  if (sold_by_weight !== undefined && typeof sold_by_weight !== 'boolean') {
    return failure(400, 'sold_by_weight must be a boolean');
  }

  if (
    sort_order !== undefined &&
    (typeof sort_order !== 'number' || !Number.isInteger(sort_order))
  ) {
    return failure(400, 'sort_order must be an integer');
  }

  if (!isVariantList(variants)) {
    return failure(
      400,
      'variants is required and must be a non-empty array of { label: string, price_inr: non-negative integer }',
    );
  }

  if (
    addon_group_ids !== undefined &&
    (!Array.isArray(addon_group_ids) || addon_group_ids.some((id) => typeof id !== 'string'))
  ) {
    return failure(400, 'addon_group_ids must be an array of strings');
  }

  if (image_url !== undefined && typeof image_url !== 'string') {
    return failure(400, 'image_url must be a string');
  }

  // unavailable_until (S6 86/snooze): ISO date string or null.
  if (
    unavailable_until !== undefined &&
    unavailable_until !== null &&
    (typeof unavailable_until !== 'string' || Number.isNaN(Date.parse(unavailable_until)))
  ) {
    return failure(400, 'unavailable_until must be an ISO date string or null');
  }

  const shortCodeResult = parseShortCode(short_code);
  if ('error' in shortCodeResult) {
    return failure(400, shortCodeResult.error);
  }

  return {
    ok: true,
    value: {
      name: name.trim(),
      description: (description as string | undefined) ?? '',
      category,
      parent_category: (parent_category as string | undefined) ?? '',
      is_veg: (is_veg as boolean | undefined) ?? true,
      is_available: (is_available as boolean | undefined) ?? true,
      sort_order: (sort_order as number | undefined) ?? 0,
      image_url: typeof image_url === 'string' ? image_url : '',
      unavailable_until: (unavailable_until as string | null | undefined) ?? null,
      short_code: shortCodeResult.code,
      // An item created in an in-store category is in-store only unless the
      // editor says otherwise explicitly.
      in_store_only: (in_store_only as boolean | undefined) ?? isInStoreOnlyCategory(category),
      gst_exempt: (gst_exempt as boolean | undefined) ?? false,
      sold_by_weight: sold_by_weight === true,
      variants: trimVariants(variants),
      addon_group_ids: (addon_group_ids as string[] | undefined) ?? [],
    },
  };
}

/** The menu_items columns an edit can set. */
export type MenuItemUpdates = Partial<
  Pick<
    MenuItem,
    | 'name'
    | 'description'
    | 'category'
    | 'parent_category'
    | 'is_veg'
    | 'is_available'
    | 'sort_order'
    | 'image_url'
    | 'unavailable_until'
    | 'short_code'
    | 'in_store_only'
    | 'gst_exempt'
    | 'stock_out_auto'
    | 'sold_by_weight'
  >
>;

/**
 * An edit, checked. Only what the body named is here: `variants` and
 * `addonGroupIds` are undefined when the body left them out (present = the
 * whole list is replaced).
 */
export interface MenuUpdateValues {
  updates: MenuItemUpdates;
  variants?: MenuChangeVariant[];
  addonGroupIds?: string[];
}

export function validateUpdateBody(body: Record<string, unknown>): Outcome<MenuUpdateValues> {
  const updates: MenuItemUpdates = {};

  if ('name' in body) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return failure(400, 'name must be a non-empty string');
    }
    updates.name = body.name.trim();
  }

  if ('description' in body) {
    if (typeof body.description !== 'string') {
      return failure(400, 'description must be a string');
    }
    updates.description = body.description;
  }

  if ('category' in body) {
    if (!isMenuCategory(body.category)) {
      return failure(400, `category must be one of: ${MENU_CATEGORIES.join(', ')}`);
    }
    updates.category = body.category;
  }

  if ('parent_category' in body) {
    if (typeof body.parent_category !== 'string') {
      return failure(400, 'parent_category must be a string');
    }
    updates.parent_category = body.parent_category;
  }

  if ('is_veg' in body) {
    if (typeof body.is_veg !== 'boolean') {
      return failure(400, 'is_veg must be a boolean');
    }
    updates.is_veg = body.is_veg;
  }

  if ('is_available' in body) {
    if (typeof body.is_available !== 'boolean') {
      return failure(400, 'is_available must be a boolean');
    }
    updates.is_available = body.is_available;
  }

  if ('in_store_only' in body) {
    if (typeof body.in_store_only !== 'boolean') {
      return failure(400, 'in_store_only must be a boolean');
    }
    updates.in_store_only = body.in_store_only;
  }

  if ('gst_exempt' in body) {
    if (typeof body.gst_exempt !== 'boolean') {
      return failure(400, 'gst_exempt must be a boolean');
    }
    updates.gst_exempt = body.gst_exempt;
  }

  if ('sold_by_weight' in body) {
    if (typeof body.sold_by_weight !== 'boolean') {
      return failure(400, 'sold_by_weight must be a boolean');
    }
    updates.sold_by_weight = body.sold_by_weight;
  }

  if ('sort_order' in body) {
    if (typeof body.sort_order !== 'number' || !Number.isInteger(body.sort_order)) {
      return failure(400, 'sort_order must be an integer');
    }
    updates.sort_order = body.sort_order;
  }

  if ('image_url' in body) {
    if (typeof body.image_url !== 'string') {
      return failure(400, 'image_url must be a string');
    }
    updates.image_url = body.image_url;
  }

  // unavailable_until (S6 86/snooze): ISO date string or null (re-enable).
  if ('unavailable_until' in body) {
    if (
      body.unavailable_until !== null &&
      (typeof body.unavailable_until !== 'string' || Number.isNaN(Date.parse(body.unavailable_until)))
    ) {
      return failure(400, 'unavailable_until must be an ISO date string or null');
    }
    updates.unavailable_until = body.unavailable_until as string | null;
  }

  if ('short_code' in body) {
    const result = parseShortCode(body.short_code);
    if ('error' in result) {
      return failure(400, result.error);
    }
    updates.short_code = result.code;
  }

  let variants: MenuChangeVariant[] | undefined;
  if ('variants' in body) {
    if (!isVariantList(body.variants)) {
      return failure(
        400,
        'variants must be a non-empty array of { label: string, price_inr: non-negative integer }',
      );
    }
    variants = trimVariants(body.variants);
  }

  let addonGroupIds: string[] | undefined;
  if ('addon_group_ids' in body) {
    if (!Array.isArray(body.addon_group_ids) || body.addon_group_ids.some((v: unknown) => typeof v !== 'string')) {
      return failure(400, 'addon_group_ids must be an array of strings');
    }
    addonGroupIds = body.addon_group_ids;
  }

  return { ok: true, value: { updates, variants, addonGroupIds } };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function loadMenuItem(admin: Admin, id: string): Promise<Outcome<MenuItem>> {
  const { data, error } = await admin
    .from('menu_items')
    .select(MENU_ITEM_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return failure(500, 'Failed to load menu item');
  }
  if (!data) {
    return failure(404, 'Not found');
  }
  return { ok: true, value: shapeMenuItem(data as unknown as MenuItemRow) };
}

/**
 * Inserts the item, its sizes and its add-on links, and returns it as the menu
 * reads it. A failure after the item row exists deletes the item again so a
 * half-made item is never left on the menu.
 */
export async function applyMenuCreate(admin: Admin, values: MenuCreateValues): Promise<Outcome<MenuItem>> {
  const { data: item, error: itemError } = await admin
    .from('menu_items')
    .insert({
      name: values.name,
      description: values.description,
      category: values.category,
      parent_category: values.parent_category,
      is_veg: values.is_veg,
      is_available: values.is_available,
      sort_order: values.sort_order,
      image_url: values.image_url,
      unavailable_until: values.unavailable_until,
      short_code: values.short_code,
      in_store_only: values.in_store_only,
      gst_exempt: values.gst_exempt,
      // Only written when on (2026-10-sell-by-weight.sql), so creating an
      // ordinary item works before that migration is applied.
      ...(values.sold_by_weight ? { sold_by_weight: true } : {}),
    })
    .select()
    .single();

  if (itemError || !item) {
    if (itemError?.code === '23505') {
      return failure(409, 'Code already in use');
    }
    if (values.sold_by_weight && isMissingColumnError(itemError)) {
      return failure(409, SELL_BY_WEIGHT_MIGRATION_HINT);
    }
    return failure(500, 'Failed to create menu item');
  }

  const { error: variantsError } = await admin.from('menu_item_variants').insert(
    values.variants.map((v, i) => ({
      menu_item_id: item.id,
      label: v.label,
      price_inr: v.price_inr,
      sort_order: i * 10,
    })),
  );

  if (variantsError) {
    await admin.from('menu_items').delete().eq('id', item.id);
    return failure(500, 'Failed to create menu item variants');
  }

  if (values.addon_group_ids.length > 0) {
    const { error: addonError } = await admin.from('menu_item_addon_groups').insert(
      values.addon_group_ids.map((addon_group_id) => ({
        menu_item_id: item.id,
        addon_group_id,
      })),
    );
    if (addonError) {
      await admin.from('menu_items').delete().eq('id', item.id);
      return failure(500, 'Failed to associate addon groups');
    }
  }

  const full = await loadMenuItem(admin, item.id);
  if (!full.ok) {
    // Roll back like the steps above: reporting a failure while the item stays
    // would make a retry (or an approval put back to pending) create it twice.
    await admin.from('menu_items').delete().eq('id', item.id);
    return failure(500, 'Failed to load the new menu item');
  }
  return full;
}

/**
 * Applies an edit. `variants`, if present, fully replaces the item's variant
 * list; `addonGroupIds`, if present, fully replaces its add-on links.
 */
export async function applyMenuUpdate(
  admin: Admin,
  id: string,
  values: MenuUpdateValues,
): Promise<Outcome<MenuItem>> {
  const updates: MenuItemUpdates = { ...values.updates };
  const { variants, addonGroupIds } = values;

  // Inventory auto-hide (docs/INVENTORY-SPEC.md): a person setting
  // availability by hand takes the item out of stock's hands — it is no
  // longer "hidden by stock", so stock returning won't flip it back on.
  if ('is_available' in updates && flags.inventory) updates.stock_out_auto = false;

  if (Object.keys(updates).length > 0) {
    let { error: updateError, data: updated } = await admin
      .from('menu_items')
      .update(updates)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    // The inventory flag can be on before supabase/2026-10-inventory.sql is
    // applied, and the editor sends sold_by_weight before
    // supabase/2026-10-sell-by-weight.sql is; the menu must keep saving either
    // way. Switching an item TO sold by weight is the one change that needs
    // its migration, so that is refused with the fix rather than dropped.
    if (
      updateError &&
      ('stock_out_auto' in updates || 'sold_by_weight' in updates) &&
      isMissingColumnError(updateError)
    ) {
      delete updates.stock_out_auto;
      if (updates.sold_by_weight !== true) delete updates.sold_by_weight;
      ({ error: updateError, data: updated } = await admin
        .from('menu_items')
        .update(updates)
        .eq('id', id)
        .select('id')
        .maybeSingle());
      if (updateError && updates.sold_by_weight === true && isMissingColumnError(updateError)) {
        return failure(409, SELL_BY_WEIGHT_MIGRATION_HINT);
      }
    }
    if (updateError) {
      if (updateError.code === '23505') {
        return failure(409, 'Code already in use');
      }
      return failure(500, 'Failed to update menu item');
    }
    if (!updated) {
      return failure(404, 'Not found');
    }
  }

  if (variants) {
    const { error: deleteError } = await admin
      .from('menu_item_variants')
      .delete()
      .eq('menu_item_id', id);
    if (deleteError) {
      return failure(500, 'Failed to replace menu item variants');
    }
    const { error: insertError } = await admin.from('menu_item_variants').insert(
      variants.map((v, i) => ({
        menu_item_id: id,
        label: v.label,
        price_inr: v.price_inr,
        sort_order: i * 10,
      })),
    );
    if (insertError) {
      return failure(500, 'Failed to replace menu item variants');
    }
  }

  if (addonGroupIds) {
    const { error: deleteError } = await admin
      .from('menu_item_addon_groups')
      .delete()
      .eq('menu_item_id', id);
    if (deleteError) {
      return failure(500, 'Failed to replace addon group associations');
    }
    if (addonGroupIds.length > 0) {
      const { error: insertError } = await admin.from('menu_item_addon_groups').insert(
        addonGroupIds.map((addon_group_id) => ({ menu_item_id: id, addon_group_id })),
      );
      if (insertError) {
        return failure(500, 'Failed to replace addon group associations');
      }
    }
  }

  return loadMenuItem(admin, id);
}

/**
 * Hard delete (variants, addon links cascade via FK; order_items keep a
 * snapshot so past orders are unaffected). Any request still waiting on the
 * item is cancelled by the caller (cancelOrphanedRequests, changeRequests.ts).
 */
export async function applyMenuDelete(admin: Admin, id: string): Promise<Outcome<{ id: string }>> {
  const { data, error } = await admin
    .from('menu_items')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) {
    return failure(500, 'Failed to delete menu item');
  }
  if (!data) {
    return failure(404, 'Not found');
  }
  return { ok: true, value: { id } };
}

// ---------------------------------------------------------------------------
// Photo upload
// ---------------------------------------------------------------------------

// Public Storage bucket menu item photos land in (S6 photo). Must exist as a
// PUBLIC bucket named exactly this in the Supabase project — created lazily
// below on first upload if the operator hasn't provisioned it yet.
const BUCKET = 'menu-images';
const MAX_BYTES = 2 * 1024 * 1024; // ~2MB
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Reads a multipart/form-data `file` field from the request, validates image
 * mime + size, uploads it to the public `menu-images` bucket and answers 201
 * { url } — the caller saves that onto a menu item's image_url. The route
 * checks who is asking first (staff POS: app/api/menu/upload; owner app:
 * app/api/owner/menu/upload).
 */
export async function uploadMenuImage(request: Request, admin: Admin) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, 'Request must be multipart/form-data with a file field');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return errorResponse(400, 'file field is required');
  }

  const ext = EXT_BY_MIME[file.type];
  if (!ext) {
    return errorResponse(400, 'file must be a JPEG, PNG, WEBP, or GIF image');
  }

  if (file.size > MAX_BYTES) {
    return errorResponse(400, 'file must be 2MB or smaller');
  }

  const path = `${randomUUID()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  let { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: file.type, upsert: false });

  // First-run convenience: if the bucket hasn't been provisioned yet, create
  // it (public, image-only) and retry once rather than hard-failing.
  if (uploadError && /bucket not found/i.test(uploadError.message)) {
    await admin.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX_BYTES });
    ({ error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: file.type, upsert: false }));
  }

  if (uploadError) {
    return errorResponse(500, 'Failed to upload image');
  }

  const { data } = admin.storage.from(BUCKET).getPublicUrl(path);

  return NextResponse.json({ url: data.publicUrl }, { status: 201 });
}
