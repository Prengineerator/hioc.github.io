// Buying a HIOC Ritual on /ritual (components/passes/RitualExperience.tsx): the
// rule that a second Buy never starts a second sale while the first one may
// already be paid. Pure, so it is unit-tested without a renderer.
//
// A sale whose payment window reported SUCCESS is remembered (MaybePaidSale)
// until it is settled one way or the other. Before, two things could happen
// after the window said "paid" but the page didn't see the Ritual appear:
//   * verifying the payment failed (a network blip after the money was taken):
//     the page showed an error with Buy available again;
//   * verification passed but the Ritual took longer than the wait loop
//     ("Still setting up"): Buy was available again too.
// Either way a tap on Buy created a NEW sale and took the money a second time.
// Now Buy first asks the server about the earlier sale (GET
// /api/payments/[orderId]/status, which also checks with the gateway):
//
//   paid / partially refunded ──▶ wait for that Ritual instead of selling another
//   payment pending / unpaid / refunded ──▶ nothing is held: sell (and forget the earlier one)
//   no answer, or one this page doesn't know ──▶ don't sell; say so
//
// 'payment_pending' after the server has asked the gateway means no captured
// payment exists for that sale: Razorpay orders are created auto-capture
// (lib/payments/gateway.ts), so a payment that really succeeded is captured.

import { outcomeMayHaveCharged, type RazorpayOutcome } from '@/lib/payments/razorpayCheckout';

export interface MaybePaidSale {
  orderId: string;
  planName: string;
}

/** Should this sale be remembered as possibly paid, after its window closed this way? */
export function saleMayBePaid(outcome: RazorpayOutcome): boolean {
  return outcomeMayHaveCharged(outcome);
}

export type EarlierSaleDecision = 'wait_for_pass' | 'sell' | 'blocked';

/**
 * `paymentStatus`: the earlier sale's payment_status as the server answered it,
 * 'not_found' when there is no such order, or null if it couldn't be asked.
 */
export function afterEarlierSaleCheck(paymentStatus: string | null): EarlierSaleDecision {
  switch (paymentStatus) {
    case 'paid':
    case 'partially_refunded':
      return 'wait_for_pass';
    case 'payment_pending':
    case 'unpaid':
    case 'refunded':
    case 'not_found':
      return 'sell';
    default:
      return 'blocked';
  }
}

export const EARLIER_SALE_UNKNOWN_MSG =
  "We couldn't check on your last payment just now, so we haven't started a new one. Please try again in a moment.";
