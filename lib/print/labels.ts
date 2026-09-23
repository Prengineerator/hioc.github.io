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
