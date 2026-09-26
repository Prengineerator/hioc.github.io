import { PAYMENT_BADGE, type PaymentTone } from '@/lib/orders/staffPayment';
import type { PaymentStatus } from '@/lib/types';

const TONE_CLASS: Record<PaymentTone, string> = {
  paid: 'bg-green-100 text-green-800',
  due: 'bg-red-100 text-red-800',
  pending: 'bg-amber-100 text-amber-800',
  refunded: 'bg-[#f2efe9] text-muted',
};

/** Paid / Unpaid / Awaiting payment / Refunded — see lib/orders/staffPayment.ts. */
export function PaymentBadge({ status }: { status: PaymentStatus }) {
  const badge = PAYMENT_BADGE[status] ?? { label: status, tone: 'pending' as const };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE_CLASS[badge.tone]}`}>{badge.label}</span>
  );
}
