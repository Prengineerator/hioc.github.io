import { NextResponse } from 'next/server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { parseManualCampaign } from '@/lib/marketing/parse';
import type { CampaignListFilter, CampaignsResponse } from '@/lib/marketing/types';
import { CAMPAIGN_LIST_STATUSES } from '@/lib/marketing/types';
import { createManualDraft, listCampaigns } from '@/lib/marketing/server/campaigns';
import { ownerRoute } from '@/lib/marketing/server/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/owner/marketing/campaigns?status=pending_approval|active|history
// POST /api/owner/marketing/campaigns — a manual campaign, saved as a DRAFT with its
// frozen projection (nothing can send from a draft; the owner approves it in Approvals).
// OWNER ONLY.

export async function GET(request: Request) {
  return ownerRoute(async () => {
    const status = new URL(request.url).searchParams.get('status') ?? '';
    if (!Object.prototype.hasOwnProperty.call(CAMPAIGN_LIST_STATUSES, status)) {
      return errorResponse(400, 'status must be pending_approval, active or history');
    }
    const campaigns = await listCampaigns(status as CampaignListFilter);
    return NextResponse.json({ campaigns } satisfies CampaignsResponse);
  });
}

export async function POST(request: Request) {
  return ownerRoute(async (owner) => {
    const body = await parseJsonBody(request);
    if (!body) return errorResponse(400, 'Request body must be a JSON object');
    const parsed = parseManualCampaign(body);
    if (!parsed.ok) return errorResponse(400, parsed.error);

    const result = await createManualDraft(parsed.value, owner.id);
    if (!result.ok) return errorResponse(result.code === 'invalid' ? 400 : 500, result.message);
    return NextResponse.json({ campaign: result.campaign }, { status: 201 });
  });
}
