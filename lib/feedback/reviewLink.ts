// Which Google review link the "Loved it" follow-up offers.
//
// Precedence: an explicit GOOGLE_REVIEW_URL env var (an ops override that
// takes effect with no DB write) beats the owner-editable
// store_settings.google_review_url (Settings → Feedback), which beats the
// hardcoded fallback (kept in sync with the column's own DB default in
// supabase/2026-10-order-feedback.sql) for the case the settings row can't be
// read at all.

import { GOOGLE_REVIEW_URL_DEFAULT } from '@/lib/constants';

export function resolveGoogleReviewUrl(settingsUrl: string | null | undefined): string {
  const env = process.env.GOOGLE_REVIEW_URL;
  if (env && env.trim()) return env.trim();
  if (settingsUrl && settingsUrl.trim()) return settingsUrl.trim();
  return GOOGLE_REVIEW_URL_DEFAULT;
}
