import { NextResponse } from 'next/server';
import { errorResponse, notFound } from '@/lib/api/http';
import { cancelCampaign } from '@/lib/marketing/server/campaigns';
import { isUuidParam, ownerRoute } from '@/lib/marketing/server/http';

export const dynamic = 'force-dynamic';

// POST /api/owner/marketing/campaigns/[id]/cancel — any non-terminal campaign: it becomes
// cancelled and its pending / queued recipients cancelled. A message already sent stays
// sent; one already being sent is past recall. OWNER ONLY.
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  return ownerRoute(async () => {
    if (!isUuidParam(params.id)) return notFound();
    const result = await cancelCampaign(params.id);
    if (result.ok) return NextResponse.json({ campaign: result.campaign });
    if (result.code === 'not_found') return notFound();
    return errorResponse(result.code === 'invalid_state' ? 409 : 500, result.message);
  });
}
