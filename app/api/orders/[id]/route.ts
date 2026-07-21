import { NextResponse } from 'next/server';
import { notFound } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getOrderWithCoupon } from '@/lib/orders/getOrder';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// GET /api/orders/[id] — public. Single-row lookup only (the opaque uuid in
// the URL IS the access control) — this route must never expose a listing
// capability. Uses the service-role client since anon has no orders select
// policy (see supabase/schema.sql). Shares getOrderWithCoupon() with the
// server-rendered receipt page so the two can never drift.
export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const order = await getOrderWithCoupon(id);
  if (!order) {
    return notFound();
  }

  return NextResponse.json({ order });
}
