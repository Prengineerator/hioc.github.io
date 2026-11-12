'use client';

// The customer's order page (/shop/order/[id]). Polls GET /api/shop/orders/[id]
// while the payment is being confirmed (the route also asks Razorpay), then
// shows where the parcel is, with the tracking link once there is an AWB.

import { useCallback, useEffect, useRef, useState } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { buttonVariants } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { BUSINESS } from '@/lib/legal';
import { jarsLabel, rupees } from '@/lib/shop/pricing';
import { CUSTOMER_STATUS_LABEL, shopOrderRef } from '@/lib/shop/status';
import type { ShopOrderPublicView, ShopOrderStatus as Status } from '@/lib/shop/types';
import { nextShopOrderPoll, type ShopOrderRead } from '@/components/shop/shopCheckout';

const POLL_MS = 3000;
/** Stop polling a still-unpaid order after this long; a reload starts again. */
const POLL_FOR_MS = 3 * 60 * 1000;

const STEPS: { status: Status; label: string }[] = [
  { status: 'paid', label: 'Order confirmed' },
  { status: 'sent_to_shiprocket', label: 'Packed' },
  { status: 'shipped', label: 'Shipped' },
  { status: 'delivered', label: 'Delivered' },
];

function stepIndex(status: Status): number {
  return STEPS.findIndex((s) => s.status === status);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ShopOrderStatus({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<ShopOrderPublicView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const startedAt = useRef(Date.now());

  const load = useCallback(async (): Promise<ShopOrderRead> => {
    try {
      const res = await fetch(`/api/shop/orders/${orderId}`, { cache: 'no-store' });
      if (res.status === 404) {
        setError("We couldn't find that order. Check the link in your email.");
        return { kind: 'not_found' };
      }
      const data = (await res.json().catch(() => ({}))) as { order?: ShopOrderPublicView; error?: string };
      if (!res.ok || !data.order) {
        setError(data.error ?? 'Could not load your order just now.');
        return { kind: 'error' };
      }
      setError(null);
      setOrder(data.order);
      return { kind: 'order', status: data.order.status };
    } catch {
      setError('Network error — retrying…');
      return { kind: 'error' };
    }
  }, [orderId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      const read = await load();
      if (stopped) return;
      // A missing order is final (./shopCheckout.ts nextShopOrderPoll): it no
      // longer counts as "still waiting for the payment".
      const next = nextShopOrderPoll(read, Date.now() - startedAt.current, POLL_FOR_MS);
      if (next === 'stop') return;
      if (next === 'gave_up') {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load]);

  if (!order) {
    return error ? (
      <div className="rounded-md border border-line bg-surface p-6 text-center">
        <p className="text-charcoal">{error}</p>
        <Link href="/shop" className={buttonVariants({ variant: 'secondary', className: 'mt-4' })}>
          Back to the shop
        </Link>
      </div>
    ) : (
      <div className="flex items-center justify-center gap-3 py-16 text-muted">
        <Spinner /> Loading your order…
      </div>
    );
  }

  const ref = shopOrderRef(order.order_number);
  const current = stepIndex(order.status);

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-tan-dark">Order {ref}</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-charcoal">{CUSTOMER_STATUS_LABEL[order.status]}</h1>

      {order.status === 'payment_pending' ? (
        <div className="mt-4 rounded-md border border-line bg-surface p-4 text-sm text-charcoal">
          {gaveUp ? (
            <p>
              We haven&apos;t received the payment for this order. If you closed the payment window, nothing was
              charged — <Link href="/shop" className="font-semibold text-tan-dark underline">go back to the shop</Link> to
              try again. If money left your account, reload this page in a few minutes or contact us.
            </p>
          ) : (
            <p className="flex items-center gap-2">
              <Spinner /> Confirming your payment with Razorpay…
            </p>
          )}
        </div>
      ) : null}

      {order.status === 'cancelled' ? (
        <div className="mt-4 rounded-md border border-line bg-surface p-4 text-sm text-charcoal">
          <p>This order was cancelled{order.cancelled_at ? ` on ${fmtDate(order.cancelled_at)}` : ''}.</p>
          {order.refunded_inr ? (
            <p className="mt-1">
              We refunded <strong>{rupees(order.refunded_inr)}</strong> to the way you paid. Banks usually take 5–7
              working days to show it.
            </p>
          ) : null}
        </div>
      ) : null}

      {current >= 0 ? (
        <ol className="mt-6 grid grid-cols-4 gap-2" aria-label="Order progress">
          {STEPS.map((s, i) => {
            const done = i <= current;
            return (
              <li key={s.status} className="flex flex-col gap-2" aria-current={i === current ? 'step' : undefined}>
                <span className={`h-1.5 rounded-full ${done ? 'bg-tan' : 'bg-line'}`} />
                <span className={`text-xs ${done ? 'font-semibold text-charcoal' : 'text-muted'}`}>{s.label}</span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {order.status === 'paid' || order.status === 'sent_to_shiprocket' ? (
        <p className="mt-5 text-sm text-charcoal">
          Thank you! We&apos;re packing your order and will email you the tracking link once it ships.
        </p>
      ) : null}

      {order.awb_code && order.status !== 'cancelled' ? (
        <div className="mt-5 rounded-md border border-line bg-cream p-4 shadow-card">
          <p className="text-sm text-muted">
            {order.courier_name ? `${order.courier_name} · ` : ''}Tracking number (AWB)
          </p>
          <p className="mt-1 font-mono text-lg tabular-nums text-charcoal">{order.awb_code}</p>
          {order.tracking_url ? (
            <a
              href={order.tracking_url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ className: 'mt-3' })}
            >
              Track your parcel
            </a>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="order-summary" className="mt-8 rounded-md border border-line bg-cream p-5 shadow-card">
        <h2 id="order-summary" className="text-lg font-bold text-charcoal">
          {jarsLabel(order.jar_count)} of Instant Coffee
        </h2>
        <dl className="mt-3 space-y-2 text-sm">
          {order.lines.map((l) => (
            <div key={l.product_id} className="flex justify-between gap-3">
              <dt className="text-charcoal">
                {l.name} × {l.quantity}
              </dt>
              <dd className="font-mono tabular-nums">{rupees(l.line_total_inr)}</dd>
            </div>
          ))}
          {order.discount_inr > 0 ? (
            <div className="flex justify-between gap-3">
              <dt className="text-green-800">{order.offer_name ?? 'Offer'}</dt>
              <dd className="font-mono tabular-nums text-green-800">−{rupees(order.discount_inr)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-3 border-t border-line pt-2">
            <dt className="text-muted">Shipping</dt>
            <dd className="font-mono tabular-nums">{order.shipping_inr === 0 ? 'Free' : rupees(order.shipping_inr)}</dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-line pt-2 text-base font-bold">
            <dt>{order.status === 'payment_pending' ? 'Total' : 'Total paid'}</dt>
            <dd className="font-mono tabular-nums">{rupees(order.total_inr)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-muted">
          Delivering to {order.ship_to.name}, {order.ship_to.city}, {order.ship_to.state} {order.ship_to.pincode}
        </p>
      </section>

      <p className="mt-6 text-sm text-muted">
        Questions about your order? Call{' '}
        <a href={BUSINESS.phoneHref} className="text-tan-dark underline">
          {BUSINESS.phoneDisplay}
        </a>{' '}
        or email{' '}
        <a href={BUSINESS.emailHref} className="text-tan-dark underline">
          {BUSINESS.email}
        </a>{' '}
        with your order number {ref}.
      </p>
    </div>
  );
}
