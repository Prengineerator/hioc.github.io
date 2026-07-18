import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { parseAnnouncementInput } from '@/lib/promotions/validate';
import type { Announcement } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_ANNOUNCEMENTS = 100;

// GET /api/announcements — public by default: only announcements that are
// active AND within their [starts_at, ends_at] window (what
// AnnouncementBanner renders). `?all=true` is staff/owner-only and returns
// every announcement (past/future/inactive) for the owner moderation table.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const admin = createAdminSupabaseClient();

  if (searchParams.get('all') === 'true') {
    const user = await getStaffUser();
    if (!user) {
      return unauthorized();
    }
    const { data, error } = await admin
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(MAX_ANNOUNCEMENTS);
    if (error) {
      return errorResponse(500, 'Failed to load announcements');
    }
    return NextResponse.json({ announcements: (data ?? []) as Announcement[] });
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from('announcements')
    .select('*')
    .eq('active', true)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
    .order('created_at', { ascending: false })
    .limit(MAX_ANNOUNCEMENTS);

  if (error) {
    return errorResponse(500, 'Failed to load announcements');
  }

  return NextResponse.json({ announcements: (data ?? []) as Announcement[] });
}

// POST /api/announcements — staff/owner only. Creates a homepage banner
// (LOY-5).
export async function POST(request: Request) {
  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const parsed = parseAnnouncementInput(body, { partial: false });
  if (typeof parsed === 'string') {
    return errorResponse(400, parsed);
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('announcements').insert(parsed).select('*').single();

  if (error) {
    console.error('announcements insert failed', error);
    return errorResponse(500, 'Failed to create announcement');
  }

  return NextResponse.json({ announcement: data as Announcement }, { status: 201 });
}
