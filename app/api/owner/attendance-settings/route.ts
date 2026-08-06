import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';

export const dynamic = 'force-dynamic';

// OPS5-1a — the owner's geofence + payroll rule configuration.
//
// OWNER ONLY. This is the one endpoint that returns the geofence radius and the
// store coordinates, and it must never widen to a staff session: a staffer who
// knows the radius knows most of what they need to beat it (A-3). That is why
// the punch route reads these settings server-side and returns only a verdict,
// rather than the client fetching config and deciding for itself.

// Whitelisted writable keys with their bounds. Anything not listed is ignored
// rather than rejected, so a future column cannot be written by an old client.
const NUMERIC_FIELDS: Record<string, { min: number; max: number; integer: boolean }> = {
  geofence_radius_m: { min: 10, max: 5000, integer: true },
  max_accuracy_m: { min: 5, max: 2000, integer: true },
  max_fix_age_sec: { min: 5, max: 900, integer: true },
  grace_period_min: { min: 0, max: 240, integer: true },
  late_marks_per_halfday: { min: 1, max: 30, integer: true },
  ot_threshold_min: { min: 0, max: 480, integer: true },
  ot_multiplier: { min: 0, max: 5, integer: false },
  auto_break_min: { min: 0, max: 240, integer: true },
  auto_break_after_min: { min: 30, max: 1440, integer: true },
  half_day_min_minutes: { min: 0, max: 1440, integer: true },
  absent_below_minutes: { min: 0, max: 1440, integer: true },
  auto_close_grace_min: { min: 0, max: 720, integer: true },
  max_session_hours: { min: 1, max: 24, integer: true },
  location_retention_days: { min: 30, max: 3650, integer: true },
};

export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  return NextResponse.json({ settings: await getAttendanceSettings() });
}

export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const patch: Record<string, number | null> = {};

  // Coordinates are handled separately: they are the only fields that may be
  // deliberately cleared (which disables punching), and they must move together.
  const hasLat = 'store_lat' in body;
  const hasLng = 'store_lng' in body;
  if (hasLat !== hasLng) {
    return errorResponse(400, 'Latitude and longitude must be set together.');
  }
  if (hasLat && hasLng) {
    const lat = body.store_lat;
    const lng = body.store_lng;
    if (lat === null && lng === null) {
      patch.store_lat = null;
      patch.store_lng = null;
    } else if (
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return errorResponse(400, 'Latitude must be between -90 and 90, longitude between -180 and 180.');
    } else {
      patch.store_lat = lat;
      patch.store_lng = lng;
    }
  }

  for (const [key, bound] of Object.entries(NUMERIC_FIELDS)) {
    if (!(key in body)) continue;
    const value = body[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return errorResponse(400, `${key} must be a number.`);
    }
    if (bound.integer && !Number.isInteger(value)) {
      return errorResponse(400, `${key} must be a whole number.`);
    }
    if (value < bound.min || value > bound.max) {
      return errorResponse(400, `${key} must be between ${bound.min} and ${bound.max}.`);
    }
    patch[key] = value;
  }

  if (Object.keys(patch).length === 0) {
    return errorResponse(400, 'No writable settings fields provided');
  }

  // Cross-field coherence, checked against the MERGED result rather than the
  // patch alone — otherwise changing one threshold in isolation could put the
  // pair into a state where a day is both absent and a half day. The DB has the
  // same constraint; catching it here produces a message an owner can act on
  // instead of a raw constraint violation.
  const current = await getAttendanceSettings();
  const merged = { ...current, ...patch };
  if (Number(merged.absent_below_minutes) > Number(merged.half_day_min_minutes)) {
    return errorResponse(
      400,
      'The absent threshold must be lower than the half-day threshold — otherwise a day could count as both.',
    );
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('attendance_settings')
    .update({ ...patch, updated_by: owner.id })
    .eq('is_singleton', true)
    .select('*')
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  if (!data) return errorResponse(500, 'Attendance settings row is missing — apply supabase/2026-08-attendance.sql.');

  return NextResponse.json({ settings: data });
}
