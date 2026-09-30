import { NextResponse } from 'next/server';
import { notFound } from '@/lib/api/http';
import { getCampaignDetail } from '@/lib/marketing/server/campaigns';
import { isUuidParam, ownerRoute } from '@/lib/marketing/server/http';

export const dynamic = 'force-dynamic';

// GET /api/owner/marketing/campaigns/[id]?page= — the campaign, one page (50) of its
// recipients, and its measured results (returns, lift vs the holdout). OWNER ONLY.
export async function GET(request: Request, { params }: { params: { id: string } }) {
  return ownerRoute(async () => {
    if (!isUuidParam(params.id)) return notFound();
    const raw = Number(new URL(request.url).searchParams.get('page') ?? '1');
    const page = Number.isInteger(raw) && raw >= 1 ? raw : 1;
    const campaign = await getCampaignDetail(params.id, page);
    return campaign ? NextResponse.json(campaign) : notFound();
  });
}
