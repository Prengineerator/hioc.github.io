// PATCH/DELETE /api/account/addresses/[id] (docs/SHOP-V2-SPEC.md E3). User
// session + explicit user_id filter; an id that is not the caller's answers
// 404, never 403, so ids cannot be probed. Not gated on flags.shop.

import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { deleteAddress, listAddresses, statusFor, updateAddress, type NewAddress } from '@/lib/account/addresses';
import { validateSavedAddress } from '@/lib/shop/address';
import { parseShopLocation } from '@/lib/shop/location';

export const dynamic = 'force-dynamic';

const err = (status: number, error: string, field?: string) =>
  NextResponse.json(field ? { error, field } : { error }, { status });

const EDITABLE = [
  'label',
  'customer_name',
  'phone',
  'address_line1',
  'address_line2',
  'landmark',
  'city',
  'state',
  'pincode',
] as const;

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const user = await getAuthUser();
  if (!user) return err(401, 'Unauthorized');
  if (!isUuid(params.id)) return err(404, 'Address not found');

  const body = await parseJsonBody(request);
  if (!body) return err(400, 'Invalid request body');

  const db = createServerSupabaseClient();
  const listed = await listAddresses(db, user.id);
  if (!listed.ok) return err(statusFor(listed.kind), listed.message);
  const current = listed.addresses.find((a) => a.id === params.id);
  if (!current) return err(404, 'Address not found');

  // Validate the merged row, so a partial patch cannot leave an invalid address.
  const merged: Record<string, unknown> = {};
  for (const k of EDITABLE) merged[k] = body[k] !== undefined ? body[k] : current[k];
  const checked = validateSavedAddress(merged);
  if (!checked.ok) return err(400, checked.error, checked.field);

  const patch: Partial<NewAddress> = {};
  for (const k of EDITABLE) if (body[k] !== undefined) patch[k] = checked.address[k];
  if (body.location !== undefined) {
    const loc = parseShopLocation(body.location);
    if (!loc.ok) return err(400, loc.error, 'location');
    patch.location = loc.location;
  }
  if (body.is_default === true) patch.is_default = true;

  const res = await updateAddress(db, user.id, params.id, patch);
  if (!res.ok) return err(statusFor(res.kind), res.message);
  return NextResponse.json({ address: res.address });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const user = await getAuthUser();
  if (!user) return err(401, 'Unauthorized');
  if (!isUuid(params.id)) return err(404, 'Address not found');

  const res = await deleteAddress(createServerSupabaseClient(), user.id, params.id);
  if (!res.ok) return err(statusFor(res.kind), res.message);
  return NextResponse.json({ deleted: true, new_default_id: res.new_default_id });
}
