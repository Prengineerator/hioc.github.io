import { PAYMENT_BADGE, type PaymentTone } from '@/lib/orders/staffPayment';
import type { PaymentStatus } from '@/lib/types';

const TONE_CLASS: Record<PaymentTone, string> = {
  paid: 'bg-green-100 text-green-800',
  due: 'bg-red-100 text-red-800',
  pending: 'bg-amber-100 text-amber-800',
  refunded: 'bg-[#f2efe9] text-muted',
};

/**
 * Paid / Unpaid / Awaiting payment / Refunded — see lib/orders/staffPayment.ts.
 * A paid bill changed after it was paid (lib/orders/paidChange.ts) reads
 * "Paid · ₹130 due" or "Paid · ₹105 back" while its balance is open.
 */
export function PaymentBadge({ status, balanceInr = 0 }: { status: PaymentStatus; balanceInr?: number }) {
  if (status === 'paid' && balanceInr > 0) {
    return <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE_CLASS.due}`}>Paid · ₹{balanceInr} due</span>;
  }
  if (status === 'paid' && balanceInr < 0) {
    return (
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE_CLASS.pending}`}>Paid · ₹{-balanceInr} back</span>
    );
  }
  const badge = PAYMENT_BADGE[status] ?? { label: status, tone: 'pending' as const };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE_CLASS[badge.tone]}`}>{badge.label}</span>
  );
}
