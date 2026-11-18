'use client';

// The cart drawer (docs/SHOP-V2-SPEC.md E8): every line of the order with its
// stepper and Remove, and a live subtotal. Opened from the sticky bar's item
// count. A Modal, so Escape, focus trapping and scroll lock come with it.
//
// Lines are the page's display lines (lib/shop/checkoutFlow.ts buildCartLines),
// not the quote, so a line the quote refuses (gone out of stock) can still be
// seen and removed. The same product with another grind is its own line. The
// subtotal here is the goods only; offers, Beanies and shipping are on the Pay
// step, priced by the server.

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Stepper } from '@/components/shop/InstantSection';
import { lineItemLabel } from '@/lib/shop/catalog';
import { lineKey } from '@/lib/shop/checkoutFlow';
import { rupees } from '@/lib/shop/pricing';
import type { ShopLine } from '@/lib/shop/types';

export function CartDrawer({
  open,
  onClose,
  lines,
  canAddMore,
  onSetQuantity,
  onRemove,
  problem,
}: {
  open: boolean;
  onClose: () => void;
  lines: ShopLine[];
  canAddMore: boolean;
  onSetQuantity: (key: string, quantity: number) => void;
  onRemove: (key: string) => void;
  /** Why the order can't be priced right now (an item out of stock), if so. */
  problem?: string | null;
}) {
  const subtotal = lines.reduce((n, l) => n + l.line_total_inr, 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Your order"
      size="md"
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-charcoal">
            Subtotal{' '}
            <span aria-live="polite" className="font-mono text-base font-bold tabular-nums">
              {rupees(subtotal)}
            </span>
          </p>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      {lines.length === 0 ? (
        <EmptyState heading="Your order is empty" body="Add some coffee and it will show up here." />
      ) : (
        <>
          {problem ? (
            <p role="alert" className="mb-3 rounded-md bg-surface px-3 py-2 text-sm font-semibold text-red-700">
              {problem}
            </p>
          ) : null}
          <ul className="divide-y divide-line">
            {lines.map((l) => {
              const key = lineKey(l);
              return (
                <li key={key} className="flex flex-col gap-2 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-semibold text-charcoal">{lineItemLabel(l)}</p>
                    <p className="font-mono text-sm tabular-nums text-charcoal">{rupees(l.line_total_inr)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Stepper label={lineItemLabel({ ...l, quantity: 1 }).replace(/^1× /, '')} value={l.quantity} onChange={(n) => onSetQuantity(key, n)} canAdd={canAddMore} min={1} />
                    <Button variant="ghost" size="sm" onClick={() => onRemove(key)} aria-label={`Remove ${lineItemLabel({ ...l, quantity: 1 }).replace(/^1× /, '')}`}>
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Modal>
  );
}
