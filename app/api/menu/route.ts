import { NextResponse } from 'next/server';
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isMenuCategory, MENU_CATEGORIES } from '@/lib/api/constants';
import type { AddonGroup, MenuItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Nested-select shape returned by Supabase for the query in GET below.
type MenuItemRow = Omit<MenuItem, 'variants' | 'addon_groups'> & {
  menu_item_variants: MenuItem['variants'];
  menu_item_addon_groups: { addon_groups: AddonGroup | null }[];
};

function shapeMenuItem(row: MenuItemRow): MenuItem {
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

const MENU_ITEM_SELECT = `
  *,
  menu_item_variants(*),
  menu_item_addon_groups(
    addon_groups(*, options:addon_options(*))
  )
`;

// GET /api/menu — public. Optional ?category=... and ?includeUnavailable=true.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const categoryParam = searchParams.get('category');
  if (categoryParam !== null && !isMenuCategory(categoryParam)) {
    return errorResponse(
      400,
      `Invalid category. Must be one of: ${MENU_CATEGORIES.join(', ')}`,
    );
  }

  const includeUnavailable = searchParams.get('includeUnavailable') === 'true';

  // Public menu reads go through the anon-key client — RLS's
  // `*_public_read` select policies (using (true)) cover this.
  const supabase = createServerSupabaseClient();

  let query = supabase
    .from('menu_items')
    .select(MENU_ITEM_SELECT)
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true });

  if (categoryParam) {
    query = query.eq('category', categoryParam);
  }
  if (!includeUnavailable) {
    query = query.eq('is_available', true);
  }

  const { data, error } = await query;

  if (error) {
    return errorResponse(500, 'Failed to load menu');
  }

  const items = (data ?? []).map((row) => shapeMenuItem(row as unknown as MenuItemRow));

  return NextResponse.json({ items });
}

// POST /api/menu — staff-only.
export async function POST(request: Request) {
  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

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
  } = body;

  if (typeof name !== 'string' || name.trim().length === 0) {
    return errorResponse(400, 'name is required and must be a non-empty string');
  }

  if (!isMenuCategory(category)) {
    return errorResponse(
      400,
      `category is required and must be one of: ${MENU_CATEGORIES.join(', ')}`,
    );
  }

  if (description !== undefined && typeof description !== 'string') {
    return errorResponse(400, 'description must be a string');
  }

  if (parent_category !== undefined && typeof parent_category !== 'string') {
    return errorResponse(400, 'parent_category must be a string');
  }

  if (is_veg !== undefined && typeof is_veg !== 'boolean') {
    return errorResponse(400, 'is_veg must be a boolean');
  }

  if (is_available !== undefined && typeof is_available !== 'boolean') {
    return errorResponse(400, 'is_available must be a boolean');
  }

  if (
    sort_order !== undefined &&
    (typeof sort_order !== 'number' || !Number.isInteger(sort_order))
  ) {
    return errorResponse(400, 'sort_order must be an integer');
  }

  if (
    !Array.isArray(variants) ||
    variants.length === 0 ||
    variants.some(
      (v) =>
        typeof v?.label !== 'string' ||
        v.label.trim().length === 0 ||
        typeof v?.price_inr !== 'number' ||
        !Number.isInteger(v.price_inr) ||
        v.price_inr < 0,
    )
  ) {
    return errorResponse(
      400,
      'variants is required and must be a non-empty array of { label: string, price_inr: non-negative integer }',
    );
  }

  if (
    addon_group_ids !== undefined &&
    (!Array.isArray(addon_group_ids) || addon_group_ids.some((id) => typeof id !== 'string'))
  ) {
    return errorResponse(400, 'addon_group_ids must be an array of strings');
  }

  const admin = createAdminSupabaseClient();

  const { data: item, error: itemError } = await admin
    .from('menu_items')
    .insert({
      name: name.trim(),
      description: description ?? '',
      category,
      parent_category: parent_category ?? '',
      is_veg: is_veg ?? true,
      is_available: is_available ?? true,
      sort_order: sort_order ?? 0,
    })
    .select()
    .single();

  if (itemError || !item) {
    return errorResponse(500, 'Failed to create menu item');
  }

  const { error: variantsError } = await admin.from('menu_item_variants').insert(
    variants.map((v: { label: string; price_inr: number }, i: number) => ({
      menu_item_id: item.id,
      label: v.label.trim(),
      price_inr: v.price_inr,
      sort_order: i * 10,
    })),
  );

  if (variantsError) {
    await admin.from('menu_items').delete().eq('id', item.id);
    return errorResponse(500, 'Failed to create menu item variants');
  }

  if (Array.isArray(addon_group_ids) && addon_group_ids.length > 0) {
    const { error: addonError } = await admin.from('menu_item_addon_groups').insert(
      addon_group_ids.map((addon_group_id: string) => ({
        menu_item_id: item.id,
        addon_group_id,
      })),
    );
    if (addonError) {
      await admin.from('menu_items').delete().eq('id', item.id);
      return errorResponse(500, 'Failed to associate addon groups');
    }
  }

  const { data: full, error: fetchError } = await admin
    .from('menu_items')
    .select(MENU_ITEM_SELECT)
    .eq('id', item.id)
    .single();

  if (fetchError || !full) {
    return errorResponse(500, 'Created item but failed to load it back');
  }

  return NextResponse.json(
    { item: shapeMenuItem(full as unknown as MenuItemRow) },
    { status: 201 },
  );
}
