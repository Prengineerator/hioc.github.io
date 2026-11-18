import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { verifiedEmailOf } from '@/lib/account/history';
import { normalizeEmail } from '@/lib/email';
import { flags } from '@/lib/flags';
import { normalizeIndianMobile } from '@/lib/phone';
import { serverQuote, type ShopBuyer } from '@/lib/shop/context';
import { parseCartItems } from '@/lib/shop/pricing';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// POST /api/shop/quote — the price of a cart, exactly as checkout will charge it.
// Body: { items: [{ product_id, quantity, grind? }], coupon_code?, use_beanies? (default true),
//         phone?, email? }.
// Responds 200 { quote, coupon_error, signed_in }:
//   quote         the ShopQuoteV2 from lib/shop/pricing.ts quoteShopCart (offer, coupon,
//                 Beanies, shipping, total, nudges), the same function checkout uses
//   coupon_error  why a typed code was not applied (the quote then uses the best
//                 auto coupon, if any), or null
//   signed_in     whether the caller has an account (decides the Beanies messaging)
// 400 { error } for a cart that can't be priced; 429 when asked too often.
//
// Public, no account needed. `phone` / `email` (what the customer has typed so far)
// only decide whether the introductory offer and a phone-locked code still apply
// to them; a signed-in customer's verified phone and login email are used when
// the body has none. Nothing is written here.
export async function POST(request: Request) {
  if (!flags.shop) return notFound();

  const ip = clientIp(request);
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const couponCode = typeof body.coupon_code === 'string' && body.coupon_code.trim() ? body.coupon_code.trim().slice(0, 40) : null;

  const tooMany = () => errorResponse(429, 'Too many tries — please wait a few minutes.');
  if (!(await rateLimitOk(`shop-quote:${ip}`, 60, 600))) return tooMany();
  // Typed codes are what someone guessing would hammer: a tighter bound of their own.
  if (couponCode && !(await rateLimitOk(`shop-coupon:${ip}`, 20, 600))) return tooMany();

  const cart = parseCartItems(body.items);
  if (!cart.ok) return errorResponse(400, cart.error);

  const admin = createAdminSupabaseClient();

  let user: Awaited<ReturnType<typeof getAuthUser>> = null;
  try {
    user = await getAuthUser();
  } catch {
    user = null; // a guest
  }

  const typedPhone = typeof body.phone === 'string' ? normalizeIndianMobile(body.phone) : null;
  const typedEmail = typeof body.email === 'string' ? normalizeEmail(body.email) : null;
  let phone = typedPhone ? `+91${typedPhone}` : null;
  let email = typedEmail;
  if (user) {
    if (!phone) {
      try {
        const { data: profile } = await admin.from('profiles').select('phone, phone_verified').eq('id', user.id).maybeSingle();
        const p = profile as { phone?: string | null; phone_verified?: boolean | null } | null;
        if (p?.phone_verified && p.phone) {
          const digits = normalizeIndianMobile(p.phone);
          phone = digits ? `+91${digits}` : null;
        }
      } catch {
        // no verified phone to offer; the quote just goes without it
      }
    }
    if (!email) email = verifiedEmailOf(user);
  }

  const buyer: ShopBuyer = { userId: user?.id ?? null, phone, email };
  const result = await serverQuote(admin, {
    items: cart.items,
    buyer,
    coupon_code: couponCode,
    use_beanies: body.use_beanies !== false,
  });
  if (!result.ok) return errorResponse(result.status, result.error);

  return NextResponse.json({ quote: result.quote, coupon_error: result.coupon_error, signed_in: Boolean(user) }, { headers: NO_STORE });
}
