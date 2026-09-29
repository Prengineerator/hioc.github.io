import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { isReportKind, latestPeriod, resolveRecipients } from '@/lib/reports/ownerDigest';
import {
  MIGRATION_NOT_APPLIED,
  buildDigest,
  loadReportSettings,
  ownerLoginEmails,
  sendDigest,
} from '@/lib/reports/ownerDigestServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/owner/report-emails/send { kind: 'daily' | 'weekly' | 'monthly' }
// — owner only. "Send now": emails the latest complete period of that kind to
// the configured recipients straight away, whether or not that kind is
// switched on (so the owner can see one before turning it on). Logged as a
// 'manual' send; it never stops the scheduled one from going out.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body || !isReportKind(body.kind)) return errorResponse(400, 'kind must be daily, weekly or monthly');

  const admin = createAdminSupabaseClient();
  try {
    const { settings, migrated } = await loadReportSettings(admin);
    if (!migrated) return errorResponse(409, MIGRATION_NOT_APPLIED);

    const recipients = resolveRecipients(settings, await ownerLoginEmails(admin));
    if (recipients.length === 0) return errorResponse(400, 'Add at least one email address first.');

    const period = latestPeriod(body.kind, istDateIso(), settings);
    const { email } = await buildDigest(admin, period);
    const outcomes = await sendDigest(admin, period, email, recipients, 'manual');
    return NextResponse.json({ period, outcomes });
  } catch (err) {
    console.error('owner report-emails send failed', err);
    return errorResponse(500, 'Could not send the report');
  }
}
