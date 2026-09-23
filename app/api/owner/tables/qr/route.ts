import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// Owner-only QR-token endpoint (QR-2 — printable QR cards).
//
// SECURITY: this is the ONLY place `qr_token` is exposed, and only to the owner.
// The sibling list endpoint (../route.ts) deliberately EXCLUDES qr_token via its
// explicit TABLE_COLUMNS, and the DB revokes the column from anon/authenticated;
// the service-role admin client still reads it. The owner is trusted, and the
// token never leaves the app — the client generates the QR image itself from the
// absolute /t/<qr_token> URL (no external QR-image service).
//
// The QR encodes QR-1's scan-to-order URL, so regenerating a token (the PATCH
// `regenerate_token` action on ../route.ts) rotates qr_token and thereby
// invalidates any previously printed card — the owner simply reprints. No extra
// code is needed here for that.
const QR_COLUMNS = 'id, label, zone, qr_token';

// GET — active tables (in display order) with their qr_token, for the owner to
// render printable A6 QR cards. Inactive tables are omitted: there's nothing to
// hang a card on.
export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('tables')
    .select(QR_COLUMNS)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) return errorResponse(500, error.message);

  return NextResponse.json({ tables: data ?? [] });
}
