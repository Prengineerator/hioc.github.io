import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// Staff-readable tables list (POS-1). The dine-in table picker (PosOrderEntry)
// and the tables board (POS-3) need to read the registry, but the owner CRUD at
// app/api/owner/tables is owner-only — this is the missing staff read path.
//
// PIN-3: gated by getCounterActor() (classic staff/manager/owner session
// first, unchanged; an enrolled-device operator only when there is no
// session at all — lib/api/auth.ts). Only ACTIVE tables are returned, in
// display order, for entry-screen selection.
//
// SECURITY: mirrors the owner route's column allow-list — `qr_token` is the
// QR-1 order link and is column-sensitive, so it is NEVER selected here (or
// anywhere a client can read). QR-2 will add a dedicated token/image route.
const TABLE_COLUMNS = 'id, label, zone, capacity, is_active, sort_order';

// GET — active tables only, in display order (sort_order, then label).
export async function GET() {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('tables')
    .select(TABLE_COLUMNS)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) return errorResponse(500, error.message);

  return NextResponse.json({ tables: data ?? [] });
}
