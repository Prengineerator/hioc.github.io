import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOrderWithCoupon, type OrderWithCoupon } from '@/lib/orders/getOrder';

// The order shape the staff KOT/receipt/token print pages render: the customer
// receipt loader's output (order + items + addons + coupon label) plus the
// loyalty points *earned* on this order, surfaced on the receipt when present.
export type StaffPrintOrder = OrderWithCoupon & { points_earned: number | null };

/**
 * Loads one order for the staff print surfaces (KOT-1 / KOT-2). Reuses the
 * existing customer-receipt loader (`getOrderWithCoupon`) verbatim so the bill
 * data is identical to what the customer sees, then best-effort augments it with
 * the loyalty points earned on the order (from `loyalty_transactions`, type
 * 'earn'). The loyalty lookup is non-fatal — a missing/empty ledger just omits
 * the "points earned" line rather than failing the print. Returns null when the
 * id doesn't resolve so the page can 404.
 */
export async function getStaffPrintOrder(id: string): Promise<StaffPrintOrder | null> {
  const order = await getOrderWithCoupon(id);
  if (!order) {
    return null;
  }

  let points_earned: number | null = null;
  try {
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin
      .from('loyalty_transactions')
      .select('points')
      .eq('order_id', id)
      .eq('type', 'earn');
    if (!error && data && data.length > 0) {
      const rows = data as { points: number }[];
      points_earned = rows.reduce((sum, r) => sum + (r.points ?? 0), 0);
    }
  } catch {
    /* loyalty ledger optional/absent — non-fatal, receipt still prints */
  }

  return { ...order, points_earned };
}
