import { NextResponse } from 'next/server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { parseManualCampaign } from '@/lib/marketing/parse';
import { previewManual } from '@/lib/marketing/server/campaigns';
import { ownerRoute } from '@/lib/marketing/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/owner/marketing/campaigns/preview — the wizard's live projection. Same input
// as creating a campaign, but an unnamed campaign or an unset template name is accepted
// (the projection then shows the no_template flag). NOTHING is saved. OWNER ONLY.
export async function POST(request: Request) {
  return ownerRoute(async () => {
    const body = await parseJsonBody(request);
    if (!body) return errorResponse(400, 'Request body must be a JSON object');
    const parsed = parseManualCampaign(body, { preview: true });
    if (!parsed.ok) return errorResponse(400, parsed.error);
    return NextResponse.json(await previewManual(parsed.value));
  });
}
