import { NextResponse } from 'next/server';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import { failureResponse } from '@/lib/menu/applyMenuChange';
import { addonPayloadFromValues, applyAddonCreate, validateAddonGroupBody } from '@/lib/menu/addonChanges';
import { createAddonChangeRequest } from '@/lib/menu/changeRequests';
import type { MenuChangePendingResponse } from '@/lib/menu/changeRequestTypes';
import type { AddonGroup } from '@/lib/types';

export const dynamic = 'force-dynamic';

// GET /api/addon-groups — public. The full library of customization groups
// (e.g. "Choice of Sugar", "Choose Milk"), used by the staff menu item form
// to pick which groups apply to a given item. Menu browsing itself gets
// addon groups embedded per-item via GET /api/menu, not from this route.
export async function GET() {
  const supabase = createServerSupabaseClient();

  const { data, error } = await supabase
    .from('addon_groups')
    .select('*, options:addon_options(*)')
    .order('sort_order', { ascending: true });

  if (error) {
    return errorResponse(500, 'Failed to load addon groups');
  }

  const groups = (data ?? []).map((g) => ({
    ...g,
    options: [...(g.options ?? [])].sort(
      (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order,
    ),
  })) as AddonGroup[];

  return NextResponse.json({ addonGroups: groups });
}

// POST /api/addon-groups — a new add-on group with its options. Body (the add-on
// form): { display_name, selection_type: 'single' | 'multi', min_select,
// max_select, options: [{ name, price_inr }] }.
//
// Same gates as creating a menu item (POST /api/menu): a counter actor with the
// 'menu_edit' permission, on the POS. The owner's create applies at once
// (201 { group }); a staff member's or manager's is stored as a pending request
// for the owner to approve in the owner app (202 { pending: true, request }) —
// supabase/2026-10-addon-change-requests.sql.
export async function POST(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  if (!(await hasPermission(actor.user, 'menu_edit', actor.role))) {
    return errorResponse(403, 'You do not have permission to edit the menu');
  }
  if (!canEditMenu(await getStaffSurface())) {
    return errorResponse(403, MENU_POS_ONLY_MESSAGE);
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const checked = validateAddonGroupBody(body);
  if (!checked.ok) return failureResponse(checked);
  const values = checked.value;
  if (values.options.some((o) => o.id !== undefined)) {
    return errorResponse(400, 'A new add-on group starts with new options only.');
  }

  const admin = createAdminSupabaseClient();

  // Say so now rather than when the owner approves: the group name is unique.
  const { data: taken, error: takenError } = await admin
    .from('addon_groups')
    .select('id')
    .eq('name', values.display_name)
    .maybeSingle();
  if (takenError) return errorResponse(500, 'Failed to check the add-on group name');
  if (taken) {
    return errorResponse(409, `An add-on group called "${values.display_name}" already exists. Pick another name, or edit that group.`);
  }

  if (actor.role !== 'owner') {
    const stored = await createAddonChangeRequest(admin, {
      action: 'create',
      addonGroupId: null,
      itemName: values.display_name,
      payload: addonPayloadFromValues(values),
      snapshot: null,
      requestedBy: actor.user.id,
    });
    if (!stored.ok) return failureResponse(stored);
    const pending: MenuChangePendingResponse = { pending: true, request: stored.value };
    return NextResponse.json(pending, { status: 202 });
  }

  const created = await applyAddonCreate(admin, values);
  if (!created.ok) return failureResponse(created);
  return NextResponse.json({ group: created.value }, { status: 201 });
}
