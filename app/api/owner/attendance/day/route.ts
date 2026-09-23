import { NextResponse } from 'next/server';
import { getStaffOrOwner } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import type { AttendanceSession } from '@/lib/types';

export const dynamic = 'force-dynamic';

// SHEET-1 drill-down: one staffer, one day, with the raw punches and their edit
// history. Same gate as the sheet itself (attendance_approve — manager and up,
// D5-8); no money is returned here.

export async function GET(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return errorResponse(401, 'Unauthorized');
  if (!(await hasPermission(account.user, 'attendance_approve'))) {
    return errorResponse(403, 'You do not have access to the attendance sheet.');
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id') ?? '';
  const date = url.searchParams.get('date') ?? '';
  if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return errorResponse(400, 'user_id and a date like 2026-08-06 are required');
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('attendance_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('business_date', date)
    .order('clock_in_at', { ascending: true });
  if (error) return errorResponse(500, error.message);

  const sessions = (data ?? []) as AttendanceSession[];

  // The edit trail matters as much as the punches: "who changed this, and why"
  // is the first question anyone asks about a disputed day.
  const ids = sessions.map((s) => s.id);
  let edits: unknown[] = [];
  if (ids.length) {
    const { data: editRows } = await admin
      .from('attendance_edits')
      .select('*')
      .in('session_id', ids)
      .order('edited_at', { ascending: false });
    edits = editRows ?? [];
  }

  return NextResponse.json({ sessions, edits });
}
