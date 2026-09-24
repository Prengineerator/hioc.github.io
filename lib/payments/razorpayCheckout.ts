// Client-side Razorpay Checkout.js loader + launcher (PAY-1). No SDK/npm dep
// — per the Phase-2 payments contract, this dynamically loads Razorpay's
// hosted checkout script from their CDN and drives it with the `payment`
// intent returned by POST /api/orders (online mode) or
// POST /api/payments/[orderId]/status (retry). We never touch card data
// directly (PCI, XC-032) — Razorpay's hosted UI collects it.

import type { CreatedPaymentIntent } from '@/lib/payments/types';

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpaySuccessResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayFailureResponse {
  error?: { description?: string };
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: 'payment.failed', cb: (response: RazorpayFailureResponse) => void) => void;
    };
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

/**
 * Kicks off the Checkout.js download ahead of time (e.g. as soon as the
 * checkout form's effective payment mode is "online"), so by the time the
 * order is actually placed the script is already cached/loading instead of
 * only starting then — shaving a full script-download round trip off the gap
 * between "Place Order" and the Razorpay modal opening. Safe to call more than
 * once (loadRazorpayScript memoizes) and safe to call on the server (no-ops).
 */
export function preloadRazorpay(): void {
  void loadRazorpayScript();
}

export interface OpenCheckoutOptions {
  name: string;
  phone: string;
  description?: string;
  /** Payment succeeded and its signature was verified server-side. */
  onSuccess: () => void;
  /** Modal closed without a success; `lastFailure` is set if an attempt failed. */
  onDismiss: (lastFailure?: string) => void;
  /** Checkout couldn't load, or the server rejected the payment signature. */
  onFailure?: (description: string) => void;
  /** An attempt failed inside the modal (it stays open so the customer can retry). */
  onPaymentFailed?: (description: string) => void;
}

async function verifyPayment(response: RazorpaySuccessResponse): Promise<string | null> {
  try {
    const res = await fetch('/api/payments/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: response.razorpay_order_id,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature,
      }),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error ?? 'We could not verify your payment.';
  } catch {
    return 'Network error while confirming your payment.';
  }
}

/**
 * Opens Razorpay's hosted checkout modal for a previously-created payment
 * intent. On success the payment signature is verified server-side
 * (POST /api/payments/verify) before `onSuccess` fires. Callers should still
 * land on the order status page either way — the actual payment_status is
 * server-reconciled there (verify + webhook + poll).
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

  let lastFailure: string | undefined;
  const rzp = new window.Razorpay({
    key: intent.keyId,
    amount: Math.round(intent.amountInr) * 100,
    currency: 'INR',
    name: 'Hioc',
    description: opts.description ?? 'Order payment',
    order_id: intent.gatewayOrderId,
    prefill: { name: opts.name, contact: opts.phone },
    theme: { color: '#ad825e' },
    handler: async (response: RazorpaySuccessResponse) => {
      const error = await verifyPayment(response);
      if (error) {
        opts.onFailure?.(error);
        return;
      }
      opts.onSuccess();
    },
    modal: { ondismiss: () => opts.onDismiss(lastFailure) },
  });
  rzp.on('payment.failed', (response) => {
    lastFailure = response.error?.description || 'Payment failed.';
    opts.onPaymentFailed?.(lastFailure);
  });
  rzp.open();
}
