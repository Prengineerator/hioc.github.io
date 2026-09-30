import { NextResponse } from 'next/server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { parsePlaybookPatch } from '@/lib/marketing/parse';
import { PLAYBOOK_KEYS } from '@/lib/marketing/types';
import type { PlaybookKey } from '@/lib/marketing/types';
import { ownerRoute } from '@/lib/marketing/server/http';
import { patchPlaybook } from '@/lib/marketing/server/playbooks';

export const dynamic = 'force-dynamic';

// PATCH /api/owner/marketing/playbooks/[key] — any subset of mode, params, offer,
// template, prior_conversion_pct. Each field is validated on its own (parsePlaybookPatch)
// and the MERGED params are checked again (validatePlaybookParams) because a patch may
// carry only one side of a cross-field rule. OWNER ONLY.
export async function PATCH(request: Request, { params }: { params: { key: string } }) {
  return ownerRoute(async (owner) => {
    if (!(PLAYBOOK_KEYS as readonly string[]).includes(params.key)) return notFound();
    const key = params.key as PlaybookKey;

    const body = await parseJsonBody(request);
    if (!body) return errorResponse(400, 'Request body must be a JSON object');
    const parsed = parsePlaybookPatch(key, body);
    if (!parsed.ok) return errorResponse(400, parsed.error);

    const result = await patchPlaybook(key, parsed.value, owner.id);
    if (!result.ok) return errorResponse(400, result.error);
    return NextResponse.json({ playbook: result.playbook });
  });
}
