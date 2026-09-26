import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/addon-options/[id] — { is_available: boolean }. Switches one add-on
// option off or on (e.g. out of oat milk), POS → Menu → Switches. Like marking
// an item sold out: the 'menu_edit' permission, from the POS only
// (2026-09-menu-switches.sql, lib/menu/menuSwitches.ts).
export async function PATCH(request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  if (!(await hasPermission(actor.user, 'menu_edit', actor.role))) {
    return errorResponse(403, 'You do not have permission to edit the menu');
  }
  if (!canEditMenu(await getStaffSurface())) {
    return errorResponse(403, MENU_POS_ONLY_MESSAGE);
  }

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body || typeof body.is_available !== 'boolean') {
    return errorResponse(400, 'is_available must be true or false');
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('addon_options')
    .update({ is_available: body.is_available })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) return errorResponse(500, 'Failed to update the add-on');
  if (!data) return notFound();

  return NextResponse.json({ option: data });
}
