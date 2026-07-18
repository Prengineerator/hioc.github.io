import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { parseAnnouncementInput } from '@/lib/promotions/validate';
import type { Announcement } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/announcements/[id] — staff/owner only. Edit or toggle `active`.
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getManagerUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const parsed = parseAnnouncementInput(body, { partial: true });
  if (typeof parsed === 'string') {
    return errorResponse(400, parsed);
  }
  if (Object.keys(parsed).length === 0) {
    return errorResponse(400, 'No writable fields provided');
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('announcements')
    .update(parsed)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('announcements update failed', error);
    return errorResponse(500, 'Failed to update announcement');
  }
  if (!data) {
    return notFound();
  }

  return NextResponse.json({ announcement: data as Announcement });
}

// DELETE /api/announcements/[id] — staff/owner only.
export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getManagerUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const admin = createAdminSupabaseClient();
  const { error } = await admin.from('announcements').delete().eq('id', id);
  if (error) {
    console.error('announcements delete failed', error);
    return errorResponse(500, 'Failed to delete announcement');
  }

  return NextResponse.json({ ok: true });
}
