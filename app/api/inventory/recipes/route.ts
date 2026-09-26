import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { hasPermission } from '@/lib/permissions';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu } from '@/lib/staff/surfaceRules';
import { requireInventoryActor } from '@/lib/inventory/api';
import { INVENTORY_MIGRATION_HINT } from '@/lib/inventory/server';

export const dynamic = 'force-dynamic';

// GET /api/inventory/recipes — every counter actor (INV-5). The recipe
// editor's whole world in one read: every menu item with its sizes, every
// stock item, and every recipe line. `canEdit` mirrors the PUT gate — the
// same one as the menu itself: the 'menu_edit' permission, on the POS.
export async function GET() {
  const gate = await requireInventoryActor();
  if ('response' in gate) return gate.response;

  const admin = createAdminSupabaseClient();
  const [menuRes, itemsRes, linesRes, surface, mayEdit] = await Promise.all([
    admin
      .from('menu_items')
      .select('id, name, category, sort_order, menu_item_variants(id, label, sort_order)')
      .order('category')
      .order('sort_order'),
    admin.from('inventory_items').select('id, name, unit, is_active').order('name'),
    admin.from('recipe_lines').select('menu_item_id, variant_id, item_id, qty'),
    getStaffSurface(),
    hasPermission(gate.actor.user, 'menu_edit', gate.actor.role),
  ]);
  if (menuRes.error || itemsRes.error || linesRes.error) {
    return errorResponse(500, `Could not load recipes — ${INVENTORY_MIGRATION_HINT}`);
  }

  type MenuRow = {
    id: string;
    name: string;
    category: string;
    menu_item_variants: { id: string; label: string; sort_order: number }[] | null;
  };
  const menu = ((menuRes.data ?? []) as MenuRow[]).map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    variants: [...(m.menu_item_variants ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((v) => ({ id: v.id, label: v.label })),
  }));
  const items = ((itemsRes.data ?? []) as { id: string; name: string; unit: string; is_active: boolean }[]).map((i) => ({
    id: i.id,
    name: i.name,
    unit: i.unit,
    isActive: i.is_active,
  }));
  const lines = ((linesRes.data ?? []) as { menu_item_id: string; variant_id: string | null; item_id: string; qty: number }[]).map(
    (l) => ({ menuItemId: l.menu_item_id, variantId: l.variant_id, itemId: l.item_id, qty: Number(l.qty) }),
  );

  return NextResponse.json({ menu, items, lines, canEdit: mayEdit && canEditMenu(surface) });
}
