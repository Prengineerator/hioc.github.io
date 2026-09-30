// The customer opt-in link (spec §2): `https://wa.me/<number>?text=START`. The customer
// taps it, WhatsApp opens with START ready to send, and the webhook records the opt-in.
// Pure and client-safe: the owner's QR card, the order-confirmation card and the public
// endpoint all build the link the same way.

/** https://wa.me/<digits>?text=START, or null when no business number is set. */
export function optinUrl(businessNumber: string | null | undefined): string | null {
  const digits = (businessNumber ?? '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}?text=START` : null;
}
