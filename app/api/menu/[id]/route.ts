import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import {
  applyMenuDelete,
  applyMenuUpdate,
  failureResponse,
  validateUpdateBody,
} from '@/lib/menu/applyMenuChange';
import {
  cancelOrphanedRequests,
  createChangeRequest,
  diffChangePayload,
  isAvailabilityOnly,
  loadItemSnapshot,
  proposedFromUpdate,
} from '@/lib/menu/changeRequests';
import type { MenuChangePendingResponse } from '@/lib/menu/changeRequestTypes';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/menu/[id] — staff-only. Partial update — this is ALSO the S6
// availability toggle / snooze path (`is_available`, `unavailable_until`),
// same route and same gate as a full edit.
// `variants`, if present, fully replaces the item's variant list.
// `addon_group_ids`, if present, fully replaces the item's addon group associations.
//
// PIN-3: gated by getCounterActor() — classic session first, unchanged; an
// enrolled-device PIN operator only when there is no session at all.
//
// Menu changes need the owner's approval (lib/menu/changeRequests.ts). These
// apply at once, answered 200 { item }: the owner's own edit, and a change that
// only flips sold-out / snooze (whoever makes it — the counter must be able to
// 86 an item mid-service). Any other edit by staff or a manager is stored as a
// pending request holding just the fields that differ, answered 202
// { pending: true, request }.
export async function PATCH(request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) {
    return unauthorized();
  }
  const user = actor.user;
  // FND3-6: menu edits go through the owner-configurable 'menu_edit' gate
  // (default = staff-and-up, preserving prior behavior). roleHint = actor.role,
  // see the POST handler's sibling note in ../route.ts.
  if (!(await hasPermission(user, 'menu_edit', actor.role))) {
    return errorResponse(403, 'You do not have permission to edit the menu');
  }

  // Menu changes are made on the POS only (the staff website shows the menu
  // read-only) — see lib/staff/surfaceRules.ts.
  if (!canEditMenu(await getStaffSurface())) {
    return errorResponse(403, MENU_POS_ONLY_MESSAGE);
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const checked = validateUpdateBody(body);
  if (!checked.ok) {
    return failureResponse(checked);
  }
  let values = checked.value;

  const admin = createAdminSupabaseClient();

  // An edit that is only a sold-out / snooze toggle needs no approval, nor does
  // anything the owner does. Everything else becomes a request.
  const toggleOnly = isAvailabilityOnly({
    ...values.updates,
    variants: values.variants,
    addon_group_ids: values.addonGroupIds,
  });

  if (actor.role !== 'owner' && !toggleOnly) {
    if ('unavailable_until' in values.updates) {
      return errorResponse(400, 'Sold out and snooze changes cannot be combined with other edits.');
    }

    const snapshot = await loadItemSnapshot(admin, id);
    if (!snapshot.ok) {
      return failureResponse(snapshot);
    }
    const changes = diffChangePayload(snapshot.value, proposedFromUpdate(values));
    if (Object.keys(changes).length === 0) {
      return errorResponse(400, 'No changes to send');
    }

    // A full edit form that only moved the availability switch is still a toggle.
    if (isAvailabilityOnly(changes)) {
      values = { updates: { is_available: changes.is_available } };
    } else {
      const stored = await createChangeRequest(admin, {
        action: 'update',
        menuItemId: id,
        itemName: snapshot.value.name ?? '',
        payload: changes,
        snapshot: snapshot.value,
        requestedBy: user.id,
      });
      if (!stored.ok) {
        return failureResponse(stored);
      }
      const pending: MenuChangePendingResponse = { pending: true, request: stored.value };
      return NextResponse.json(pending, { status: 202 });
    }
  }

  const updated = await applyMenuUpdate(admin, id, values);
  if (!updated.ok) {
    return failureResponse(updated);
  }

  return NextResponse.json({ item: updated.value });
}

// DELETE /api/menu/[id] — staff-only. Hard delete (variants, addon links
// cascade via FK; order_items keep a snapshot so past orders are unaffected).
//
// PIN-3: gated by getCounterActor() — classic session first, unchanged; an
// enrolled-device PIN operator only when there is no session at all.
//
// Only the owner's delete applies at once; a staff member's or manager's is a
// pending request (202 { pending: true, request }) for the owner to approve.
export async function DELETE(_request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) {
    return unauthorized();
  }
  // FND3-6: menu edits go through the owner-configurable 'menu_edit' gate
  // (default = staff-and-up, preserving prior behavior). roleHint = actor.role.
  if (!(await hasPermission(actor.user, 'menu_edit', actor.role))) {
    return errorResponse(403, 'You do not have permission to edit the menu');
  }

  // Menu changes are made on the POS only (the staff website shows the menu
  // read-only) — see lib/staff/surfaceRules.ts.
  if (!canEditMenu(await getStaffSurface())) {
    return errorResponse(403, MENU_POS_ONLY_MESSAGE);
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const admin = createAdminSupabaseClient();

  if (actor.role !== 'owner') {
    const snapshot = await loadItemSnapshot(admin, id);
    if (!snapshot.ok) {
      return failureResponse(snapshot);
    }
    const stored = await createChangeRequest(admin, {
      action: 'delete',
      menuItemId: id,
      itemName: snapshot.value.name ?? '',
      payload: null,
      snapshot: snapshot.value,
      requestedBy: actor.user.id,
    });
    if (!stored.ok) {
      return failureResponse(stored);
    }
    const pending: MenuChangePendingResponse = { pending: true, request: stored.value };
    return NextResponse.json(pending, { status: 202 });
  }

  const deleted = await applyMenuDelete(admin, id);
  if (!deleted.ok) {
    return failureResponse(deleted);
  }
  await cancelOrphanedRequests(admin);

  return NextResponse.json({ deleted: true, id });
}
