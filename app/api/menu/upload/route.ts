import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import { uploadMenuImage } from '@/lib/menu/applyMenuChange';

export const dynamic = 'force-dynamic';

// POST /api/menu/upload — staff-only. multipart/form-data with a `file`
// field. Validates image mime + size, uploads to the public `menu-images`
// bucket via the admin client, and returns { url } — the caller saves that
// onto a menu item's image_url (POST/PATCH /api/menu). The upload itself is
// lib/menu/applyMenuChange.ts uploadMenuImage, shared with the owner app's
// /api/owner/menu/upload.
//
// PIN-3: gated by getCounterActor() — classic session first, unchanged; an
// enrolled-device PIN operator only when there is no session at all. Kept in
// step with POST/PATCH /api/menu, which it feeds — a menu-edit flow that
// works via PIN everywhere except the image field would just fail partway.
export async function POST(request: Request) {
  const actor = await getCounterActor();
  if (!actor) {
    return unauthorized();
  }

  // Menu changes are made on the POS only (the staff website shows the menu
  // read-only) — see lib/staff/surfaceRules.ts.
  if (!canEditMenu(await getStaffSurface())) {
    return errorResponse(403, MENU_POS_ONLY_MESSAGE);
  }

  return uploadMenuImage(request, createAdminSupabaseClient());
}
