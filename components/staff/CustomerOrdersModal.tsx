'use client';

// POS-5 — "Last orders": the ten most recent orders for whoever's phone is
// currently in the customer section, opened from the chip/button next to the
// account info. Sibling of OrderDetailModal in spirit (order header + item
// list) but read-mostly — its one action is Repeat, not the full lifecycle.
//
// Built on the shared <Modal> (components/ui/Modal.tsx), the same shell
// PosCustomizeModal/PosPaymentModal already use on this screen: Escape-to-
// close and background scroll lock come from it for free. On top of that,
// `titleRef` below gives the dialog a focus target the instant it opens —
// the accessibility ask here is "Esc closes, focus lands somewhere sane", not
// a full roving focus trap, which the shared shell doesn't attempt either.

import { useEffect, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { ORDER_TYPE_LABEL, PAYMENT_LABEL, formatIstDateTime } from '@/lib/print/labels';
import { STATUS_LABELS } from '@/lib/orders/stateMachine';
import type { CustomerOrderResponse } from '@/lib/api/customerOrders';

export function CustomerOrdersModal({
  onClose,
  orders,
  loading,
  error,
  repeatingId,
  onRepeat,
}: {
  onClose: () => void;
  /** null while the first fetch is in flight; [] once loaded with nothing found. */
  orders: CustomerOrderResponse[] | null;
  loading: boolean;
  error: string | null;
  /** The order currently being repeated — disables just that row's button, not the whole list. */
  repeatingId?: string | null;
  onRepeat: (order: CustomerOrderResponse) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const showSkeleton = loading && orders === null;
  const isEmpty = !loading && (orders?.length ?? 0) === 0 && !error;

  return (
    <Modal open onClose={onClose} title="Last orders" size="lg">
      {/* Off-screen but focusable heading — gives Escape/Tab somewhere to
          start from the instant the dialog mounts, without hijacking focus
          away from the visible close button a sighted/mouse user expects. */}
      <h3 ref={titleRef} tabIndex={-1} className="sr-only outline-none">
        Last orders
      </h3>

      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </p>
      ) : showSkeleton ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-md border border-line p-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-2 h-3 w-48" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-1 h-3 w-3/4" />
            </div>
          ))}
        </div>
      ) : isEmpty ? (
        <p className="rounded-md border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
          No past orders on this number yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {(orders ?? []).map((order) => (
            <li key={order.id}>
              <OrderCard order={order} repeating={repeatingId === order.id} onRepeat={() => onRepeat(order)} />
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function OrderCard({
  order,
  repeating,
  onRepeat,
}: {
  order: CustomerOrderResponse;
  repeating: boolean;
  onRepeat: () => void;
}) {
  const activeItems = order.items.filter((i) => !i.voided);
  return (
    <div className="rounded-md border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-bold text-charcoal">#{formatOrderNumber(order.order_number)}</p>
          <p className="text-xs text-muted">
            {formatIstDateTime(order.created_at)} · {ORDER_TYPE_LABEL[order.order_type] ?? order.order_type}
            {order.table_label ? ` · ${order.table_label}` : ''}
          </p>
          <p className="text-xs text-muted">
            {STATUS_LABELS[order.status] ?? order.status} ·{' '}
            {PAYMENT_LABEL[order.payment_status] ?? order.payment_status}
          </p>
        </div>
        <p className="shrink-0 font-bold text-tan">₹{order.total_inr ?? order.subtotal_inr}</p>
      </div>

      <ul className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3 text-sm text-charcoal">
        {activeItems.map((item) => (
          <li key={item.id}>
            <p>
              {item.quantity}× {item.name_snapshot}
              {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''}
            </p>
            {item.addons.length > 0 ? (
              <p className="text-xs text-muted">
                {item.addons.map((a) => `${a.group_name_snapshot}: ${a.option_name_snapshot}`).join(' · ')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-3 border-t border-line pt-3">
        {/* min-h-[44px] via Button's own sizing — touch-friendly by default. */}
        <Button variant="secondary" size="sm" loading={repeating} onClick={onRepeat} className="w-full sm:w-auto">
          Repeat this order
        </Button>
      </div>
    </div>
  );
}
