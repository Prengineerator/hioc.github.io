import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isMenuCategory, isUuid, MENU_CATEGORIES } from '@/lib/api/constants';
import type { AddonGroup, MenuItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

const MENU_ITEM_SELECT = `
  *,
  menu_item_variants(*),
  menu_item_addon_groups(
    addon_groups(*, options:addon_options(*))
  )
`;

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

// PATCH /api/menu/[id] — staff-only. Partial update.
// `variants`, if present, fully replaces the item's variant list.
// `addon_group_ids`, if present, fully replaces the item's addon group associations.
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const updates: Partial<
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
    >
  > = {};

  if ('name' in body) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return errorResponse(400, 'name must be a non-empty string');
    }
    updates.name = body.name.trim();
  }

  if ('description' in body) {
    if (typeof body.description !== 'string') {
      return errorResponse(400, 'description must be a string');
    }
    updates.description = body.description;
  }

  if ('category' in body) {
    if (!isMenuCategory(body.category)) {
      return errorResponse(
        400,
        `category must be one of: ${MENU_CATEGORIES.join(', ')}`,
      );
    }
    updates.category = body.category;
  }

  if ('parent_category' in body) {
    if (typeof body.parent_category !== 'string') {
      return errorResponse(400, 'parent_category must be a string');
    }
    updates.parent_category = body.parent_category;
  }

  if ('is_veg' in body) {
    if (typeof body.is_veg !== 'boolean') {
      return errorResponse(400, 'is_veg must be a boolean');
    }
    updates.is_veg = body.is_veg;
  }

  if ('is_available' in body) {
    if (typeof body.is_available !== 'boolean') {
      return errorResponse(400, 'is_available must be a boolean');
    }
    updates.is_available = body.is_available;
  }

  if ('sort_order' in body) {
    if (typeof body.sort_order !== 'number' || !Number.isInteger(body.sort_order)) {
      return errorResponse(400, 'sort_order must be an integer');
    }
    updates.sort_order = body.sort_order;
  }

  if ('image_url' in body) {
    if (typeof body.image_url !== 'string') {
      return errorResponse(400, 'image_url must be a string');
    }
    updates.image_url = body.image_url;
  }

  // unavailable_until (S6 86/snooze): ISO date string or null (re-enable).
  if ('unavailable_until' in body) {
    if (
      body.unavailable_until !== null &&
      (typeof body.unavailable_until !== 'string' || Number.isNaN(Date.parse(body.unavailable_until)))
    ) {
      return errorResponse(400, 'unavailable_until must be an ISO date string or null');
    }
    updates.unavailable_until = body.unavailable_until as string | null;
  }

  let variants: { label: string; price_inr: number }[] | undefined;
  if ('variants' in body) {
    if (
      !Array.isArray(body.variants) ||
      body.variants.length === 0 ||
      body.variants.some(
        (v: unknown) =>
          typeof (v as { label?: unknown })?.label !== 'string' ||
          (v as { label: string }).label.trim().length === 0 ||
          typeof (v as { price_inr?: unknown })?.price_inr !== 'number' ||
          !Number.isInteger((v as { price_inr: number }).price_inr) ||
          (v as { price_inr: number }).price_inr < 0,
      )
    ) {
      return errorResponse(
        400,
        'variants must be a non-empty array of { label: string, price_inr: non-negative integer }',
      );
    }
    variants = body.variants;
  }

  let addonGroupIds: string[] | undefined;
  if ('addon_group_ids' in body) {
    if (!Array.isArray(body.addon_group_ids) || body.addon_group_ids.some((v: unknown) => typeof v !== 'string')) {
      return errorResponse(400, 'addon_group_ids must be an array of strings');
    }
    addonGroupIds = body.addon_group_ids;
  }

  const admin = createAdminSupabaseClient();

  if (Object.keys(updates).length > 0) {
    const { error: updateError, data: updated } = await admin
      .from('menu_items')
      .update(updates)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (updateError) {
      return errorResponse(500, 'Failed to update menu item');
    }
    if (!updated) {
      return notFound();
    }
  }

  if (variants) {
    const { error: deleteError } = await admin
      .from('menu_item_variants')
      .delete()
      .eq('menu_item_id', id);
    if (deleteError) {
      return errorResponse(500, 'Failed to replace menu item variants');
    }
    const { error: insertError } = await admin.from('menu_item_variants').insert(
      variants.map((v, i) => ({
        menu_item_id: id,
        label: v.label.trim(),
        price_inr: v.price_inr,
        sort_order: i * 10,
      })),
    );
    if (insertError) {
      return errorResponse(500, 'Failed to replace menu item variants');
    }
  }

  if (addonGroupIds) {
    const { error: deleteError } = await admin
      .from('menu_item_addon_groups')
      .delete()
      .eq('menu_item_id', id);
    if (deleteError) {
      return errorResponse(500, 'Failed to replace addon group associations');
    }
    if (addonGroupIds.length > 0) {
      const { error: insertError } = await admin.from('menu_item_addon_groups').insert(
        addonGroupIds.map((addon_group_id) => ({ menu_item_id: id, addon_group_id })),
      );
      if (insertError) {
        return errorResponse(500, 'Failed to replace addon group associations');
      }
    }
  }

  const { data, error } = await admin
    .from('menu_items')
    .select(MENU_ITEM_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to load menu item');
  }
  if (!data) {
    return notFound();
  }

  return NextResponse.json({ item: shapeMenuItem(data as unknown as MenuItemRow) });
}

// DELETE /api/menu/[id] — staff-only. Hard delete (variants, addon links
// cascade via FK; order_items keep a snapshot so past orders are unaffected).
export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('menu_items')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to delete menu item');
  }
  if (!data) {
    return notFound();
  }

  return NextResponse.json({ deleted: true, id });
}
