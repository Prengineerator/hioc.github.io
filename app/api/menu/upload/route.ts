import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { getStaffSurface } from '@/lib/staff/surface';
import { canEditMenu, MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';

export const dynamic = 'force-dynamic';

// Public Storage bucket menu item photos land in (S6 photo). Must exist as a
// PUBLIC bucket named exactly this in the Supabase project — created lazily
// below on first upload if the operator hasn't provisioned it yet.
const BUCKET = 'menu-images';
const MAX_BYTES = 2 * 1024 * 1024; // ~2MB
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// POST /api/menu/upload — staff-only. multipart/form-data with a `file`
// field. Validates image mime + size, uploads to the public `menu-images`
// bucket via the admin client, and returns { url } — the caller saves that
// onto a menu item's image_url (POST/PATCH /api/menu).
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

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, 'Request must be multipart/form-data with a file field');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return errorResponse(400, 'file field is required');
  }

  const ext = EXT_BY_MIME[file.type];
  if (!ext) {
    return errorResponse(400, 'file must be a JPEG, PNG, WEBP, or GIF image');
  }

  if (file.size > MAX_BYTES) {
    return errorResponse(400, 'file must be 2MB or smaller');
  }

  const admin = createAdminSupabaseClient();
  const path = `${randomUUID()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  let { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: file.type, upsert: false });

  // First-run convenience: if the bucket hasn't been provisioned yet, create
  // it (public, image-only) and retry once rather than hard-failing.
  if (uploadError && /bucket not found/i.test(uploadError.message)) {
    await admin.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX_BYTES });
    ({ error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: file.type, upsert: false }));
  }

  if (uploadError) {
    return errorResponse(500, 'Failed to upload image');
  }

  const { data } = admin.storage.from(BUCKET).getPublicUrl(path);

  return NextResponse.json({ url: data.publicUrl }, { status: 201 });
}
