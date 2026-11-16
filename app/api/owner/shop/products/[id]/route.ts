import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// PATCH /api/owner/shop/products/[id] — owner only. Body: { in_stock: boolean }.
// An out-of-stock flavour shows on /shop as "Out of stock" and can't be
// ordered. Responds { product }.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!/^[a-z0-9-]{1,40}$/.test(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (typeof body?.in_stock !== 'boolean') return errorResponse(400, 'in_stock must be true or false');

  const { data, error } = await createAdminSupabaseClient()
    .from('shop_products')
    .update({ in_stock: body.in_stock, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select('id, name, sku, price_inr, net_qty, in_stock, sort_order')
    .maybeSingle();
  if (error) {
    console.error('owner shop product update failed', error);
    return errorResponse(500, 'Could not save that just now — please try again.');
  }
  if (!data) return notFound();
  return NextResponse.json({ product: data });
}
