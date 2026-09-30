import { NextResponse } from 'next/server';
import { ownerRoute } from '@/lib/marketing/server/http';
import { getOverview, getOverviewSummary } from '@/lib/marketing/server/overview';

export const dynamic = 'force-dynamic';
// Joins every customer, order and points row: give it room on a big database.
export const maxDuration = 60;

// GET /api/owner/marketing/overview — the Overview tab: kill switch, KPIs, the weekly
// customer chart and drop alert, insights, recent campaigns. OWNER ONLY.
//
// GET /api/owner/marketing/overview?summary=1 — just what the /owner home card shows
// (MarketingOverviewSummary): the kill switch, campaigns waiting, this month's spend and the
// drop alert. The full overview reads a year of orders and the whole points ledger; the home
// page must not pay that on every visit.
export async function GET(request: Request) {
  // `request?.` because a bare GET() (no request) has always meant the full overview.
  const summary = request?.url ? new URL(request.url).searchParams.get('summary') === '1' : false;
  return ownerRoute(async () => NextResponse.json(summary ? await getOverviewSummary() : await getOverview()));
}
