import { NextResponse } from 'next/server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import {
  getStoreSettings,
  sanitizeSettingsPatch,
  updateStoreSettings,
} from '@/lib/store/settings';
import { computeStoreOpenState } from '@/lib/store/hours';
import { parseHiddenCategories, parseHiddenSizes } from '@/lib/menu/menuSwitches';
import { MENU_CATEGORIES } from '@/lib/api/constants';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';

export const dynamic = 'force-dynamic';

// GET /api/store-settings — public. The customer site needs hours/tax/slots and
// the current open/accepting state (C3). RLS also allows anon read of the row,
// but going through the server keeps the shape stable and adds the derived
// open-state so clients don't re-implement the hours math.
export async function GET() {
  const settings = await getStoreSettings();
  const openState = computeStoreOpenState(settings);
  return NextResponse.json({ settings, openState });
}

// PATCH /api/store-settings — staff/owner only (S7 busy-mode + O5 owner UI).
// Only the whitelisted writable keys are applied; id/is_singleton are ignored.
//
// PIN-3: gated by getCounterActor() — classic session first, unchanged; an
// enrolled-device PIN operator only when there is no session at all. This is
// what the staff header's store-open/busy toggle writes through.
export async function PATCH(request: Request) {
  const actor = await getCounterActor();
  if (!actor) {
    return unauthorized();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const patch = sanitizeSettingsPatch(body);
  if (Object.keys(patch).length === 0) {
    return errorResponse(400, 'No writable settings fields provided');
  }

  // Whether the staff website may take orders is an owner/manager decision
  // (2026-09-staff-web-ordering.sql), unlike the other day-to-day switches here.
  if ('staff_web_ordering' in patch) {
    if (typeof patch.staff_web_ordering !== 'boolean') {
      return errorResponse(400, 'staff_web_ordering must be true or false');
    }
    if (actor.role !== 'manager' && actor.role !== 'owner') {
      return errorResponse(403, 'Only a manager or the owner can change where orders can be taken');
    }
  }

  // Menu switches (2026-09-menu-switches.sql): which categories and sizes are
  // on sale changes the menu for every customer — an owner/manager decision,
  // and a menu change, so POS only like every other menu edit.
  if ('hidden_variant_labels' in patch || 'hidden_categories' in patch) {
    if ('hidden_variant_labels' in patch) {
      const parsed = parseHiddenSizes(patch.hidden_variant_labels, MENU_CATEGORIES);
      if (!parsed) return errorResponse(400, 'hidden_variant_labels must be a list of size names');
      patch.hidden_variant_labels = parsed;
    }
    if ('hidden_categories' in patch) {
      const parsed = parseHiddenCategories(patch.hidden_categories, MENU_CATEGORIES);
      if (!parsed) return errorResponse(400, 'hidden_categories must be a list of menu categories');
      patch.hidden_categories = parsed;
    }
    if (actor.role !== 'manager' && actor.role !== 'owner') {
      return errorResponse(403, 'Only a manager or the owner can switch categories or sizes on or off');
    }
    if (!canEditMenu(await getStaffSurface())) {
      return errorResponse(403, MENU_POS_ONLY_MESSAGE);
    }
  }

  const updated = await updateStoreSettings(patch);
  if (!updated) {
    return errorResponse(500, 'Failed to update store settings');
  }

  return NextResponse.json({
    settings: updated,
    openState: computeStoreOpenState(updated),
  });
}
