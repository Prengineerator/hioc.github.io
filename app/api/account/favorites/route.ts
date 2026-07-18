import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import type { AddonGroup, MenuItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

const FAVORITES_SELECT = `
  menu_item_id,
  created_at,
  menu_items (
    *,
    menu_item_variants(*),
    menu_item_addon_groups(
      addon_groups(*, options:addon_options(*))
    )
  )
`;

type MenuItemRow = Omit<MenuItem, 'variants' | 'addon_groups'> & {
  menu_item_variants: MenuItem['variants'];
  menu_item_addon_groups: { addon_groups: AddonGroup | null }[];
};

function shapeMenuItem(row: MenuItemRow): MenuItem {
  const { menu_item_variants, menu_item_addon_groups, ...rest } = row;
  const variants = [...(menu_item_variants ?? [])].sort((a, b) => a.sort_order - b.sort_order);
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

// GET /api/account/favorites — the caller's saved items, joined with their
// current menu row (ACC-5) so the favorites page can render + add-to-cart
// directly. Items that were deleted from the menu entirely come back with
// `item: null` and are filtered client-side.
export async function GET() {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('favorites')
    .select(FAVORITES_SELECT)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return errorResponse(500, 'Failed to load favorites');
  }

  const favorites = (data ?? []).map((row) => {
    const r = row as unknown as {
      menu_item_id: string;
      created_at: string;
      menu_items: MenuItemRow | null;
    };
    return {
      menu_item_id: r.menu_item_id,
      created_at: r.created_at,
      item: r.menu_items ? shapeMenuItem(r.menu_items) : null,
    };
  });

  return NextResponse.json({ favorites });
}

// POST /api/account/favorites — heart an item. Body: { menu_item_id }.
// Idempotent (upsert on the composite PK).
export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { menu_item_id } = body;
  if (!isUuid(menu_item_id)) {
    return errorResponse(400, 'menu_item_id must be a valid uuid');
  }

  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from('favorites')
    .upsert({ user_id: user.id, menu_item_id }, { onConflict: 'user_id,menu_item_id' });

  if (error) {
    return errorResponse(500, 'Failed to save favorite');
  }

  return NextResponse.json({ success: true }, { status: 201 });
}
