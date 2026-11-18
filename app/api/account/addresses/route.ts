// GET/POST /api/account/addresses — the signed-in customer's address book
// (docs/SHOP-V2-SPEC.md E3). Works whether or not flags.shop is on (the book
// is part of the account, Non-negotiable 4), so there is no flag check here.
//
// Runs as the customer (user-session client, RLS applies) with an explicit
// user_id filter on top. Errors are `{ error, field? }`.

import { NextResponse } from 'next/server';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { MAX_SAVED_ADDRESSES } from '@/lib/account/addressRules';
import { addressFromShopOrder, createAddress, listAddresses, statusFor, type NewAddress } from '@/lib/account/addresses';
import { normalizeAddressLabel, validateSavedAddress } from '@/lib/shop/address';
import { parseShopLocation } from '@/lib/shop/location';

export const dynamic = 'force-dynamic';

const err = (status: number, error: string, field?: string) =>
  NextResponse.json(field ? { error, field } : { error }, { status });

export async function GET() {
  const user = await getAuthUser();
  if (!user) return err(401, 'Unauthorized');

  const res = await listAddresses(createServerSupabaseClient(), user.id);
  if (!res.ok) return err(statusFor(res.kind), res.message);
  return NextResponse.json(
    { addresses: res.addresses, max: MAX_SAVED_ADDRESSES },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return err(401, 'Unauthorized');

  const body = await parseJsonBody(request);
  if (!body) return err(400, 'Invalid request body');

  let draft: NewAddress;

  if (body.from_shop_order_id !== undefined) {
    // "Save these details for next time": copy the frozen address of the caller's own order.
    if (!isUuid(body.from_shop_order_id)) return err(404, 'Order not found');
    const fromOrder = await addressFromShopOrder(createAdminSupabaseClient(), user.id, body.from_shop_order_id);
    if (!fromOrder) return err(404, 'Order not found');
    draft = {
      ...fromOrder,
      label: body.label === undefined ? fromOrder.label : normalizeAddressLabel(body.label),
      labelSupplied: body.label !== undefined,
    };
    // The order was valid when placed, but run the same checks so nothing odd gets saved.
    const checked = validateSavedAddress(draft);
    if (!checked.ok) return err(400, checked.error, checked.field);
    draft = { ...draft, ...checked.address };
  } else {
    const checked = validateSavedAddress(body);
    if (!checked.ok) return err(400, checked.error, checked.field);
    const loc = parseShopLocation(body.location);
    if (!loc.ok) return err(400, loc.error, 'location');
    draft = {
      ...checked.address,
      location: loc.location,
      is_default: body.is_default === true,
      labelSupplied: body.label !== undefined,
    };
  }

  const res = await createAddress(createServerSupabaseClient(), user.id, draft);
  if (!res.ok) return err(statusFor(res.kind), res.message);
  return NextResponse.json({ address: res.address }, { status: res.created ? 201 : 200 });
}
