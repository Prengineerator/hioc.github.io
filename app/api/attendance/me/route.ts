import { NextResponse } from 'next/server';
import { getStaffOrOwner } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { istBusinessDate } from '@/lib/attendance/businessDate';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import type { AttendanceSession } from '@/lib/types';

export const dynamic = 'force-dynamic';

// ATT-1 (current state) + ATT-4 (my own hours).
//
// Scoped to the caller by user_id on the server, NOT by a client-supplied id —
// one staffer must never be able to read another's attendance (A-5). RLS would
// also stop it, but the route does not lean on RLS alone.
//
// This response deliberately carries NO geofence configuration: not the radius,
// not the store coordinates, not the thresholds (A-3). It reports only whether
// attendance is configured at all, which the screen needs in order to explain
// itself when punching is unavailable.

const DAYS_OF_HISTORY = 45;

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
}

export async function GET() {
  const account = await getStaffOrOwner();
  if (!account) return unauthorized();
  const userId = account.user.id;

  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - DAYS_OF_HISTORY * 86_400_000);

  const { data, error } = await admin
    .from('attendance_sessions')
    .select('*')
    .eq('user_id', userId)
    .gte('business_date', istBusinessDate(since))
    .neq('status', 'void')
    .order('clock_in_at', { ascending: false });
  if (error) return errorResponse(500, 'Could not load your attendance');

  const sessions = (data ?? []) as AttendanceSession[];
  const open = sessions.find((s) => s.status === 'open') ?? null;

  // Roll up by business date. A day can hold several sessions (a break punched
  // out and back in), so minutes are summed, not taken from first-in/last-out.
  const byDate = new Map<
    string,
    { date: string; minutes: number; sessions: number; needsApproval: boolean; edited: boolean }
  >();
  for (const s of sessions) {
    const entry = byDate.get(s.business_date) ?? {
      date: s.business_date,
      minutes: 0,
      sessions: 0,
      needsApproval: false,
      edited: false,
    };
    entry.sessions += 1;
    if (s.clock_out_at) entry.minutes += minutesBetween(s.clock_in_at, s.clock_out_at);
    // An auto-closed day is NOT confirmed time — it is a guess awaiting the
    // owner, and must never present itself to the staffer as settled hours.
    if (s.status === 'auto_closed' && !s.approved_at) entry.needsApproval = true;
    if (s.source === 'manual' || s.approved_at) entry.edited = true;
    byDate.set(s.business_date, entry);
  }

  const days = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? 1 : -1));

  const todayDate = istBusinessDate(new Date());
  const weekStart = istBusinessDate(new Date(Date.now() - 6 * 86_400_000));
  const monthPrefix = todayDate.slice(0, 7);

  const sum = (pred: (d: (typeof days)[number]) => boolean) =>
    days.filter(pred).reduce((acc, d) => acc + d.minutes, 0);

  const settings = await getAttendanceSettings();

  return NextResponse.json({
    open,
    days,
    today: byDate.get(todayDate) ?? { date: todayDate, minutes: 0, sessions: 0, needsApproval: false, edited: false },
    totals: {
      weekMinutes: sum((d) => d.date >= weekStart),
      monthMinutes: sum((d) => d.date.startsWith(monthPrefix)),
      monthDaysPresent: days.filter((d) => d.date.startsWith(monthPrefix) && d.minutes > 0).length,
      needsApprovalDays: days.filter((d) => d.needsApproval).length,
    },
    // Whether punching is possible at all — never the radius or the coordinates.
    configured: settings.store_lat !== null && settings.store_lng !== null,
  });
}
