import { NextResponse } from 'next/server';
import { ownerRoute } from '@/lib/marketing/server/http';
import { getOverview } from '@/lib/marketing/server/overview';

export const dynamic = 'force-dynamic';
// Joins every customer, order and points row: give it room on a big database.
export const maxDuration = 60;

// GET /api/owner/marketing/overview — the Overview tab: kill switch, KPIs, the weekly
// customer chart and drop alert, insights, recent campaigns. OWNER ONLY.
export async function GET() {
  return ownerRoute(async () => NextResponse.json(await getOverview()));
}
