import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { isReportKind, latestPeriod } from '@/lib/reports/ownerDigest';
import { buildDigest, loadReportSettings } from '@/lib/reports/ownerDigestServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/owner/report-emails/preview?kind=daily|weekly|monthly — owner only.
// The email exactly as it would go out for the latest complete period, as a
// page the owner can open in a new tab. Sends nothing.
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  const kind = new URL(request.url).searchParams.get('kind');
  if (!isReportKind(kind)) return errorResponse(400, 'kind must be daily, weekly or monthly');

  const admin = createAdminSupabaseClient();
  try {
    const { settings } = await loadReportSettings(admin);
    const { email } = await buildDigest(admin, latestPeriod(kind, istDateIso(), settings));
    return new Response(email.html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('owner report-emails preview failed', err);
    return errorResponse(500, 'Could not build the preview');
  }
}
