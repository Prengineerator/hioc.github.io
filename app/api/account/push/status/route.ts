import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { flags } from '@/lib/flags';
import { isMigrationMissing } from '@/lib/marketing/server/repo';
import { ENDPOINT_MAX } from '@/lib/push/validate';
import type { PushStatus } from '@/lib/push/types';

export const dynamic = 'force-dynamic';

// POST /api/account/push/status {endpoint?} — is this device subscribed, and how many
// devices does the signed-in customer have? A POST with the endpoint in the body (not
// a GET query string) so the address never lands in URLs or access logs. Session user
// only; 404 while the webPush flag is off.
export async function POST(request: Request) {
  if (!flags.webPush) return notFound();
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const endpoint = body.endpoint;
  if (endpoint !== undefined && (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX)) {
    return errorResponse(400, 'Invalid subscription endpoint.');
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('push_subscriptions').select('endpoint').eq('user_id', user.id);
  if (error) {
    console.error('push status failed', error.message);
    return isMigrationMissing(error) ? errorResponse(409, 'Phone notifications are not set up yet.') : errorResponse(500, 'Could not check notifications.');
  }
  const rows = (data ?? []) as { endpoint: string }[];
  return NextResponse.json({ subscribed: endpoint ? rows.some((r) => r.endpoint === endpoint) : false, devices: rows.length } satisfies PushStatus);
}
