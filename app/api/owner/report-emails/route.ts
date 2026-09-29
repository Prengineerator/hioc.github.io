import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { parseSettingsPatch, resolveRecipients } from '@/lib/reports/ownerDigest';
import {
  MIGRATION_NOT_APPLIED,
  isMissingRelation,
  loadReportSettings,
  ownerLoginEmails,
  recentSends,
  saveReportSettings,
} from '@/lib/reports/ownerDigestServer';

export const dynamic = 'force-dynamic';

// Owner → Reports → "Report emails": which summaries the owner gets by email
// (daily / weekly / monthly), when a week and a month start, and who else
// gets them. OWNER ONLY. Rules: lib/reports/ownerDigest.ts.

export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  const admin = createAdminSupabaseClient();
  try {
    const [{ settings, migrated }, ownerEmails, sends] = await Promise.all([
      loadReportSettings(admin),
      ownerLoginEmails(admin),
      recentSends(admin),
    ]);
    return NextResponse.json({
      settings,
      migrated,
      ownerEmails,
      recipients: resolveRecipients(settings, ownerEmails),
      emailConfigured: Boolean(process.env.RESEND_API_KEY && (process.env.RESEND_FROM_REPORTS || process.env.RESEND_FROM)),
      sends,
    });
  } catch (err) {
    console.error('owner report-emails: load failed', err);
    return errorResponse(500, 'Could not load report email settings');
  }
}

export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = parseSettingsPatch(body);
  if (!parsed.ok) return errorResponse(400, parsed.message);

  const admin = createAdminSupabaseClient();
  try {
    const settings = await saveReportSettings(admin, parsed.patch, owner.id);
    const ownerEmails = await ownerLoginEmails(admin);
    return NextResponse.json({ settings, recipients: resolveRecipients(settings, ownerEmails) });
  } catch (err) {
    if (isMissingRelation(err as { code?: string; message?: string })) return errorResponse(409, MIGRATION_NOT_APPLIED);
    console.error('owner report-emails: save failed', err);
    return errorResponse(500, 'Could not save report email settings');
  }
}
