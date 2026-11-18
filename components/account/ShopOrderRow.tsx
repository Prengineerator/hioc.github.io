'use client';

// One shop order in the account's order list (docs/SHOP-V2-SPEC.md E4): the
// S-number in mono, a "Shipped to <city>" channel badge, the items (with grind),
// the total, the four-step status line and Track / View / Order again.
//
// Nothing here relies on colour alone: every badge pairs an icon with text, and
// each step says "done" / "current" to a screen reader as well as drawing it.
// Also exports the small pieces the confirmation page and the orders page share
// (ShopChannelBadge, CafeChannelBadge, ShopStepsList) so the wording and icons
// cannot drift between screens.

import { useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { flags } from '@/lib/flags';
import { useShopReorder } from '@/lib/shop/useShopReorder';
import { CUSTOMER_STATUS_LABEL, shopOrderRef } from '@/lib/shop/status';
import { rupees } from '@/lib/shop/pricing';
import {
  formatIstDate,
  shopChannelBadgeText,
  shopItemsSummary,
  shopStatusSteps,
} from '@/lib/account/orderDisplay';
import type { ShopHistoryOrder, ShopOrderStatus } from '@/lib/shop/types';

const ICON = { 'aria-hidden': true, viewBox: '0 0 20 20', fill: 'none', className: 'h-3.5 w-3.5' } as const;
const STROKE = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function TruckIcon() {
  return (
    <svg {...ICON}>
      <path d="M2 5h10v8H2zM12 8h4l2 2.5V13h-6" {...STROKE} />
      <circle cx="6" cy="14.5" r="1.5" {...STROKE} />
      <circle cx="14.5" cy="14.5" r="1.5" {...STROKE} />
    </svg>
  );
}

export function CupIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 7h10v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM14 8h1.5a2 2 0 0 1 0 4H14M6 3.5v1.5M9 3.5v1.5" {...STROKE} />
    </svg>
  );
}

export function BagIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 7h12l-1 10H5zM7 7V5.5a3 3 0 0 1 6 0V7" {...STROKE} />
    </svg>
  );
}

/** "Shipped to Pune" with a truck. */
export function ShopChannelBadge({ city }: { city: string | null | undefined }) {
  return (
    <Badge variant="neutral">
      <TruckIcon />
      {shopChannelBadgeText(city)}
    </Badge>
  );
}

/** "Café" (or "Café · Pickup") with a cup. */
export function CafeChannelBadge({ detail }: { detail?: string | null }) {
  return (
    <Badge variant="neutral">
      <CupIcon />
      {detail ? `Café · ${detail}` : 'Café'}
    </Badge>
  );
}

/**
 * Paid → Packed → Shipped → Delivered as text with a marker per step. A cancelled
 * or expired order shows its words instead of a bar that never finishes.
 */
export function ShopStepsList({ status, size = 'sm' }: { status: ShopOrderStatus; size?: 'sm' | 'md' }) {
  const { steps, terminal } = shopStatusSteps(status);
  if (terminal) {
    return (
      <Badge variant="danger">
        <svg {...ICON}>
          <path d="m5 5 10 10M15 5 5 15" {...STROKE} />
        </svg>
        {terminal}
      </Badge>
    );
  }
  const text = size === 'md' ? 'text-sm' : 'text-xs';
  return (
    <ol aria-label="Order progress" className="grid grid-cols-4 gap-1">
      {steps.map((s) => (
        <li
          key={s.label}
          aria-current={s.state === 'current' ? 'step' : undefined}
          className={`flex flex-col gap-1.5 ${text} ${s.state === 'upcoming' ? 'text-muted' : 'font-semibold text-charcoal'}`}
        >
          <span aria-hidden="true" className={`h-1.5 rounded-full ${s.state === 'upcoming' ? 'bg-line' : 'bg-tan'}`} />
          <span className="inline-flex items-center gap-1">
            {s.state === 'done' ? (
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0">
                <path d="m4 10.5 4 4 8-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
            {s.label}
            <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (current step)' : ' (not yet)'}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ShopOrderRow({ order }: { order: ShopHistoryOrder }) {
  const { reorder, reorderingId } = useShopReorder();
  const [error, setError] = useState('');
  const busy = reorderingId === order.id;
  const ref = shopOrderRef(order.order_number);

  async function onReorder() {
    setError('');
    const r = await reorder(order.id);
    if (!r.ok) setError(r.error ?? 'Could not reorder this order.');
  }

  return (
    <li className="rounded-md border border-line bg-cream p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/shop/order/${order.id}`}
            className="font-mono font-bold tabular-nums text-charcoal hover:underline"
          >
            {ref}
          </Link>
          <p className="text-sm text-muted">{formatIstDate(order.created_at)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ShopChannelBadge city={order.city} />
          <p className="font-mono text-sm font-bold tabular-nums text-charcoal">{rupees(order.total_inr)}</p>
        </div>
      </div>

      <p className="mt-2 text-sm text-muted">{shopItemsSummary(order.lines)}</p>

      <div className="mt-3">
        <p className="mb-1.5 text-xs font-semibold text-charcoal">{CUSTOMER_STATUS_LABEL[order.status]}</p>
        <ShopStepsList status={order.status} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {order.awb_code && order.tracking_url ? (
          <a
            href={order.tracking_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline"
          >
            Track
            <span className="sr-only"> {ref} (opens in a new tab)</span>
          </a>
        ) : null}
        <Link
          href={`/shop/order/${order.id}`}
          className="inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline"
        >
          View<span className="sr-only"> {ref}</span>
        </Link>
        {/* With flags.shop off /api/account/shop-reorder 404s, so the button could only fail. */}
        {flags.shop ? (
          <Button variant="secondary" size="sm" onClick={onReorder} loading={busy} aria-label={`Order ${ref} again`}>
            {busy ? 'Adding…' : 'Order again'}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
    </li>
  );
}

