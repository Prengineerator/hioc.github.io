// Client-side Razorpay Checkout.js loader + launcher (PAY-1). No SDK/npm dep
// — per the Phase-2 payments contract, this dynamically loads Razorpay's
// hosted checkout script from their CDN and drives it with the `payment`
// intent returned by POST /api/orders (online mode) or
// POST /api/payments/[orderId]/status (retry). We never touch card data
// directly (PCI, XC-032) — Razorpay's hosted UI collects it.

import type { CreatedPaymentIntent } from '@/lib/payments/types';

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

let scriptPromise: Promise<boolean> | null = null;

function loadRazorpayScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
  return scriptPromise;
}

export interface OpenCheckoutOptions {
  name: string;
  phone: string;
  description?: string;
  onSuccess: () => void;
  onDismiss: () => void;
  onFailure?: (description: string) => void;
}

/**
 * Opens Razorpay's hosted checkout modal for a previously-created payment
 * intent. Both `onSuccess` and `onDismiss` should lead the caller back to the
 * order status page — the actual payment_status is server-reconciled there
 * (webhook + poll), so this never needs to be trusted as the source of truth
 * on its own.
 */
export async function openRazorpayCheckout(
  intent: CreatedPaymentIntent,
  opts: OpenCheckoutOptions,
): Promise<void> {
  const loaded = await loadRazorpayScript();
  if (!loaded || !window.Razorpay || !intent.keyId) {
    opts.onFailure?.('Could not load the payment window.');
    return;
  }

  const rzp = new window.Razorpay({
    key: intent.keyId,
    amount: Math.round(intent.amountInr) * 100,
    currency: 'INR',
    name: 'House Of Immaculate Coffee',
    description: opts.description ?? 'Order payment',
    order_id: intent.gatewayOrderId,
    prefill: { name: opts.name, contact: opts.phone },
    theme: { color: '#ad825e' },
    handler: () => opts.onSuccess(),
    modal: { ondismiss: () => opts.onDismiss() },
  });
  rzp.open();
}
