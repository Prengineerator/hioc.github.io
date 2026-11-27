import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { normalizeEmail } from '@/lib/email';
import { normalizeIndianMobile } from '@/lib/phone';
import { parseOwnerDiscountAmount } from '@/lib/shop/ownerOrders';
import { ownerQuoteView, priceOwnerOrder } from '@/lib/shop/ownerPricing';
import { parseCartItems } from '@/lib/shop/pricing';

export const dynamic = 'force-dynamic';

// POST /api/owner/shop/quote — owner only (401 for anyone else). The bill the New
// order page shows, priced by the same server code as the website
// (lib/shop/context.ts serverQuote → quoteShopCart), without Beanies, plus the
// owner discount. Nothing is written.
// Body: { phone, email?, items: [{ product_id, quantity, grind? }], coupon_code?, owner_discount_inr? }
// 200 { quote: { lines, subtotal_inr, offer_discount_inr, offer_name, coupon_discount_inr,
//        coupon_code, owner_discount_inr, shipping_inr, total_inr, intro_offer_applied,
//        notes: string[] }, account_linked }
// 4xx/5xx { error } (a cart or discount that can't be priced is 400).
export async function POST(request: Request) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!(await rateLimitOk(`owner-shop-quote:${clientIp(request)}`, 60, 600))) {
    return errorResponse(429, 'Too many tries — please wait a few minutes.');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const digits = typeof body.phone === 'string' ? normalizeIndianMobile(body.phone) : null;
  if (!digits) return errorResponse(400, 'Enter a 10-digit Indian mobile number');
  const typedEmail = typeof body.email === 'string' && body.email.trim() ? normalizeEmail(body.email) : null;
  if (typeof body.email === 'string' && body.email.trim() && !typedEmail) return errorResponse(400, 'Enter a valid email address');

  const cart = parseCartItems(body.items);
  if (!cart.ok) return errorResponse(400, cart.error);
  const discount = parseOwnerDiscountAmount(body.owner_discount_inr);
  if (discount === null) return errorResponse(400, 'The owner discount must be a whole rupee amount');
  const couponCode = typeof body.coupon_code === 'string' && body.coupon_code.trim() ? body.coupon_code.trim().slice(0, 40) : null;

  const admin = createAdminSupabaseClient();
  const { priced, userId } = await priceOwnerOrder(admin, {
    phoneE164: `+91${digits}`,
    email: typedEmail,
    items: cart.items,
    couponCode,
    ownerDiscountInr: discount,
  });
  if (!priced.ok) return errorResponse(priced.status, priced.error);
  const q = priced.quote;

  return NextResponse.json(
    {
      quote: ownerQuoteView(q, priced.coupon_error),
      account_linked: userId !== null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
