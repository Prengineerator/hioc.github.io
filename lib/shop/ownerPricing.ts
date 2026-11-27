// The server's price for an owner-entered order (docs/SHOP-OWNER-ORDERS-SPEC.md):
// the website's serverQuote (lib/shop/context.ts) for the customer behind the
// phone, with no Beanies (the customer isn't signed in to agree to spend them)
// and the owner discount added as the step after offers and coupons.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findVerifiedCustomerByPhone } from '@/lib/loyalty/customerLink';
import { serverQuote, type ServerQuote } from './context';
import type { CartItem } from './pricing';

export async function priceOwnerOrder(
  admin: SupabaseClient,
  req: { phoneE164: string; email: string | null; items: CartItem[]; couponCode: string | null; ownerDiscountInr: number },
): Promise<{ priced: ServerQuote; userId: string | null }> {
  // The account that holds this phone verified (exactly one), so the introductory
  // offer and phone-locked coupons are decided for the whole customer.
  const linked = await findVerifiedCustomerByPhone(admin, req.phoneE164);
  const userId = linked?.userId ?? null;
  const priced = await serverQuote(admin, {
    items: req.items,
    buyer: { userId, phone: req.phoneE164, email: req.email },
    coupon_code: req.couponCode,
    use_beanies: false,
    owner_discount_inr: req.ownerDiscountInr,
  });
  return { priced, userId };
}

/** The quote as the New order page reads it (same shape as POST /api/owner/shop/quote). */
export function ownerQuoteView(
  q: {
    lines: unknown;
    subtotal_inr: number;
    offer_discount_inr: number;
    offer_name: string | null;
    coupon_discount_inr: number;
    coupon_code: string | null;
    owner_discount_inr: number;
    shipping_inr: number;
    total_inr: number;
    intro_offer_applied: boolean;
    discount_choice_note: string | null;
    nudges: { free_shipping: string | null };
  },
  couponError: string | null,
) {
  return {
    lines: q.lines,
    subtotal_inr: q.subtotal_inr,
    offer_discount_inr: q.offer_discount_inr,
    offer_name: q.offer_name,
    coupon_discount_inr: q.coupon_discount_inr,
    coupon_code: q.coupon_code,
    owner_discount_inr: q.owner_discount_inr,
    shipping_inr: q.shipping_inr,
    total_inr: q.total_inr,
    intro_offer_applied: q.intro_offer_applied,
    notes: [couponError, q.discount_choice_note, q.nudges.free_shipping].filter((n): n is string => Boolean(n)),
  };
}

