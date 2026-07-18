import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { validateAndComputeCoupon } from '@/lib/promotions/coupons';
import { isUuid } from '@/lib/api/constants';

export const dynamic = 'force-dynamic';

// POST /api/coupons/validate — public (checkout calls this for both guest and
// logged-in customers). Body: { code, subtotal_inr, item_ids?, categories? }.
// Response is always 200 with a structured result — an invalid/ineligible
// coupon is a normal outcome (`ok: false` + a human-readable `reason`), not an
// HTTP error; only a malformed request body 400s.
//   { ok: boolean, discount_inr: number, coupon?: Coupon, reason?: string }
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { code, subtotal_inr, item_ids, categories } = body;

  if (typeof code !== 'string') {
    return errorResponse(400, 'code is required and must be a string');
  }
  if (typeof subtotal_inr !== 'number' || !Number.isFinite(subtotal_inr) || subtotal_inr < 0) {
    return errorResponse(400, 'subtotal_inr is required and must be a non-negative number');
  }
  if (item_ids !== undefined && (!Array.isArray(item_ids) || item_ids.some((v) => !isUuid(v)))) {
    return errorResponse(400, 'item_ids must be an array of valid uuids');
  }
  if (categories !== undefined && (!Array.isArray(categories) || categories.some((v) => typeof v !== 'string'))) {
    return errorResponse(400, 'categories must be an array of strings');
  }

  // Optional: an authenticated customer's coupon usage counts toward
  // per_user_limit; a guest checkout passes userId: null (only coupons
  // without a per-user cap validate for guests).
  const user = await getAuthUser();

  const result = await validateAndComputeCoupon(code, {
    subtotalInr: subtotal_inr,
    userId: user?.id ?? null,
    itemIds: (item_ids as string[] | undefined) ?? [],
    categories: (categories as string[] | undefined) ?? [],
  });

  return NextResponse.json({
    ok: result.ok,
    discount_inr: result.discountInr,
    coupon: result.coupon,
    reason: result.reason,
  });
}
