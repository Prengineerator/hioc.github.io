import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { toOrderResponse, type OrderRowWithItems, type OrderResponse } from '@/lib/api/orders';

// An order shaped for the customer receipt/status surfaces: the full order row
// (+ items + addons) plus the applied coupon *code* (not stored on the row, so
// resolved best-effort from coupon_redemptions for the discount label).
export type OrderWithCoupon = OrderResponse & { coupon_code: string | null };

/**
 * Loads a single order by its opaque id for the public receipt/status pages.
 *
 * Server-only: uses the service-role client because anon has no `orders` select
 * policy — the opaque uuid in the URL IS the access control (same contract as
 * GET /api/orders/[id]). Returns null when the id doesn't resolve, so callers
 * can render a 404.
 */
export async function getOrderWithCoupon(id: string): Promise<OrderWithCoupon | null> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const order = toOrderResponse(data as OrderRowWithItems);

  // Best-effort coupon-code lookup for the bill's discount label. The
  // coupon_redemptions table may be empty/absent until Promotions is live —
  // any failure here just omits the label rather than failing the receipt.
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

  return { ...order, coupon_code };
}
