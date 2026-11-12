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
  /** Prefilled in the payment window when known (the Instant Coffee shop asks for it). */
  email?: string;
  description?: string;
  /**
   * Where the success handler verifies the signature. Café orders use the
   * default; the Instant Coffee shop passes '/api/shop/verify'.
   */
  verifyPath?: string;
  /** Payment succeeded and its signature was verified server-side. */
  onSuccess: () => void;
  /** Modal closed without a success; `lastFailure` is set if an attempt failed. */
  onDismiss: (lastFailure?: string) => void;
  /** Checkout couldn't load, or the server rejected the payment signature. */
  onFailure?: (description: string) => void;
  /** An attempt failed inside the modal (it stays open so the customer can retry). */
  onPaymentFailed?: (description: string) => void;
}

const DEFAULT_VERIFY_PATH = '/api/payments/verify';

async function verifyPayment(response: RazorpaySuccessResponse, path: string): Promise<string | null> {
  try {
    const res = await fetch(path, {
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
 * How a checkout ended. The promise openRazorpayCheckout() returns settles with
 * exactly one of these, once — never when the window merely opens:
 *   paid         the gateway reported success and the signature verified
 *   unverified   the gateway reported success but verifying it failed (a network
 *                blip, a server error). Money has most likely moved, so a caller
 *                must not start a second payment for the same thing without
 *                asking the server first.
 *   dismissed    the window closed without a success; `lastFailure` is set if an
 *                attempt inside it failed. Nothing was charged.
 *   unavailable  the window never opened (Checkout.js didn't load, no key).
 */
export type RazorpayOutcome =
  | { kind: 'paid' }
  | { kind: 'unverified'; message: string }
  | { kind: 'dismissed'; lastFailure?: string }
  | { kind: 'unavailable'; message: string };

/** True when the customer may have been charged: the gateway said the payment succeeded. */
export function outcomeMayHaveCharged(outcome: RazorpayOutcome): boolean {
  return outcome.kind === 'paid' || outcome.kind === 'unverified';
}

const LOAD_FAILED = 'Could not load the payment window.';

/**
 * Opens Razorpay's hosted checkout modal for a previously-created payment
 * intent. On success the payment signature is verified server-side
 * (POST /api/payments/verify) before `onSuccess` fires. Callers should still
 * land on the order status page either way — the actual payment_status is
 * server-reconciled there (verify + webhook + poll).
 *
 * The returned promise settles when the checkout is OVER (see RazorpayOutcome),
 * not when the window opens. It used to resolve right after rzp.open(), so a
 * caller that awaited it and then cleared its "paying" flag re-enabled its
 * buttons while the window was still up. The callbacks fire exactly as before;
 * the outcome carries the same news for a caller that would rather await it.
 */
export async function openRazorpayCheckout(
  intent: CreatedPaymentIntent,
  opts: OpenCheckoutOptions,
): Promise<RazorpayOutcome> {
  const loaded = await loadRazorpayScript();
  const Razorpay = typeof window === 'undefined' ? undefined : window.Razorpay;
  if (!loaded || !Razorpay || !intent.keyId) {
    opts.onFailure?.(LOAD_FAILED);
    return { kind: 'unavailable', message: LOAD_FAILED };
  }

  return new Promise<RazorpayOutcome>((resolve) => {
    let lastFailure: string | undefined;
    // Once the success handler starts, it decides the checkout: a dismiss that
    // arrives while the signature is being verified must not also report
    // "cancelled", and a caller must never hear two endings.
    let decided = false;

    try {
      const rzp = new Razorpay({
        key: intent.keyId,
        amount: Math.round(intent.amountInr) * 100,
        currency: 'INR',
        name: 'Hioc',
        description: opts.description ?? 'Order payment',
        order_id: intent.gatewayOrderId,
        prefill: { name: opts.name, contact: opts.phone, ...(opts.email ? { email: opts.email } : {}) },
        theme: { color: '#8a6446' }, // tan-dark: Razorpay puts white text on it (brand tan is 3.4:1)
        handler: async (response: RazorpaySuccessResponse) => {
          if (decided) return;
          decided = true;
          const error = await verifyPayment(response, opts.verifyPath ?? DEFAULT_VERIFY_PATH);
          if (error) {
            opts.onFailure?.(error);
            resolve({ kind: 'unverified', message: error });
            return;
          }
          opts.onSuccess();
          resolve({ kind: 'paid' });
        },
        modal: {
          ondismiss: () => {
            if (decided) return;
            decided = true;
            opts.onDismiss(lastFailure);
            resolve({ kind: 'dismissed', lastFailure });
          },
        },
      });
      rzp.on('payment.failed', (response) => {
        lastFailure = response.error?.description || 'Payment failed.';
        opts.onPaymentFailed?.(lastFailure);
      });
      rzp.open();
    } catch {
      // Checkout.js loaded but refused the options or could not open: nothing
      // was shown, so nothing can have been charged.
      if (decided) return;
      decided = true;
      opts.onFailure?.(LOAD_FAILED);
      resolve({ kind: 'unavailable', message: LOAD_FAILED });
    }
  });
}
