import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { hasPermission } from '@/lib/permissions';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { parseAddonRecipeLines } from '@/lib/inventory/rules';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { optionId: string } };

// PUT /api/inventory/addon-recipes/[optionId] — replace one add-on's recipe:
// what an extra shot or an oat-milk swap uses, per serving it is added to.
// Same gate as item recipes and the menu: 'menu_edit', on the POS.
// Body: { lines: [{ itemId, qty }] } — an empty list clears it.
export async function PUT(request: Request, { params }: RouteParams) {
  const gate = await requireInventoryActor();
  if ('response' in gate) return gate.response;
  if (!isUuid(params.optionId)) return notFound();

  if (!(await hasPermission(gate.actor.user, 'menu_edit', gate.actor.role))) {
    return errorResponse(403, 'You do not have permission to edit recipes');
  }
  if (!canEditMenu(await getStaffSurface())) return errorResponse(403, MENU_POS_ONLY_MESSAGE);

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = parseAddonRecipeLines(body.lines, isUuid);
  if (!parsed.ok) return errorResponse(400, parsed.message);

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc('inventory_set_addon_recipe', {
    p_option_id: params.optionId,
    p_actor: gate.actor.user.id,
    p_lines: parsed.lines.map((l) => ({ item_id: l.itemId, qty: l.qty })),
  });
  if (error) {
    if (/add-on not found/.test(error.message ?? '')) return notFound();
    return inventoryWriteFailure(error, 'Saving the add-on recipe');
  }
  return NextResponse.json({ ok: true, lines: Number(data) || 0 });
}
