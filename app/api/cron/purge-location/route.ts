import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import { istBusinessDate } from '@/lib/attendance/businessDate';

export const dynamic = 'force-dynamic';

// D5-9 — retention limitation for punch-time location.
//
// This exists because `app/privacy` TELLS staff their coordinates are deleted
// after 12 months. A published promise with no mechanism behind it is worse
// than no promise: it is a claim the cafe cannot honour if anyone ever asks.
// Under India's DPDP Act 2023 retention limitation is not optional, and the
// notice we show at first punch commits us to it explicitly.
//
// WHAT IS ERASED: the raw latitude and longitude — the only fields that reveal
// WHERE someone was.
// WHAT SURVIVES: `distance_m` and the accept/refuse outcome, which are what an
// attendance dispute actually turns on ("was this punch at the cafe?") and
// which reveal nothing about location beyond that yes/no.
//
// Deliberately an UPDATE, not a DELETE. Deleting the sessions would destroy the
// attendance and payroll record itself; the point is to forget the coordinates,
// not the shift.
//
// Idempotent: rows already purged have null coordinates and are excluded by the
// filter, so a second run in the same week finds nothing. Fails CLOSED without
// CRON_SECRET, same posture as the other jobs.

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const admin = createAdminSupabaseClient();
  const settings = await getAttendanceSettings();

  const cutoffMs = Date.now() - settings.location_retention_days * 86_400_000;
  const cutoffDate = istBusinessDate(new Date(cutoffMs));
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Sessions: keyed on business_date so the cutoff lines up with how every
  // other attendance surface talks about a day.
  const { data: sessionRows, error: sessionErr } = await admin
    .from('attendance_sessions')
    .update({
      clock_in_lat: null,
      clock_in_lng: null,
      clock_out_lat: null,
      clock_out_lng: null,
    })
    .lt('business_date', cutoffDate)
    .not('clock_in_lat', 'is', null)
    .select('id');
  if (sessionErr) {
    console.error('purge-location: sessions failed', sessionErr);
    return errorResponse(500, 'Could not purge session coordinates');
  }

  // Refused attempts carry coordinates too, and they are the MORE sensitive
  // set: a rejected punch records where somebody was when they were not at
  // work. Same cutoff, same reasoning.
  const { data: attemptRows, error: attemptErr } = await admin
    .from('attendance_punch_attempts')
    .update({ lat: null, lng: null })
    .lt('created_at', cutoffIso)
    .not('lat', 'is', null)
    .select('id');
  if (attemptErr) {
    console.error('purge-location: attempts failed', attemptErr);
    return errorResponse(500, 'Could not purge attempt coordinates');
  }

  const sessions = (sessionRows ?? []).length;
  const attempts = (attemptRows ?? []).length;
  if (sessions || attempts) {
    console.log(
      `purge-location: cleared coordinates on ${sessions} session(s) and ${attempts} attempt(s) before ${cutoffDate}`,
    );
  }

  return NextResponse.json({
    retentionDays: settings.location_retention_days,
    cutoffDate,
    sessionsPurged: sessions,
    attemptsPurged: attempts,
  });
}
