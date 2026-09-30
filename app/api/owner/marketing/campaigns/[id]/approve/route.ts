import { NextResponse } from 'next/server';
import { errorResponse, notFound } from '@/lib/api/http';
import { approveCampaign } from '@/lib/marketing/server/campaigns';
import { isUuidParam, ownerRoute } from '@/lib/marketing/server/http';

export const dynamic = 'force-dynamic';

// POST /api/owner/marketing/campaigns/[id]/approve — only from draft / pending_approval:
// the campaign becomes approved and its recipients queued. The sender still re-checks
// consent, caps and the send window for every message. A campaign in any other state is a
// 409, so a double tap or an approve racing a cancel cannot do both. OWNER ONLY.
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  return ownerRoute(async (owner) => {
    if (!isUuidParam(params.id)) return notFound();
    const result = await approveCampaign(params.id, owner.id);
    if (result.ok) return NextResponse.json({ campaign: result.campaign });
    if (result.code === 'not_found') return notFound();
    return errorResponse(result.code === 'invalid_state' ? 409 : 500, result.message);
  });
}
