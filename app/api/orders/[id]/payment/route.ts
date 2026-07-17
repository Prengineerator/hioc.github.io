import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isPaymentMethod, isUuid, PAYMENT_METHODS } from '@/lib/api/constants';
import type { Order, PaymentStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };
const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'unpaid',
  'payment_pending',
  'paid',
  'refunded',
  'partially_refunded',
];

// PATCH /api/orders/[id]/payment — staff/owner only. Records how a walk-up paid
// (STF-041): sets payment_method and payment_status (defaults to 'paid' when a
// method is provided). Fulfillment status is untouched — payment tracking is
// deliberately independent of the order_status lifecycle.
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const body = await parseJsonBody(request);
  if (!body || !isPaymentMethod(body.payment_method)) {
    return errorResponse(400, `payment_method is required and must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }

  let paymentStatus: PaymentStatus = 'paid';
  if (body.payment_status !== undefined) {
    if (
      typeof body.payment_status !== 'string' ||
      !(PAYMENT_STATUSES as readonly string[]).includes(body.payment_status)
    ) {
      return errorResponse(400, `payment_status must be one of: ${PAYMENT_STATUSES.join(', ')}`);
    }
    paymentStatus = body.payment_status as PaymentStatus;
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('orders')
    .update({ payment_method: body.payment_method, payment_status: paymentStatus })
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to record payment');
  }
  if (!data) {
    return notFound();
  }

  return NextResponse.json({ order: data as Order });
}
