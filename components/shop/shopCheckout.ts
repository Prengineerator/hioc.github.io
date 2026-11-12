// Paying for an Instant Coffee order on /shop (components/shop/ShopExperience.tsx).
// Pure, so it is unit-tested without a renderer.
//
// One Pay tap goes:
//
//   [an earlier payment may have gone through] ──ask the server──▶ paid → its order page
//                                                                 unpaid → carry on
//                                                                 can't tell → stop, say so
//   same cart, address and pin as the open checkout ──▶ reopen ITS payment window
//   anything else ──▶ POST /api/shop/checkout, then open the new payment window
//
// Reopening the open checkout (rather than creating another) is what stops a
// second tap after a closed window from making a second order. But it used to
// reopen it even after the window reported SUCCESS and only the verification
// failed — a network blip after Razorpay took the money — offering to take the
// money again for an order that may already be paid. That state is now
// remembered (`mayBePaid`), and the next Pay asks the order's own page route,
// which checks with Razorpay itself, before anything else happens.

import type { RazorpayOutcome } from '@/lib/payments/razorpayCheckout';
import type { CreatedPaymentIntent } from '@/lib/payments/types';

export interface PendingShopPayment {
  /** What the checkout was created for (shopPendingKey of the body that was sent). */
  key: string;
  orderId: string;
  payment: CreatedPaymentIntent;
  /** The payment window reported success but it could not be verified: money may have moved. */
  mayBePaid: boolean;
}

export interface ShopCheckoutBody {
  items: { product_id: string; quantity: number }[];
  address: Record<string, string>;
  location: unknown;
  expected_total_inr: number;
}

export function shopCheckoutBody(
  items: ShopCheckoutBody['items'],
  address: Record<string, string>,
  location: unknown,
  expectedTotalInr: number,
): ShopCheckoutBody {
  return { items, address, location, expected_total_inr: expectedTotalInr };
}

/**
 * Which checkout this is: built from exactly what is SENT. It used to use the
 * validated (normalised) address while the raw form went in the body, so two
 * different bodies could share a key and a checkout.
 */
export function shopPendingKey(body: ShopCheckoutBody): string {
  return JSON.stringify({ items: body.items, address: body.address, location: body.location ?? null });
}

export type ShopPayStep = 'check_earlier' | 'reopen' | 'create';

export function shopPayStep(pending: PendingShopPayment | null, key: string): ShopPayStep {
  // Whatever is in the cart now: a payment that may have gone through is
  // settled first, so a changed cart can't quietly become a second charge.
  if (pending?.mayBePaid) return 'check_earlier';
  if (pending && pending.key === key) return 'reopen';
  return 'create';
}

/** What GET /api/shop/orders/[id] said about the earlier order. */
export type EarlierShopCheck = { kind: 'status'; status: string } | { kind: 'not_found' } | { kind: 'error' };

export type EarlierShopDecision =
  | 'go_to_order' // it was paid: show it, take nothing more
  | 'carry_on' // the server checked with Razorpay and nothing was captured: paying again is safe
  | 'forget' // there is no such order any more
  | 'blocked'; // couldn't tell: do not take money on a guess

export function afterEarlierShopCheck(check: EarlierShopCheck): EarlierShopDecision {
  if (check.kind === 'not_found') return 'forget';
  if (check.kind === 'error') return 'blocked';
  // Only a captured payment moves an order off payment_pending (and only a
  // paid order can later be cancelled), so anything else means money was taken.
  return check.status === 'payment_pending' ? 'carry_on' : 'go_to_order';
}

/** The open checkout after its payment window closed. */
export function pendingAfterOutcome(pending: PendingShopPayment, outcome: RazorpayOutcome): PendingShopPayment {
  if (outcome.kind === 'unverified') return { ...pending, mayBePaid: true };
  return pending;
}

// ---------------------------------------------------------------------------
// The order page's wait for the payment (components/shop/ShopOrderStatus.tsx)
// ---------------------------------------------------------------------------

/** One read of GET /api/shop/orders/[id], as the order page sees it. */
export type ShopOrderRead = { kind: 'order'; status: string } | { kind: 'not_found' } | { kind: 'error' };

/**
 * After a read: keep polling, stop (nothing more will change by waiting), or
 * give up (still unpaid after `pollForMs`). A 404 used to count as "still
 * waiting", so a mistyped link spun for three minutes before saying anything;
 * it is final. A failed read (network, 429, 503) is worth another try.
 */
export function nextShopOrderPoll(read: ShopOrderRead, elapsedMs: number, pollForMs: number): 'poll' | 'stop' | 'gave_up' {
  if (read.kind === 'not_found') return 'stop';
  if (read.kind === 'order' && read.status !== 'payment_pending') return 'stop';
  return elapsedMs > pollForMs ? 'gave_up' : 'poll';
}
