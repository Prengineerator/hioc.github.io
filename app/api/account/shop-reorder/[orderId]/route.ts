import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { flags } from '@/lib/flags';
import { ownsShopOrder, verifiedEmailOf } from '@/lib/account/history';
import { isMissingShopSchema, loadShopProducts, toShopOrderRow } from '@/lib/shop/server';
import { resolveShopReorder } from '@/lib/shop/reorder';
import type { CustomerAddress } from '@/lib/shop/types';

export const dynamic = 'force-dynamic';

// GET /api/account/shop-reorder/[orderId] — a past SHOP order re-priced
// against today's catalogue (docs/SHOP-V2-SPEC.md E4, E3): lines that can
// still be bought, what was skipped and why, what changed price, and the
// address to preselect (a saved one when it matches, else the order's own).
// The /shop page opens on its Pay step with this cart (lib/shop/useShopReorder).
//
// Flag-gated (404 with the shop off), signed-in only, and the ownership check
// doubles as the 404 so an order id never reveals whose it is. Unpaid and
// lapsed orders were never the customer's order: 404 too. Reads via the
// admin client after the session is verified, scoped to the caller's own id
// for the address book.
export async function GET(_request: Request, { params }: { params: { orderId: string } }) {
  if (!flags.shop) return notFound();

  const user = await getAuthUser();
  if (!user) return unauthorized();

  if (!isUuid(params.orderId)) return errorResponse(400, 'orderId must be a valid uuid');

  const admin = createAdminSupabaseClient();

  const { data: raw, error } = await admin.from('shop_orders').select('*').eq('id', params.orderId).maybeSingle();
  if (error) {
    if (isMissingShopSchema(error)) return notFound();
    return errorResponse(500, 'Failed to load order');
  }
  if (!raw) return notFound();
  const order = toShopOrderRow(raw as Record<string, unknown>);

  const { data: profile } = await admin
    .from('profiles')
    .select('phone, phone_verified')
    .eq('id', user.id)
    .maybeSingle();
  if (!ownsShopOrder(order, user.id, profile, verifiedEmailOf(user))) return notFound();
  if (order.status === 'payment_pending' || order.status === 'expired') return notFound();

  const catalogue = await loadShopProducts(admin);
  if (!catalogue.ok) return errorResponse(catalogue.missingSchema ? 404 : 500, 'Could not load the shop');

  // The address book is a convenience: a missing table or a failed read just
  // means nothing is preselected.
  let saved: CustomerAddress[] = [];
  const book = await admin.from('customer_addresses').select('*').eq('user_id', user.id);
  if (!book.error) saved = (book.data ?? []) as CustomerAddress[];

  return NextResponse.json(resolveShopReorder(order, catalogue.products, saved), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
