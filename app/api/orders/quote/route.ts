import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getStoreSettings } from '@/lib/store/settings';
import { computeBill } from '@/lib/store/hours';
import { validateAndComputeCoupon } from '@/lib/promotions/coupons';
import { getBalance, quoteRedemption } from '@/lib/loyalty/ledger';

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

  const { subtotal_inr, coupon_code, redeem_points, item_ids, categories } = body;

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

  const user = await getAuthUser();
  const userId = user?.id ?? null;

  const settings = await getStoreSettings();

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
      pointsResult = await quoteRedemption(userId, redeem_points, remaining);
      if (pointsResult.ok) {
        pointsDiscountInr = pointsResult.discountInr;
      }
    }
  }

  const discount_inr = Math.min(couponDiscountInr + pointsDiscountInr, subtotal_inr);
  const bill = computeBill(subtotal_inr, settings, discount_inr);

  return NextResponse.json({ bill, coupon: couponResult, points: pointsResult, balance });
}
