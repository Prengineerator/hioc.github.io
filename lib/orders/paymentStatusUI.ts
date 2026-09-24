// Pure decision helpers for the customer order-status page's payment-pending
// UI (app/order/[id]/page.tsx, PAY-2). Pulled out of the page component so
// they're unit-testable without a React rendering harness (a Next.js `page.tsx`
// may only export the reserved route-module names — see its type error if you
// try) — and so the two related decisions (can this order pay at counter? what
// does the payment-flag banner say?) live in one obviously-paired place.

import type { Order } from '@/lib/types';

// Issue-1: a web guest (no session, no verified phone) has no pay-at-counter
// fallback (see POST /api/orders' isWebGuest and POST
// /api/payments/[orderId]/status), so they're never offered, or told about,
// "pay at counter". A table-QR order still starts pay-online-first at
// placement, but its diner is physically at the table, so switching to pay at
// counter after a failed/cancelled attempt is fine for them.
export function canPayAtCounter(order: Pick<Order, 'channel' | 'user_id'>): boolean {
  if (order.channel === 'customer_web' && !order.user_id) return false;
  return true;
}

// Set by CheckoutForm when the Razorpay modal closes without a verified
// payment, and re-derived from the ?payment= flag once the order (and
// therefore whether it can pay at counter) has loaded.
export function paymentFlagMessage(flag: string | null, allowCounter: boolean): string {
  if (flag === 'cancelled') {
    return allowCounter
      ? 'Payment was cancelled — you can retry or pay at the counter.'
      : 'Payment was cancelled — please retry the payment.';
  }
  if (flag === 'failed') {
    return allowCounter
      ? "Your payment didn't go through — you can retry or pay at the counter."
      : "Your payment didn't go through — please retry the payment.";
  }
  return '';
}

// A bill (RCT-1/2) only ever gets *created* once a payment is recorded
// (sendBillNotification fires on ₹0-at-creation, gateway capture, staff
// settle, or paid-completion). Cancelled/rejected are carved out even if
// paid before cancellation, since a refund would move payment_status off
// 'paid' anyway; a merely 'completed'-but-never-paid order has no bill.
export function hasBill(order: Pick<Order, 'status' | 'payment_status'>): boolean {
  return order.payment_status === 'paid' && order.status !== 'cancelled' && order.status !== 'rejected';
}
