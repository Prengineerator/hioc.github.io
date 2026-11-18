import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { PLACEHOLDER_PRICE_INR } from '@/lib/shop/catalog';
import { LIST_PRICE_ERROR, parseProductPatch, productPatchListingError, productPatchNeedsV2 } from '@/lib/shop/owner';

export const dynamic = 'force-dynamic';

// PATCH /api/owner/shop/products/[id] — owner only. Body: any of
//   { price_inr, listed, in_stock, ship_weight_kg, description }
// validated by parseProductPatch. A product still at the placeholder price
// can't be listed ("Set a real price before listing this product"). An
// out-of-stock product shows on /shop as "Out of stock" and can't be ordered.
// Price changes never touch existing orders: their lines are frozen at
// checkout. Responds { product }.
const PRODUCT_COLUMNS =
  'id, name, sku, price_inr, net_qty, in_stock, sort_order, line, display_name, pack_grams, ship_weight_kg, listed, requires_grind, description';

const PRODUCT_V1_COLUMNS = 'id, name, sku, price_inr, net_qty, in_stock, sort_order';
const V2_PENDING = 'Apply supabase/2026-11-shop-v2.sql to edit prices, listing, weight and descriptions';

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!/^[a-z0-9-]{1,40}$/.test(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = parseProductPatch(body);
  if (!parsed.ok) return errorResponse(400, parsed.error);
  const { patch } = parsed;
  const needsV2 = productPatchNeedsV2(patch);

  const admin = createAdminSupabaseClient();
  // Before the v2 migration there is no `listed` column: the in-stock toggle
  // still works on the v1 columns; anything else says what to apply.
  let current = await admin.from('shop_products').select('price_inr, listed').eq('id', params.id).maybeSingle();
  let v1Only = false;
  if (current.error && isMissingColumnError(current.error)) {
    if (needsV2) return errorResponse(503, V2_PENDING);
    v1Only = true;
    current = await admin.from('shop_products').select('price_inr').eq('id', params.id).maybeSingle();
  }
  if (current.error) {
    console.error('owner shop product read failed', current.error);
    return errorResponse(500, 'Could not save that just now — please try again.');
  }
  if (!current.data) return notFound();

  const listingError = v1Only ? null : productPatchListingError(patch, current.data);
  if (listingError) return errorResponse(400, listingError);

  // Closes the read-then-update race: when the row ends up listed and this
  // patch doesn't set the price, the stored price must still be a real one.
  // (A patched price was already checked above; testing the old stored price
  // would wrongly block a legitimate price fix.)
  const priceGuard =
    !v1Only && patch.price_inr === undefined && (patch.listed ?? (current.data as { listed?: unknown }).listed === true);
  const run = (columns: string) => {
    let q = admin
      .from('shop_products')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', params.id);
    if (priceGuard && !v1Only) q = q.gt('price_inr', PLACEHOLDER_PRICE_INR);
    return q.select(columns).maybeSingle();
  };
  let { data, error } = await run(v1Only ? PRODUCT_V1_COLUMNS : PRODUCT_COLUMNS);
  if (error && isMissingColumnError(error)) {
    if (needsV2) return errorResponse(503, V2_PENDING);
    v1Only = true;
    ({ data, error } = await run(PRODUCT_V1_COLUMNS));
  }
  if (error) {
    console.error('owner shop product update failed', error);
    return errorResponse(500, 'Could not save that just now — please try again.');
  }
  if (!data) {
    // The row was read a moment ago, so with the price guard on, no row back
    // means the price was changed to the placeholder in between.
    return priceGuard && !v1Only ? errorResponse(400, LIST_PRICE_ERROR) : notFound();
  }
  return NextResponse.json({ product: data });
}
