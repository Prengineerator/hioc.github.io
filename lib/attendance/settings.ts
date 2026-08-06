import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import type { AttendanceSettings } from '@/lib/types';
import type { GeofenceConfig } from '@/lib/attendance/geofence';

// Server-only access to the attendance rule set.
//
// This module must never be imported by a client component. The settings row
// carries the geofence radius and thresholds, and a staffer who knows those
// knows most of what they need to defeat them (SECURITY-PLAYBOOK A-3). The
// `server-only` import above turns that from a convention into a build error.

/**
 * Defaults matching the migration's column defaults, used when the settings row
 * is missing entirely (a database that has not been migrated yet).
 *
 * Note `store_lat`/`store_lng` stay null: an unconfigured store must DISABLE
 * punching, not permit it from anywhere. There is no safe default coordinate.
 */
const FALLBACK: Omit<AttendanceSettings, 'id' | 'updated_by' | 'updated_at'> = {
  is_singleton: true,
  store_lat: null,
  store_lng: null,
  geofence_radius_m: 150,
  max_accuracy_m: 100,
  max_fix_age_sec: 60,
  grace_period_min: 15,
  late_marks_per_halfday: 3,
  ot_threshold_min: 0,
  ot_multiplier: 1,
  auto_break_min: 0,
  auto_break_after_min: 360,
  half_day_min_minutes: 240,
  absent_below_minutes: 120,
  auto_close_grace_min: 120,
  max_session_hours: 14,
  location_retention_days: 365,
  max_leave_days_per_week: 1,
};

export async function getAttendanceSettings(): Promise<AttendanceSettings> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('attendance_settings')
    .select('*')
    .eq('is_singleton', true)
    .maybeSingle();

  if (error || !data) {
    // Fail SAFE rather than open: with null coordinates the geofence refuses
    // every punch, which is visible and fixable. The alternative — inventing a
    // location — would accept every punch and look like it worked.
    return { id: '', updated_by: null, updated_at: '', ...FALLBACK };
  }
  return data as AttendanceSettings;
}

/** Narrows the settings row to just what the geofence needs. */
export function geofenceConfigFrom(settings: AttendanceSettings): GeofenceConfig {
  return {
    storeLat: settings.store_lat === null ? null : Number(settings.store_lat),
    storeLng: settings.store_lng === null ? null : Number(settings.store_lng),
    radiusM: settings.geofence_radius_m,
    maxAccuracyM: settings.max_accuracy_m,
    maxFixAgeSec: settings.max_fix_age_sec,
  };
}
