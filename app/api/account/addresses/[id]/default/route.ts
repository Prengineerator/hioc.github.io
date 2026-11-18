// POST /api/account/addresses/[id]/default — make this the default address.
// Calls the make_customer_address_default RPC (it unsets the old default
// first, so the one-default index holds). Not gated on flags.shop.

import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { isUuid } from '@/lib/api/constants';
import { makeDefault, statusFor } from '@/lib/account/addresses';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Address not found' }, { status: 404 });

  const res = await makeDefault(createServerSupabaseClient(), user.id, params.id);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: statusFor(res.kind) });
  return NextResponse.json({ address: res.address });
}
