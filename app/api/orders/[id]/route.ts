import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// GET /api/orders/[id] — public. Single-row lookup only (the opaque uuid in
// the URL IS the access control) — this route must never expose a listing
// capability. Uses the service-role client since anon has no orders select
// policy (see supabase/schema.sql).
export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to load order');
  }
  if (!data) {
    return notFound();
  }

  const order = toOrderResponse(data as OrderRowWithItems);

  // Best-effort: surface the applied coupon's code (if any) for the receipt
  // bill breakup (PAY-1). coupon_redemptions may not exist/be populated until
  // the Promotions engine lands — any failure here just omits the label.
  let coupon_code: string | null = null;
  const { data: redemption, error: redemptionError } = await admin
    .from('coupon_redemptions')
    .select('coupons ( code )')
    .eq('order_id', id)
    .maybeSingle();
  if (!redemptionError && redemption) {
    const coupon = (redemption as unknown as { coupons: { code: string } | null }).coupons;
    coupon_code = coupon?.code ?? null;
  }

  return NextResponse.json({ order: { ...order, coupon_code } });
}
