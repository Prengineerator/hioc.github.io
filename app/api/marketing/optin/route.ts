import { NextResponse } from 'next/server';
import { flags } from '@/lib/flags';
import { optinUrl } from '@/lib/marketing/optin';
import { loadSettings, marketingAdmin } from '@/lib/marketing/server/repo';
import type { PublicOptinResponse } from '@/lib/marketing/types';

export const dynamic = 'force-dynamic';

// GET /api/marketing/optin — PUBLIC, no auth. The wa.me link a customer taps to opt in to
// offers (they send START; the WhatsApp webhook records it). The order-confirmation card
// and the printable QR read it.
//
// Returns ONLY the link. Nothing else from marketing_settings ever leaves this route:
// budgets, costs and caps are the owner's business. `available` is false — and the link
// null — unless the marketing flag is on AND the owner has entered a business number;
// and false, never an error, when the migration is not applied yet.
const CACHE = { 'Cache-Control': 'public, max-age=300' };

export async function GET() {
  const none: PublicOptinResponse = { available: false, wa_link: null };
  if (!flags.marketing) return NextResponse.json(none, { headers: CACHE });

  try {
    const settings = await loadSettings(marketingAdmin());
    const link = optinUrl(settings?.whatsapp_business_number);
    const body: PublicOptinResponse = link ? { available: true, wa_link: link } : none;
    return NextResponse.json(body, { headers: CACHE });
  } catch {
    return NextResponse.json(none, { headers: CACHE });
  }
}
