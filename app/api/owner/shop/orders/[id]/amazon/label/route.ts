import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { getShopOrder } from '@/lib/shop/server';
import { getAmazonLabel } from '@/lib/shop/amazonShipping';
import { isAmazonOrder, shopOrderRef } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

// GET /api/owner/shop/orders/[id]/amazon/label — owner only. The shipping label
// of an Amazon order, to print (or reprint).
//
// Request:  none.
// Response 200: the label as a PDF (Content-Type application/pdf,
//           Cache-Control no-store, X-Content-Type-Options nosniff). Open it in a new tab.
// Errors: { error } with 404, 409 (not an Amazon order), 502 (Amazon would not
//   give the label), 503.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!isAmazonOrder(order)) return errorResponse(409, "This order hasn't been booked with Amazon Shipping.");

  const ref = shopOrderRef(order.order_number);
  const label = await getAmazonLabel(order.amazon_shipment_id as string, ref);
  if (!label.ok) return errorResponse(502, label.error);
  const pdf = Buffer.from(label.labelBase64, 'base64');
  // Serve only what really is a PDF (never an HTML or script payload under our origin).
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') return errorResponse(502, 'Amazon Shipping sent a label that is not a PDF.');
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${ref}-label.pdf"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
