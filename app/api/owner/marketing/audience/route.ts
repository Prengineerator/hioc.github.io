import { NextResponse } from 'next/server';
import { ownerRoute } from '@/lib/marketing/server/http';
import { getAudienceSummary } from '@/lib/marketing/server/overview';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/owner/marketing/audience — the Audience tab: customers per lifecycle stage
// (all vs opted in), points outstanding/expiring, consent counts and recent events, and
// the opt-in link. OWNER ONLY.
export async function GET() {
  return ownerRoute(async () => NextResponse.json(await getAudienceSummary()));
}
