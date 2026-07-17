import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isOrderStatus, isUuid, ORDER_STATUSES } from '@/lib/api/constants';
import type { Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/orders/[id]/status — staff-only. Only `status` is editable here;
// all 4 enum values are accepted unconditionally (no forward-only guard —
// the frontend presents the linear flow, the API does not enforce it).
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
  if (!body || !isOrderStatus(body.status)) {
    return errorResponse(400, `status is required and must be one of: ${ORDER_STATUSES.join(', ')}`);
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('orders')
    .update({ status: body.status })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to update order status');
  }
  if (!data) {
    return notFound();
  }

  return NextResponse.json({ order: data as Order });
}
