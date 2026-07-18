import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { quoteRedemption } from '@/lib/loyalty/ledger';

export const dynamic = 'force-dynamic';

// POST /api/loyalty/quote — logged-in customers only. Lets the (client-side)
// checkout preview a points redemption before submitting the order. Body:
// { points, subtotal_inr }. Response mirrors RedeemQuote in snake_case:
//   { ok: boolean, points: number, discount_inr: number, reason?: string }
export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { points, subtotal_inr } = body;
  if (typeof points !== 'number' || !Number.isInteger(points) || points <= 0) {
    return errorResponse(400, 'points is required and must be a positive integer');
  }
  if (typeof subtotal_inr !== 'number' || !Number.isFinite(subtotal_inr) || subtotal_inr < 0) {
    return errorResponse(400, 'subtotal_inr is required and must be a non-negative number');
  }

  const quote = await quoteRedemption(user.id, points, subtotal_inr);

  return NextResponse.json({
    ok: quote.ok,
    points: quote.points,
    discount_inr: quote.discountInr,
    reason: quote.reason,
  });
}
