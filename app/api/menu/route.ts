import { NextResponse } from 'next/server';
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isMenuCategory, MENU_CATEGORIES } from '@/lib/api/constants';
import { isInStoreOnly } from '@/lib/menu/inStore';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import { getStoreSettings } from '@/lib/store/settings';
import { applyMenuSwitches, isCategoryHidden, switchesFromSettings } from '@/lib/menu/menuSwitches';
import { flags } from '@/lib/flags';
import {
  applyMenuCreate,
  failureResponse,
  MENU_ITEM_SELECT,
  shapeMenuItem,
  validateCreateBody,
  type MenuItemRow,
} from '@/lib/menu/applyMenuChange';
import { createChangeRequest, createPayloadFromValues } from '@/lib/menu/changeRequests';
import type { MenuChangePendingResponse } from '@/lib/menu/changeRequestTypes';
import { loadOfferRows, loadSpendOfferRows } from '@/lib/orders/offersServer';
import { pricingSettingsOf } from '@/lib/pos/localQuote';

export const dynamic = 'force-dynamic';

// GET /api/menu — public. Optional ?category=... and ?includeUnavailable=true.
// ?pos=true (a signed-in counter only) also returns what the POS needs to
// price a cart on its own screen — the store's GST/packaging settings and the
// switched-on multi-buy offers (lib/pos/localQuote.ts) — in this same answer,
// rather than one request per tap to the quote route.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const categoryParam = searchParams.get('category');
  if (categoryParam !== null && !isMenuCategory(categoryParam)) {
    return errorResponse(
      400,
      `Invalid category. Must be one of: ${MENU_CATEGORIES.join(', ')}`,
    );
  }

  const includeUnavailable = searchParams.get('includeUnavailable') === 'true';
  // In-store-only items (water bottles…) are for the POS and the menu editor.
  // The flag alone is not enough — it must come from a signed-in counter, or
  // any customer could append it to the URL.
  const isCounter = (await getCounterActor()) !== null;
  const includeInStore = searchParams.get('includeInStore') === 'true' && isCounter;
  // The menu editor needs the whole menu, switched off or not (saving an item
  // rewrites its sizes from the form — a size missing here would be deleted).
  const allSizes = searchParams.get('allSizes') === 'true' && isCounter;
  const wantsPos = searchParams.get('pos') === 'true' && isCounter;

  // Public menu reads go through the anon-key client — RLS's
  // `*_public_read` select policies (using (true)) cover this.
  const supabase = createServerSupabaseClient();

  let query = supabase
    .from('menu_items')
    .select(MENU_ITEM_SELECT)
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true });

  if (categoryParam) {
    query = query.eq('category', categoryParam);
  }
  if (!includeUnavailable) {
    query = query.eq('is_available', true);
  }

  // Settings only drive the on/off switches: if they can't be read, the menu
  // still loads (and orders are still checked against them server-side).
  const [{ data, error }, settings, offerRows, spendRows] = await Promise.all([
    query,
    getStoreSettings().catch(() => null),
    // Every switched-on offer, windows included: the POS decides "live" when it
    // prices (liveOffersByItem, liveSpendOffers). A failed read is no offers,
    // never an error.
    wantsPos ? loadOfferRows(createAdminSupabaseClient()) : Promise.resolve(null),
    wantsPos ? loadSpendOfferRows(createAdminSupabaseClient()) : Promise.resolve(null),
  ]);

  if (error) {
    return errorResponse(500, 'Failed to load menu');
  }

  // Menu switches (lib/menu/menuSwitches.ts): off categories, sizes and
  // add-ons are left out — except for the menu editor, which shows everything.
  const switches = allSizes || !settings ? {} : switchesFromSettings(settings);
  const items = (data ?? [])
    .map((row) => applyMenuSwitches(shapeMenuItem(row as unknown as MenuItemRow), switches))
    .filter((item) => !isCategoryHidden(item.category, switches.hiddenCategories))
    .filter((item) => includeInStore || !isInStoreOnly(item))
    // pass_eligible (docs/COFFEE-PASS-SPEC.md CP-D3): always a boolean, so a
    // screen never has to tell "not eligible" from "column not there yet", and
    // false for everything while the feature is off, so nothing about HIOC
    // Ritual is visible on a menu until the owner switches it on.
    .map((item) => ({ ...item, pass_eligible: flags.coffeePass === true && item.pass_eligible === true }));

  // No settings, no local pricing: the POS then asks the quote route as before.
  const pos =
    wantsPos && settings
      ? { settings: pricingSettingsOf(settings), offers: offerRows ?? [], spend_offers: spendRows ?? [] }
      : undefined;

  return NextResponse.json(pos ? { items, pos } : { items });
}

// POST /api/menu — staff-only.
//
// PIN-3: gated by getCounterActor() — classic session first, unchanged; an
// enrolled-device PIN operator only when there is no session at all. The
// item-availability toggle (S6) shares this route's PATCH sibling and the
// same 'menu_edit' permission, so create/edit move together rather than
// splitting an arbitrary "toggle only" carve-out out of one gate.
//
// Menu changes need the owner's approval (lib/menu/changeRequests.ts): the
// owner's own create applies at once (201 { item }); anyone else's is stored as
// a pending request and answered 202 { pending: true, request }.
export async function POST(request: Request) {
  const actor = await getCounterActor();
  if (!actor) {
    return unauthorized();
  }
  const user = actor.user;
  // FND3-6: menu edits go through the owner-configurable 'menu_edit' gate
  // (default = staff-and-up, preserving prior behavior). roleHint = actor.role
  // so hasPermission() doesn't re-derive it via a session a device operator
  // has none of (see lib/permissions.ts's own note).
  if (!(await hasPermission(user, 'menu_edit', actor.role))) {
    return errorResponse(403, 'You do not have permission to edit the menu');
  }

  // Menu changes are made on the POS only (the staff website shows the menu
  // read-only) — see lib/staff/surfaceRules.ts.
  if (!canEditMenu(await getStaffSurface())) {
    return errorResponse(403, MENU_POS_ONLY_MESSAGE);
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const checked = validateCreateBody(body);
  if (!checked.ok) {
    return failureResponse(checked);
  }

  const admin = createAdminSupabaseClient();

  if (actor.role !== 'owner') {
    // A snooze is an instant availability change, never part of a request.
    if (checked.value.unavailable_until !== null) {
      return errorResponse(400, 'A new item cannot be snoozed. Create it, then snooze it.');
    }
    const stored = await createChangeRequest(admin, {
      action: 'create',
      menuItemId: null,
      itemName: checked.value.name,
      payload: createPayloadFromValues(checked.value),
      snapshot: null,
      requestedBy: user.id,
    });
    if (!stored.ok) {
      return failureResponse(stored);
    }
    const pending: MenuChangePendingResponse = { pending: true, request: stored.value };
    return NextResponse.json(pending, { status: 202 });
  }

  const created = await applyMenuCreate(admin, checked.value);
  if (!created.ok) {
    return failureResponse(created);
  }

  return NextResponse.json({ item: created.value }, { status: 201 });
}
