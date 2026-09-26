import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { hasPermission } from '@/lib/permissions';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { parseRecipeLines } from '@/lib/inventory/rules';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { menuItemId: string } };

// PUT /api/inventory/recipes/[menuItemId] — replace one menu item's recipe
// (INV-5). Same gate as editing the menu: 'menu_edit', on the POS.
// Body: { lines: [{ variantId: string | null, itemId, qty }] } — what ONE
// unit uses; variantId null is the base recipe, a size's own lines replace
// it for that size. An empty list clears the recipe.
export async function PUT(request: Request, { params }: RouteParams) {
  const gate = await requireInventoryActor();
  if ('response' in gate) return gate.response;
  if (!isUuid(params.menuItemId)) return notFound();

  if (!(await hasPermission(gate.actor.user, 'menu_edit', gate.actor.role))) {
    return errorResponse(403, 'You do not have permission to edit recipes');
  }
  if (!canEditMenu(await getStaffSurface())) return errorResponse(403, MENU_POS_ONLY_MESSAGE);

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const admin = createAdminSupabaseClient();
  const { data: menuItem, error: readError } = await admin
    .from('menu_items')
    .select('id, menu_item_variants(id)')
    .eq('id', params.menuItemId)
    .maybeSingle();
  if (readError) return inventoryWriteFailure(readError, 'Loading the menu item');
  if (!menuItem) return notFound();

  const variantIds = new Set(
    ((menuItem as { menu_item_variants: { id: string }[] | null }).menu_item_variants ?? []).map((v) => v.id),
  );
  const parsed = parseRecipeLines(body.lines, isUuid, variantIds);
  if (!parsed.ok) return errorResponse(400, parsed.message);

  const { data, error } = await admin.rpc('inventory_set_recipe', {
    p_menu_item_id: params.menuItemId,
    p_actor: gate.actor.user.id,
    p_lines: parsed.lines.map((l) => ({ variant_id: l.variantId, item_id: l.itemId, qty: l.qty })),
  });
  if (error) return inventoryWriteFailure(error, 'Saving the recipe');
  return NextResponse.json({ ok: true, lines: Number(data) || 0 });
}
