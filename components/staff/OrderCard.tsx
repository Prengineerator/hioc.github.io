'use client';

// A single order card on the staff queue board (S1). Tap the card to open the
// detail view; the button in the top-right corner does the next step in one tap
// (Accept → Start → Ready → Complete, or Settle when a Ready order is unpaid),
// and the "⋯" beside it holds the other legal moves (Reject/Cancel…).
//
// BRD-1: the card lists what was ordered, so the board can be reviewed and
// prepped from at a glance — on the staff website and in the POS app, which
// loads the same board. Voided lines stay visible, struck through, so a
// correction is never silent; the detail view keeps the prices and the
// prep/handover checklist.

import { useEffect, useRef, useState } from 'react';
import { ElapsedTime } from '@/components/staff/ElapsedTime';
import { PaymentBadge } from '@/components/staff/PaymentBadge';
import { PickupReminderButton } from '@/components/staff/PickupReminderButton';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { STATUS_LABELS } from '@/lib/orders/stateMachine';
import { canRemind, quickActionsFor, type QuickAction } from '@/lib/orders/quickActions';
import type { Order, OrderItem } from '@/lib/types';

const CORNER_TONE: Record<QuickAction['tone'], string> = {
  primary: 'bg-tan-dark text-cream hover:bg-tan-darker',
  complete: 'bg-green-700 text-cream hover:bg-green-800', // 600 is 3.3:1 under white text
  neutral: 'bg-charcoal text-cream hover:opacity-90',
  danger: 'bg-red-600 text-cream hover:bg-red-700',
};

const TYPE_LABEL: Record<Order['order_type'], string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine-in',
  delivery: 'Delivery',
};

export function OrderCard({
  order,
  busy = false,
  onOpen,
  onAction,
  onRemind,
}: {
  order: Order & { items: OrderItem[] };
  // A status request for this order is in flight: the buttons stay disabled so
  // a double tap can't send the same move twice (or a stale version).
  busy?: boolean;
  onOpen: (order: Order & { items: OrderItem[] }) => void;
  onAction: (order: Order & { items: OrderItem[] }, action: QuickAction) => void;
  onRemind: (order: Order & { items: OrderItem[] }) => Promise<void>;
}) {
  const { corner, menu } = quickActionsFor(order);
  const itemCount = order.items.reduce((n, i) => n + i.quantity, 0);
  const isReady = order.status === 'ready';
  const isDineIn = order.order_type === 'dine_in';
  const hasVoid = order.items.some((i) => i.voided);
  // Dine-in cards show the table instead of a pickup slot (there is none).
  const whereLabel = isDineIn
    ? order.table_label
      ? `Table ${order.table_label}`
      : 'Dine-in'
    : order.pickup_slot_label || order.pickup_time;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(order)}
      onKeyDown={(e) => {
        // Keys pressed on the corner button / menu bubble up here too — only the
        // card itself (not a button inside it) should open the detail.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(order);
        }
      }}
      className={
        'flex cursor-pointer flex-col gap-2 rounded-md border border-line bg-cream p-4 shadow-sm transition hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
        (isReady ? 'border-l-4 border-l-tan' : '')
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          {/* Read at arm's length off a counter tablet — the number is what
              staff call out and customers match, so it's the biggest thing. */}
          <span className="font-mono text-xl font-bold leading-none tabular-nums text-charcoal">
            #{formatOrderNumber(order.order_number)}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {/* No lanes on the board, so the card itself says where it is; New
                gets the tan tone so fresh orders stand out. */}
            <span
              className={
                'rounded-full px-2 py-0.5 text-[11px] font-bold ' +
                (order.status === 'received' ? 'bg-tan-dark text-cream' : 'bg-charcoal/10 text-charcoal')
              }
            >
              {STATUS_LABELS[order.status]}
            </span>
            <PaymentBadge status={order.payment_status} />
            <span className="rounded-full bg-[#f2efe9] px-2 py-0.5 text-[11px] font-bold text-charcoal">
              {TYPE_LABEL[order.order_type]}
            </span>
          </span>
        </div>

        {/* Corner: the next step, then the other moves. Neither opens the detail. */}
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {corner ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(order, corner)}
              className={
                'min-h-[44px] min-w-[84px] rounded-md px-4 text-sm font-bold transition-colors disabled:cursor-wait disabled:opacity-60 ' +
                CORNER_TONE[corner.tone]
              }
            >
              {corner.label}
            </button>
          ) : null}
          {menu.length > 0 ? (
            <CardMenu
              actions={menu}
              disabled={busy}
              onPick={(a) => onAction(order, a)}
            />
          ) : null}
        </div>
      </div>

      <div className="text-sm text-charcoal">
        <p className="font-bold">{order.customer_name}</p>
        <p className="text-xs text-muted">
          {itemCount} item{itemCount === 1 ? '' : 's'} ·{' '}
          <span className="font-mono tabular-nums">₹{order.total_inr ?? order.subtotal_inr}</span> · {whereLabel}
          {hasVoid ? <span className="ml-1 font-bold text-red-600">· voided</span> : null}
        </p>
      </div>

      {order.items.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-line pt-2 text-sm text-charcoal">
          {order.items.map((item) => (
            <li key={item.id} className={item.voided ? 'text-muted line-through' : ''}>
              <span className="font-bold">{item.quantity}×</span> {item.name_snapshot}
              {item.variant_label_snapshot ? (
                <span className="text-muted"> ({item.variant_label_snapshot})</span>
              ) : null}
              {item.addons.length > 0 ? (
                <span className="block pl-4 text-xs text-muted">
                  + {item.addons.map((a) => a.option_name_snapshot).join(', ')}
                </span>
              ) : null}
              {item.special_instructions ? (
                // A prep instruction is the line a barista must not miss: tan-dark
                // + semibold (the old italic tan was ~3.4:1, below AA at 12px).
                <span className="block pl-4 text-xs font-semibold text-tan-dark">Note: {item.special_instructions}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {order.notes ? (
        <p className="rounded bg-surface px-2 py-1 text-xs text-charcoal">
          <span className="font-bold">Order note:</span> {order.notes}
        </p>
      ) : null}

      <div className="flex items-center justify-between text-xs text-muted">
        {/* Live total age (amber >10m, red >20m) + time in the current stage. */}
        <span>
          <ElapsedTime since={order.created_at} warnAfterMin={10} dangerAfterMin={20} /> total
        </span>
        <span>
          in stage <ElapsedTime since={order.updated_at} />
        </span>
      </div>

      {canRemind(order) ? (
        <PickupReminderButton
          remindedAt={order.pickup_reminded_at}
          onRemind={() => onRemind(order)}
        />
      ) : null}
    </div>
  );
}

// The "⋯" menu. A plain popover (no library): closes on an outside tap or Escape
// so it never lingers over the next card.
function CardMenu({
  actions,
  disabled,
  onPick,
}: {
  actions: QuickAction[];
  disabled: boolean;
  onPick: (a: QuickAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex h-11 w-11 items-center justify-center rounded-md border border-line bg-cream text-lg font-bold leading-none text-charcoal transition-colors hover:border-tan disabled:cursor-wait disabled:opacity-60"
      >
        ⋯
      </button>
      {open ? (
        <ul
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-[180px] overflow-hidden rounded-md border border-line bg-cream py-1 shadow-lg"
        >
          {actions.map((a) => (
            <li key={a.key} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPick(a);
                }}
                className={
                  'block min-h-[44px] w-full px-3 text-left text-sm font-bold hover:bg-[#f2efe9] ' +
                  (a.tone === 'danger' ? 'text-red-700' : 'text-charcoal')
                }
              >
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
