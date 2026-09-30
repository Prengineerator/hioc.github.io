import { NextResponse } from 'next/server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { parseCostsPut } from '@/lib/marketing/parse';
import { listCosts, putCosts } from '@/lib/marketing/server/costs';
import { ownerRoute } from '@/lib/marketing/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET / PUT /api/owner/marketing/costs — product costs (COGS), one per menu VARIANT, and
// the free-item ranking built on them. OWNER ONLY, and the ONLY route a cost is ever
// readable from: never /api/menu, never a column on the public menu tables.

export async function GET() {
  return ownerRoute(async () => NextResponse.json(await listCosts()));
}

// PUT {costs: [{variant_id, cost_inr: number | null}]} — null deletes. The server looks up
// each variant's item; an unknown variant id rejects the whole request.
export async function PUT(request: Request) {
  return ownerRoute(async (owner) => {
    const body = await parseJsonBody(request);
    if (!body) return errorResponse(400, 'Request body must be a JSON object');
    const parsed = parseCostsPut(body);
    if (!parsed.ok) return errorResponse(400, parsed.error);

    const result = await putCosts(parsed.value.costs, owner.id);
    if (!result.ok) return errorResponse(400, result.error);
    return NextResponse.json(result.response);
  });
}
