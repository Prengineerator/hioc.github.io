import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { buildTrafficRow, insertTrafficRow, trafficContext } from '@/lib/traffic/record';
import { validateTrafficView } from '@/lib/traffic/validate';

export const dynamic = 'force-dynamic';

// A visit opens a handful of pages; this keeps a public insert endpoint from
// becoming free spam. Generous, because a cafe full of phones on one Wi-Fi
// shares one IP.
const RATE_LIMIT_MAX = 300;
const RATE_LIMIT_WINDOW_SECS = 600;

// POST /api/traffic — public, sent by components/traffic/TrafficTracker.tsx for
// each view of an ordering or Shop page (docs/TRAFFIC-TRACKING.md).
// Body: { sid, route, landing?, referrer?, utm_source?, utm_medium?,
// utm_campaign?, utm_content?, utm_term? }.
//
// The source is decided here, not in the browser. What is stored is the route
// pattern (never an order id or QR token), the linking site's hostname, the
// campaign tags, phone/tablet/computer, and the country and city Vercel's edge
// reports. The IP address and User-Agent are read for the rate limit and the
// device and dropped.
//
// Best-effort: a valid request answers 204 whatever happens to the insert,
// including before the table exists. Crawlers get 204 and nothing is written.
export async function POST(request: Request) {
  if (!flags.trafficTracking) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const view = validateTrafficView(body);
  if (typeof view === 'string') return errorResponse(400, view);

  const context = trafficContext(request);
  if (context.bot) return new NextResponse(null, { status: 204 });

  if (!(await rateLimitOk(`traffic:${clientIp(request)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECS))) {
    return errorResponse(429, 'Too many requests');
  }

  try {
    await insertTrafficRow(
      createAdminSupabaseClient(),
      buildTrafficRow({ event: 'view', attribution: view, route: view.route, landing: view.landing, context }),
    );
  } catch (err) {
    console.error('traffic route: insert threw (best-effort)', err);
  }
  return new NextResponse(null, { status: 204 });
}
