import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser, getCounterActor } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getStoreSettings } from '@/lib/store/settings';
import { computeBill } from '@/lib/store/hours';
import { validateAndComputeCoupon } from '@/lib/promotions/coupons';
import { getBalance, quoteRedemption } from '@/lib/loyalty/ledger';
import { findVerifiedCustomerByPhone, toStoredPhone } from '@/lib/loyalty/customerLink';

export const dynamic = 'force-dynamic';

// POST /api/orders/quote — public. A NON-authoritative checkout preview:
// given a client-computed cart subtotal (+ an optional coupon code / points
// to redeem), returns the full bill breakup (subtotal/GST/packaging/coupon
// discount/points discount/total) so CheckoutForm can show it live (PAY-1)
// before the customer submits. POST /api/orders re-derives everything
// server-side from the actual cart + session at submit time — this route
// never creates or mutates anything, so a stale/spoofed subtotal here can't
// cost the business money.
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const { subtotal_inr, taxable_subtotal_inr, coupon_code, redeem_points, item_ids, categories, order_type, customer_phone } =
    body;

  // Dine-in has no packaging charge (D5). The quote is a preview only, so we
  // don't hard-validate order_type here — any non-'dine_in' value is treated as
  // packaged, exactly as POST /api/orders re-derives authoritatively at submit.
  const isDineIn = order_type === 'dine_in';

  if (typeof subtotal_inr !== 'number' || !Number.isFinite(subtotal_inr) || subtotal_inr < 0) {
    return errorResponse(400, 'subtotal_inr must be a non-negative number');
  }

  let itemIds: string[] = [];
  if (item_ids !== undefined) {
    if (!Array.isArray(item_ids) || item_ids.some((v) => typeof v !== 'string')) {
      return errorResponse(400, 'item_ids must be an array of strings');
    }
    itemIds = item_ids as string[];
  }

  let cats: string[] = [];
  if (categories !== undefined) {
    if (!Array.isArray(categories) || categories.some((v) => typeof v !== 'string')) {
      return errorResponse(400, 'categories must be an array of strings');
    }
    cats = categories as string[];
  }

  // VAL-1 — whose promotions and points this preview is about.
  //
  // On the web that is the caller's own session, as it always was. At the
  // counter the caller is STAFF (a classic session, or — PIN-3 — an enrolled
  // device's operator) and the beneficiary is the customer in front of them,
  // resolved from their phone by the same server-side, verified-only rule
  // POST /api/orders uses (never a body-supplied user id).
  //
  // Gated on staff access on purpose: this route is public and returns a
  // points balance, so resolving a phone for anyone would turn it into a
  // "how many points does this number have?" oracle for the whole internet.
  //
  // getAuthUser() and getCounterActor() are fetched concurrently rather than
  // one deriving the other (same accepted duplication as POST /api/orders):
  // getCounterActor() re-resolves its own session internally, and this route
  // fires on every cart change for what's usually an anonymous visitor, so
  // paying for a second round trip only when a session actually exists is the
  // right trade — see that route's own comment on why they can't share one.
  // Perf: getStoreSettings() depends on none of the auth/phone-link work above
  // it (same reasoning as POST /api/orders), so it's fired alongside those
  // instead of waiting behind them — this route runs on every cart edit, so
  // that's a round trip shaved off of every keystroke's re-quote, not just one.
  const [user, actor, settings] = await Promise.all([getAuthUser(), getCounterActor(), getStoreSettings()]);
  const isStaff = actor !== null;
  const linked = isStaff
    ? await findVerifiedCustomerByPhone(createAdminSupabaseClient(), toStoredPhone(customer_phone))
    : null;
  const userId = linked?.userId ?? (isStaff ? null : (user?.id ?? null));

  let couponResult: Awaited<ReturnType<typeof validateAndComputeCoupon>> | null = null;
  let couponDiscountInr = 0;
  if (typeof coupon_code === 'string' && coupon_code.trim().length > 0) {
    couponResult = await validateAndComputeCoupon(coupon_code.trim(), {
      subtotalInr: subtotal_inr,
      userId,
      itemIds,
      categories: cats,
    });
    if (couponResult.ok) {
      couponDiscountInr = Math.min(couponResult.discountInr, subtotal_inr);
    }
  }

  let balance: number | null = null;
  let pointsResult: Awaited<ReturnType<typeof quoteRedemption>> | null = null;
  let pointsDiscountInr = 0;
  if (userId) {
    balance = await getBalance(userId);
    if (typeof redeem_points === 'number' && redeem_points > 0) {
      const remaining = Math.max(0, subtotal_inr - couponDiscountInr);
      // `balance` was just fetched above for the response's own `balance`
      // field — hand it to quoteRedemption so it doesn't re-scan
      // loyalty_transactions for the same number a moment later.
      pointsResult = await quoteRedemption(userId, redeem_points, remaining, balance);
      if (pointsResult.ok) {
        pointsDiscountInr = pointsResult.discountInr;
      }
    }
  }

  const discount_inr = Math.min(couponDiscountInr + pointsDiscountInr, subtotal_inr);
  // GST-exempt lines (2026-09-gst-exempt): the client says how much of the
  // subtotal is taxable. This is a preview only — the order route recomputes
  // it from the menu — so an absent or odd value just falls back to taxing
  // the whole subtotal (computeBill also clamps it to the subtotal).
  const taxable =
    typeof taxable_subtotal_inr === 'number' && Number.isFinite(taxable_subtotal_inr)
      ? taxable_subtotal_inr
      : subtotal_inr;
  const bill = computeBill(subtotal_inr, settings, discount_inr, taxable);

  // Mirror the create path: dine-in drops packaging from the previewed total.
  if (isDineIn && bill.packaging_inr !== 0) {
    bill.total_inr -= bill.packaging_inr;
    bill.packaging_inr = 0;
  }

  return NextResponse.json({ bill, coupon: couponResult, points: pointsResult, balance });
}
