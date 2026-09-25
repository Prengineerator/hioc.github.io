// PRN-3 — pure display labels + IST datetime formatting shared by the HTML
// staff tickets (components/print/StaffTickets.tsx) and the ESC/POS ticket
// model (lib/print/ticketModel.ts), so the two surfaces can't drift on
// wording. No JSX, no data fetching — safe to import from either a Server
// Component or a plain TS module.

export const ORDER_TYPE_LABEL: Record<string, string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine-in',
  delivery: 'Delivery',
};

export const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'Pay at counter',
  payment_pending: 'Payment pending',
  paid: 'Paid',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
};

/** The receipt's top banner ("PAID" / "UNPAID" / …) — shouting-case and
 * blunter than `PAYMENT_LABEL` (which reads naturally inline, e.g. "Pay at
 * counter"), since this is its own bold centred line, not a value next to a
 * "Payment" label. */
export const PAYMENT_BANNER_LABEL: Record<string, string> = {
  unpaid: 'UNPAID',
  payment_pending: 'PAYMENT PENDING',
  paid: 'PAID',
  refunded: 'REFUNDED',
  partially_refunded: 'PARTIALLY REFUNDED',
};

/** `orders.payment_method` ('cash' | 'upi' | 'card' | 'online') → the
 * receipt's "Paid via <label>" wording. */
export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  online: 'Online',
};

export function formatIstDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

/** dd/mm/yy HH:mm (24-hour) in IST — the customer receipt's compact date
 * format ("25/09/26 16:11"), distinct from `formatIstDateTime` above (which
 * the KOT and token slip keep using unchanged). `hourCycle: 'h23'` pins
 * midnight to "00", not "24" (some ICU builds default `hour12: false` to a
 * 24-based cycle instead of a 0-based one). */
export function formatIstDateShort(iso: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
  } catch {
    return iso;
  }
}
