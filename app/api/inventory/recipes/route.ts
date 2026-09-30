import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { hasPermission } from '@/lib/permissions';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu } from '@/lib/staff/surfaceRules';
import { requireInventoryActor } from '@/lib/inventory/api';
import { INVENTORY_MIGRATION_HINT, selectAll } from '@/lib/inventory/server';

export const dynamic = 'force-dynamic';

// GET /api/inventory/recipes — every counter actor (INV-5). The recipe
// editor's whole world in one read: every menu item with its sizes, every
// add-on, every stock item, and every recipe line (items and add-ons). `canEdit` mirrors the PUT gate — the
// same one as the menu itself: the 'menu_edit' permission, on the POS.
// An add-on's lines here are its GENERAL ones only (no menu item): that is
// what the editor edits and what PUT addon-recipes replaces. The per-item /
// per-size lines the recipe book adds (2026-10-inventory-addon-scopes.sql)
// are not sent — `addonScopedCounts` only says how many an add-on has, so the
// screen can say they exist.
//
// The four line/item lists are read in pages (selectAll): PostgREST returns at
// most 1,000 rows per request and does not say when it stops, and the real
// recipe book is well past that in recipe_lines. A partial list here would open
// the editor on half a recipe, and saving it would delete the rest. The menu
// and the add-on groups are one row per menu item / group (about a hundred
// between them), so they stay single reads.
export async function GET() {
  const gate = await requireInventoryActor();
  if ('response' in gate) return gate.response;

  const admin = createAdminSupabaseClient();
  const [menuRes, itemsRes, linesRes, addonsRes, addonLinesRes, addonScopedRes, surface, mayEdit] = await Promise.all([
    admin
      .from('menu_items')
      .select('id, name, category, sort_order, menu_item_variants(id, label, sort_order)')
      .order('category')
      .order('sort_order'),
    selectAll<{ id: string; name: string; unit: string; is_active: boolean }>(() =>
      admin.from('inventory_items').select('id, name, unit, is_active').order('name').order('id'),
    ),
    selectAll<{ menu_item_id: string; size_label: string; item_id: string; qty: number }>(() =>
      admin.from('recipe_lines').select('menu_item_id, size_label, item_id, qty').order('id'),
    ),
    admin
      .from('addon_groups')
      .select('id, display_name, sort_order, addon_options(id, name, sort_order)')
      .order('sort_order'),
    selectAll<{ addon_option_id: string; item_id: string; qty: number }>(() =>
      admin.from('addon_recipe_lines').select('addon_option_id, item_id, qty').is('menu_item_id', null).order('id'),
    ),
    selectAll<{ addon_option_id: string }>(() =>
      admin.from('addon_recipe_lines').select('addon_option_id').not('menu_item_id', 'is', null).order('id'),
    ),
    getStaffSurface(),
    hasPermission(gate.actor.user, 'menu_edit', gate.actor.role),
  ]);
  if (menuRes.error || itemsRes.error || linesRes.error || addonsRes.error || addonLinesRes.error || addonScopedRes.error) {
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
      .map((v) => ({ id: v.id, label: v.label.trim() })),
  }));
  const items = (itemsRes.data ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    unit: i.unit,
    isActive: i.is_active,
  }));
  const lines = (linesRes.data ?? []).map((l) => ({
    menuItemId: l.menu_item_id,
    sizeLabel: l.size_label,
    itemId: l.item_id,
    qty: Number(l.qty),
  }));
  type AddonGroupRow = {
    id: string;
    display_name: string;
    addon_options: { id: string; name: string; sort_order: number }[] | null;
  };
  const addons = ((addonsRes.data ?? []) as AddonGroupRow[]).flatMap((g) =>
    [...(g.addon_options ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((o) => ({ id: o.id, name: o.name, group: g.display_name })),
  );
  const addonLines = (addonLinesRes.data ?? []).map((l) => ({
    optionId: l.addon_option_id,
    itemId: l.item_id,
    qty: Number(l.qty),
  }));

  const addonScopedCounts: Record<string, number> = {};
  for (const l of addonScopedRes.data ?? []) {
    addonScopedCounts[l.addon_option_id] = (addonScopedCounts[l.addon_option_id] ?? 0) + 1;
  }

  return NextResponse.json({ menu, addons, items, lines, addonLines, addonScopedCounts, canEdit: mayEdit && canEditMenu(surface) });
}
