import { NextResponse } from 'next/server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { recordOptOut } from '@/lib/marketing/server/consent';
import { MIGRATION_MISSING, ownerRoute } from '@/lib/marketing/server/http';
import { toE164 } from '@/lib/marketing/server/repo';

export const dynamic = 'force-dynamic';

// POST /api/owner/marketing/consent/opt-out {phone} — the owner records that a customer
// asked, in person, not to get offers. It is an opt-OUT only, deliberately: the owner
// cannot opt anyone IN (spec §2, DPDP — consent is the customer's own act), and there is
// no route that could. OWNER ONLY.
export async function POST(request: Request) {
  return ownerRoute(async (owner) => {
    const body = await parseJsonBody(request);
    if (!body || typeof body.phone !== 'string') return errorResponse(400, 'phone is required');
    const phone = toE164(body.phone);
    if (!phone) return errorResponse(400, 'That is not a valid phone number.');

    const result = await recordOptOut({ phone, source: 'owner', actor: owner.id });
    if (!result.ok) {
      if (result.migration_missing) return errorResponse(409, MIGRATION_MISSING);
      console.error('owner opt-out failed', result.error);
      return errorResponse(500, 'Could not record the opt-out');
    }
    return NextResponse.json({ ok: true });
  });
}
