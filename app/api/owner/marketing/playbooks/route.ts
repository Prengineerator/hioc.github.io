import { NextResponse } from 'next/server';
import { ownerRoute } from '@/lib/marketing/server/http';
import { listPlaybookViews } from '@/lib/marketing/server/playbooks';
import type { PlaybooksResponse } from '@/lib/marketing/types';

export const dynamic = 'force-dynamic';

// GET /api/owner/marketing/playbooks — the five playbooks in priority order, each with
// its learned conversion rate and last runs. OWNER ONLY.
export async function GET() {
  return ownerRoute(async () => NextResponse.json({ playbooks: await listPlaybookViews() } satisfies PlaybooksResponse));
}
