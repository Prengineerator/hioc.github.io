import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import { failureResponse } from '@/lib/menu/applyMenuChange';
import {
  addonPayloadFromValues,
  applyAddonUpdate,
  diffAddonPayload,
  foreignOptionId,
  loadAddonSnapshot,
  validateAddonGroupBody,
} from '@/lib/menu/addonChanges';
import { createAddonChangeRequest } from '@/lib/menu/changeRequests';
import type { MenuChangePendingResponse } from '@/lib/menu/changeRequestTypes';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

const RELOAD = 'This add-on group has changed since you opened it. Close the form, reload, and try again.';

// PATCH /api/addon-groups/[id] — edit an add-on group. Body: the whole add-on
// form, as for POST /api/addon-groups, with each existing option's `id`.
//
//  - Options are edited in place and never removed (past orders, stock recipes
//    and Coffey traits point at them): the list must carry every option the
//    group has now, plus any new ones. Turning an option off is POS → Menu →
//    On / off.
//  - Only what differs from the group as it stands is a change; nothing
//    different is a 400.
//  - Same gates as editing a menu item (PATCH /api/menu/[id]). The owner's edit
//    applies at once (200 { group }); a staff member's or manager's is stored as
//    a pending request with the group's current values as its "before"
//    (202 { pending: true, request }), replacing any older pending edit of the
//    same group.
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
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const checked = validateAddonGroupBody(body);
  if (!checked.ok) return failureResponse(checked);
  const values = checked.value;

  const admin = createAdminSupabaseClient();
  const live = await loadAddonSnapshot(admin, id);
  if (!live.ok) return failureResponse(live);

  const liveIds = new Set((live.value.options ?? []).map((o) => o.id as string));
  if (foreignOptionId(values, liveIds)) return errorResponse(400, RELOAD);
  // The form never drops an option, so one missing means the group gained an
  // option after the form was opened.
  const listed = new Set(values.options.map((o) => o.id).filter(Boolean));
  if ([...liveIds].some((optionId) => !listed.has(optionId))) return errorResponse(400, RELOAD);

  const changes = diffAddonPayload(live.value, addonPayloadFromValues(values));
  if (Object.keys(changes).length === 0) return errorResponse(400, 'No changes to send');

  if (actor.role !== 'owner') {
    const stored = await createAddonChangeRequest(admin, {
      action: 'update',
      addonGroupId: id,
      itemName: live.value.display_name ?? '',
      payload: changes,
      snapshot: live.value,
      requestedBy: actor.user.id,
    });
    if (!stored.ok) return failureResponse(stored);
    const pending: MenuChangePendingResponse = { pending: true, request: stored.value };
    return NextResponse.json(pending, { status: 202 });
  }

  const updated = await applyAddonUpdate(admin, id, changes);
  if (!updated.ok) return failureResponse(updated);
  return NextResponse.json({ group: updated.value });
}
