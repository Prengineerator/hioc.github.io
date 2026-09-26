// Petpooja account-scoped helpers — pre-fill profile details from legacy data,
// and date validation (lib/legacy/history.ts covers POS lookups).
//
// Phone verification triggers a pre-fill of name, date_of_birth, and
// date_of_anniversary from the Petpooja legacy_customers row if the profile
// fields are still blank (never overwrite user-entered values). The prefill is
// best-effort: if it fails (e.g. columns missing, query error), phone verify
// still succeeds — the core update is separate.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface LegacyCustomerRow {
  name: string | null;
  date_of_birth: string | null;
  date_of_anniversary: string | null;
}

/**
 * Look up a phone in legacy_customers and return the row with name, DOB, and
 * anniversary — just the data fetch, no logic about which fields to update.
 * Returns null if not found or on any error.
 */
export async function legacyCustomerProfilePrefill(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<LegacyCustomerRow | null> {
  const { data, error } = await admin
    .from('legacy_customers')
    .select('name, date_of_birth, date_of_anniversary')
    .eq('phone', phoneE164)
    .maybeSingle();

  if (error) {
    console.error('legacyCustomerProfilePrefill: query failed', error);
    return null;
  }

  return (data as LegacyCustomerRow | null) ?? null;
}

/**
 * Which fields should be updated on a profile given the current profile state
 * and legacy_customers row. Pure function, no side effects — lives here so the
 * decision logic can be tested independently of the verify route and DB.
 */
export function profilePrefillToUpdate(
  currentName: string,
  currentDob: string | null,
  currentAnniversary: string | null,
  legacyRow: Partial<LegacyCustomerRow> | null,
): Record<string, unknown> {
  if (!legacyRow) {
    return {};
  }

  const updates: Record<string, unknown> = {};

  // Only fill name if profile name is empty or whitespace
  if (!currentName || !currentName.trim()) {
    if (legacyRow.name && legacyRow.name.trim()) {
      updates.name = legacyRow.name.trim();
    }
  }

  // Only fill date_of_birth if profile has none
  if (!currentDob && legacyRow.date_of_birth) {
    updates.date_of_birth = legacyRow.date_of_birth;
  }

  // Only fill date_of_anniversary if profile has none
  if (!currentAnniversary && legacyRow.date_of_anniversary) {
    updates.date_of_anniversary = legacyRow.date_of_anniversary;
  }

  return updates;
}

/**
 * Best-effort pre-fill of a just-verified profile from its Petpooja customer
 * row. Called by the OTP verify route only AFTER the phone/phone_verified
 * update succeeded, and never throws: every failure is logged and skipped, so
 * nothing here can turn a successful verification into a failed one.
 *
 * If the profile can't be read, nothing is filled — treating an unreadable
 * name as blank would overwrite the customer's real name with Petpooja's.
 */
export async function prefillProfileFromPetpooja(
  admin: SupabaseClient,
  userId: string,
  phoneE164: string,
): Promise<void> {
  try {
    const { data: profile, error: readError } = await admin
      .from('profiles')
      .select('name, date_of_birth, date_of_anniversary')
      .eq('id', userId)
      .maybeSingle();
    if (readError || !profile) {
      if (readError) console.error('prefillProfileFromPetpooja: profile read failed', readError);
      return;
    }

    const legacyRow = await legacyCustomerProfilePrefill(admin, phoneE164);
    const current = profile as { name: string | null; date_of_birth: string | null; date_of_anniversary: string | null };
    const updates = profilePrefillToUpdate(
      current.name ?? '',
      current.date_of_birth,
      current.date_of_anniversary,
      legacyRow,
    );
    if (Object.keys(updates).length === 0) return;

    const { error: updateError } = await admin.from('profiles').update(updates).eq('id', userId);
    if (updateError) console.error('prefillProfileFromPetpooja: update failed', updateError);
  } catch (err) {
    console.error('prefillProfileFromPetpooja: threw', err);
  }
}

/** Today's date in India as 'YYYY-MM-DD' ('en-CA' formats dates that way),
 * independent of the server's own time zone (UTC on Vercel). */
export function istToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

/**
 * Validates a 'YYYY-MM-DD' date from the profile form. Returns the string, or
 * null for empty input; throws with a user-facing message otherwise.
 *
 * - format must be YYYY-MM-DD, and the date must exist (round-trips through
 *   Date, so '2026-13-45' or '2026-02-30' is rejected instead of 500ing in
 *   Postgres)
 * - year 1900 or later
 * - a birthday can't be after today in India
 */
export function parseIsoDate(s: string, isBirthday = false, now: Date = new Date()): string | null {
  if (!s || s.trim().length === 0) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error('Date must be in YYYY-MM-DD format');
  }
  const parsed = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s) {
    throw new Error('Invalid date');
  }
  if (Number(s.slice(0, 4)) < 1900) {
    throw new Error('Year must be 1900 or later');
  }
  if (isBirthday && s > istToday(now)) {
    throw new Error('Birth date cannot be in the future');
  }
  return s;
}
