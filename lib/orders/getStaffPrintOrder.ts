import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOrderWithCoupon, type OrderWithCoupon } from '@/lib/orders/getOrder';
import { loyaltyUserIdFor } from '@/lib/loyalty/beneficiary';
import { getBalance, getLoyaltyConfig, computeEarnedPoints } from '@/lib/loyalty/ledger';
import type { OrderStatus } from '@/lib/types';

// The order shape the staff KOT/receipt/token print pages render: the customer
// receipt loader's output (order + items + addons + coupon label) plus the
// loyalty points *earned* and *redeemed* on this order, and the customer's
// current points *balance* — all surfaced on the receipt when present.
export type StaffPrintOrder = OrderWithCoupon & {
  points_earned: number | null;
  points_redeemed: number | null;
  points_balance: number | null;
};

// PRN-8: an order's 'earn' row (lib/loyalty/ledger.ts earnForOrder) is only
// written when the order transitions to 'completed', but the receipt
// normally prints right after payment/settle — well before that transition.
// Printed at any OTHER status, "points earned" would be genuinely unknown
// yet (not zero) unless projected. Cancelled/rejected orders are the one
// case that's NOT just "not completed yet" — they will never earn, so no
// projection applies there.
const NEVER_EARNS: ReadonlySet<OrderStatus> = new Set(['cancelled', 'rejected']);

async function fetchLoyaltyTransactions(orderId: string): Promise<{ type: string; points: number }[] | null> {
  try {
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin
      .from('loyalty_transactions')
      .select('type, points')
      .eq('order_id', orderId)
      .in('type', ['earn', 'redeem']);
    if (error || !data) return null;
    return data as { type: string; points: number }[];
  } catch {
    return null;
  }
}

/**
 * Loads one order for the staff print surfaces (KOT-1 / KOT-2). Reuses the
 * existing customer-receipt loader (`getOrderWithCoupon`) verbatim so the bill
 * data is identical to what the customer sees, then best-effort augments it
 * with loyalty info: points earned/redeemed on THIS order and the customer's
 * current ledger balance, resolved to whichever account this order belongs
 * to — `customer_user_id ?? user_id` (see `lib/loyalty/beneficiary.ts`, the
 * same rule `earnForOrder`/`redeemForOrder`/`reverseForOrder` use).
 *
 * "Points earned" is either the real ledger row (once `earnForOrder` has
 * posted it, at order completion) or, until then, a PROJECTION of what the
 * order is about to earn — same formula as `earnForOrder`
 * (`computeEarnedPoints`, shared from lib/loyalty/ledger.ts so the two can't
 * drift), applied only when: the order hasn't already earned (no 'earn' row
 * yet), it belongs to a loyalty account, it's paid, and it isn't
 * cancelled/rejected (which never earn). When projected, "points balance"
 * includes it too, so the number on the receipt is the balance the customer
 * will actually have once this order settles — never double-added once the
 * real ledger row exists, since at that point the ledger balance already
 * reflects it and no projection is added on top.
 *
 * Every loyalty lookup here is best-effort, independent, and run in
 * parallel (printing must stay fast and must never fail because the loyalty
 * ledger is unavailable) — a missing/empty ledger, a lookup failure, or an
 * unlinked guest order just omits that field (the receipt prints nothing for
 * it) rather than failing or slowing down the print. Returns null when the
 * id doesn't resolve so the page can 404.
 */
export async function getStaffPrintOrder(id: string): Promise<StaffPrintOrder | null> {
  const order = await getOrderWithCoupon(id);
  if (!order) {
    return null;
  }

  const loyaltyUserId = loyaltyUserIdFor(order);

  const [rows, config, ledgerBalance] = await Promise.all([
    fetchLoyaltyTransactions(id),
    getLoyaltyConfig().catch(() => null),
    loyaltyUserId
      ? getBalance(loyaltyUserId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const earnRows = (rows ?? []).filter((r) => r.type === 'earn');
  const redeemRows = (rows ?? []).filter((r) => r.type === 'redeem');

  let points_earned: number | null = earnRows.length > 0 ? earnRows.reduce((sum, r) => sum + (r.points ?? 0), 0) : null;
  const points_redeemed: number | null =
    redeemRows.length > 0
      ? // Stored negative (redeemForOrder inserts `points: -points`) — the
        // receipt shows how many points were spent, a positive count.
        Math.abs(redeemRows.reduce((sum, r) => sum + (r.points ?? 0), 0))
      : null;

  let projectedEarn = 0;
  if (
    points_earned === null &&
    loyaltyUserId &&
    config &&
    order.payment_status === 'paid' &&
    !NEVER_EARNS.has(order.status)
  ) {
    const amountInr = order.total_inr ?? order.subtotal_inr ?? 0;
    const projected = computeEarnedPoints(amountInr, config);
    if (projected > 0) {
      projectedEarn = projected;
      points_earned = projected;
    }
  }

  // ledgerBalance is only fetched (non-null) for a linked account; a guest
  // order stays null so the receipt shows no balance at all. `projectedEarn`
  // is 0 whenever an 'earn' row already exists, so this never double-counts.
  const points_balance: number | null = ledgerBalance !== null ? ledgerBalance + projectedEarn : null;

  return { ...order, points_earned, points_redeemed, points_balance };
}
