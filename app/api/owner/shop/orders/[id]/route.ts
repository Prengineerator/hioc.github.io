import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { runAfterResponse } from '@/lib/api/background';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { sendShopShippedEmail } from '@/lib/shop/emails';
import { parseShippedInput } from '@/lib/shop/owner';
import { getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { canMarkDelivered, canMarkShipped } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

// PATCH /api/owner/shop/orders/[id] — owner only. The by-hand path, for an
// order shipped without the one click (created in the Shiprocket panel, or
// any other courier), or when the API is down:
//   { action: 'mark_shipped', awb_code, courier_name? }   → shipped (customer
//                                                           emailed tracking)
//   { action: 'mark_delivered' }                          → delivered
// Responds { order }.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();

  const now = new Date().toISOString();

  if (body.action === 'mark_shipped') {
    if (!canMarkShipped(order)) return errorResponse(409, 'Only a paid order that has not shipped can be marked shipped.');
    const input = parseShippedInput(body);
    if (!input.ok) return errorResponse(400, input.error);
    const updated = await updateShopOrderIf(admin, order.id, ['paid', 'sent_to_shiprocket'], {
      status: 'shipped',
      awb_code: input.awb_code,
      courier_name: input.courier_name ?? order.courier_name,
      shipped_at: now,
    });
    if (!updated) return errorResponse(409, 'The order changed meanwhile — reload the page.');
    runAfterResponse(sendShopShippedEmail(updated));
    return NextResponse.json({ order: updated });
  }

  if (body.action === 'mark_delivered') {
    if (!canMarkDelivered(order)) return errorResponse(409, 'Only a shipped order can be marked delivered.');
    const updated = await updateShopOrderIf(admin, order.id, ['shipped'], { status: 'delivered', delivered_at: now });
    if (!updated) return errorResponse(409, 'The order changed meanwhile — reload the page.');
    return NextResponse.json({ order: updated });
  }

  return errorResponse(400, "action must be 'mark_shipped' or 'mark_delivered'");
}
