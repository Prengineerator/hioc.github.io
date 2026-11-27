'use client';

// The customer's order page (/shop/order/[id]). Polls GET /api/shop/orders/[id]
// while the payment is being confirmed (the route also asks Razorpay), then
// shows where the parcel is, with the tracking link once there is an AWB.
//
// v2 (docs/SHOP-V2-SPEC.md E3/E8): a Paid → Packed → Shipped → Delivered
// timeline whose current status is announced through aria-live; "Delivered to /
// Shipping to <city>"; lines with their grind; the discount breakdown; the
// Beanies the order will earn; Order again once delivered (signed in); and for a
// guest order a "Save these details for next time" step. A signed-out customer
// signs in with the order's phone (the login page claims the order) and on
// return (?save=1, passed in as `save`) the page saves the order's address. A
// viewer who is already signed in saves in place: /login would bounce them
// straight back, so the save first calls POST /api/account/claim itself. Either
// way the save runs once, guarded by sessionStorage and a ref so a reload or a
// double render cannot save it twice. A 404 from that save means the order is
// not on the signed-in account; we say so and offer "Log out and sign in"
// rather than a /login link that would redirect a signed-in user.

import { useCallback, useEffect, useRef, useState } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { ShopStepsList } from '@/components/account/ShopOrderRow';
import { BUSINESS } from '@/lib/legal';
import { flags } from '@/lib/flags';
import { beaniesLabel } from '@/lib/loyalty/brand';
import { rupees } from '@/lib/shop/pricing';
import { lineItemLabel } from '@/lib/shop/catalog';
import { CUSTOMER_STATUS_LABEL, shopOrderRef } from '@/lib/shop/status';
import { useShopReorder } from '@/lib/shop/useShopReorder';
import { shopStatusSteps } from '@/lib/account/orderDisplay';
import type { ShopOrderPublicView } from '@/lib/shop/types';

const POLL_MS = 3000;
/** Stop polling a still-unpaid order after this long; a reload starts again. */
const POLL_FOR_MS = 3 * 60 * 1000;

type SaveState = 'idle' | 'saving' | 'saved' | 'wrong-account' | 'error';

const savedKey = (orderId: string) => `hioc_shop_saved_${orderId}`;

function readSaved(orderId: string): boolean {
  try {
    return window.sessionStorage.getItem(savedKey(orderId)) === '1';
  } catch {
    return false;
  }
}

function writeSaved(orderId: string, on: boolean) {
  try {
    if (on) window.sessionStorage.setItem(savedKey(orderId), '1');
    else window.sessionStorage.removeItem(savedKey(orderId));
  } catch {
    // Private mode: the ref below still stops a repeat within this page view.
  }
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

export function ShopOrderStatus({ orderId, save = false }: { orderId: string; save?: boolean }) {
  const [order, setOrder] = useState<ShopOrderPublicView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const startedAt = useRef(Date.now());
  const { reorder, reorderingId } = useShopReorder();
  const [reorderError, setReorderError] = useState('');
  // 'unknown' until /api/auth/me answers; the page works for guests, so a failure reads as signed out.
  const [viewer, setViewer] = useState<'unknown' | 'in' | 'out'>('unknown');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const saveStarted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { user?: unknown }) => {
        if (!cancelled) setViewer(data.user ? 'in' : 'out');
      })
      .catch(() => {
        if (!cancelled) setViewer('out');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveAddress = useCallback(async () => {
    setSaveState('saving');
    setSaveError('');
    try {
      // A signed-in viewer never passes through LoginForm, which is what normally
      // claims guest orders, so claim here first. Idempotent and best-effort: a
      // failure just falls through to the save, whose 404 explains itself.
      await fetch('/api/account/claim', { method: 'POST' }).catch(() => undefined);
      const res = await fetch('/api/account/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_shop_order_id: orderId }),
      });
      if (res.ok) {
        writeSaved(orderId, true);
        setSaveState('saved');
        return;
      }
      // Let a reload try again after a failure.
      writeSaved(orderId, false);
      saveStarted.current = false;
      if (res.status === 404) {
        setSaveState('wrong-account');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setSaveError(res.status === 409 ? 'You already have 10 saved addresses. Delete one in your account to add this.' : (data.error ?? 'Could not save your details.'));
      setSaveState('error');
    } catch {
      writeSaved(orderId, false);
      saveStarted.current = false;
      setSaveError('No connection. Check your internet and try again.');
      setSaveState('error');
    }
  }, [orderId]);

  // A signed-in viewer saves in place (no /login, which would bounce straight back).
  // Same once-only guard as the ?save=1 effect.
  const saveInPlace = useCallback(() => {
    if (saveStarted.current) return;
    saveStarted.current = true;
    void saveAddress();
  }, [saveAddress]);

  // Wrong account: /login redirects signed-in users, so log out first, then sign in.
  const [loggingOut, setLoggingOut] = useState(false);
  async function logOutAndSignIn(href: string) {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Navigate anyway; /login will show if the session is still live.
    }
    window.location.assign(href);
  }

  // Back from sign-in with ?save=1: save the order's address once.
  useEffect(() => {
    if (!save || viewer !== 'in' || saveStarted.current) return;
    saveStarted.current = true;
    if (readSaved(orderId)) {
      setSaveState('saved');
      return;
    }
    void saveAddress();
  }, [save, viewer, orderId, saveAddress]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/shop/orders/${orderId}`, { cache: 'no-store' });
      if (res.status === 404) {
        setError("We couldn't find that order. Check the link in your email.");
        return null;
      }
      const data = (await res.json().catch(() => ({}))) as { order?: ShopOrderPublicView; error?: string };
      if (!res.ok || !data.order) {
        setError(data.error ?? 'Could not load your order just now.');
        return null;
      }
      setError(null);
      setOrder(data.order);
      return data.order;
    } catch {
      setError('Network error — retrying…');
      return null;
    }
  }, [orderId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      const o = await load();
      if (stopped) return;
      const waiting = !o || o.status === 'payment_pending';
      if (!waiting) return;
      if (Date.now() - startedAt.current > POLL_FOR_MS) {
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
  const showSteps = shopStatusSteps(order.status).currentIndex >= 0;
  const delivered = order.status === 'delivered';
  const live = order.status !== 'cancelled' && order.status !== 'expired' && order.status !== 'payment_pending';
  const canSavePrompt = order.is_guest && live && saveState !== 'saved';
  const loginHref = `/login?next=${encodeURIComponent(`/shop/order/${order.id}?save=1`)}`;
  const reordering = reorderingId === order.id;

  async function onReorder() {
    setReorderError('');
    const r = await reorder(order!.id);
    if (!r.ok) setReorderError(r.error ?? 'Could not reorder this order.');
  }

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

      {/* The status is announced when it changes (polling or a reload); the steps below show it. */}
      <p role="status" aria-live="polite" className="sr-only">
        Order status: {CUSTOMER_STATUS_LABEL[order.status]}
      </p>

      {showSteps ? (
        <div className="mt-6">
          <ShopStepsList status={order.status} size="md" />
        </div>
      ) : null}

      {live ? (
        <p className="mt-4 text-sm font-semibold text-charcoal">
          {delivered ? 'Delivered' : 'Shipping'} to {order.ship_to.city}
        </p>
      ) : null}

      {order.beanies_to_earn && order.beanies_to_earn > 0 && !delivered && live ? (
        <p className="mt-2 text-sm text-charcoal">
          You&apos;ll earn ~<span className="font-mono tabular-nums">{beaniesLabel(order.beanies_to_earn)}</span> when it&apos;s delivered.
        </p>
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
              className={buttonVariants({ variant: delivered && flags.shop && viewer === 'in' ? 'secondary' : 'primary', className: 'mt-3' })}
            >
              Track your parcel
            </a>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="order-summary" className="mt-8 rounded-md border border-line bg-cream p-5 shadow-card">
        <h2 id="order-summary" className="text-lg font-bold text-charcoal">
          Your order
        </h2>
        <dl className="mt-3 space-y-2 text-sm">
          {order.lines.map((l, i) => (
            <div key={`${l.sku}-${i}`} className="flex justify-between gap-3">
              <dt className="text-charcoal">{lineItemLabel(l)}</dt>
              <dd className="font-mono tabular-nums">{rupees(l.line_total_inr)}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-3 border-t border-line pt-2">
            <dt className="text-muted">Subtotal</dt>
            <dd className="font-mono tabular-nums">{rupees(order.subtotal_inr)}</dd>
          </div>
          {order.discounts.map((d) => (
            <div key={`${d.kind}-${d.label}`} className="flex justify-between gap-3">
              <dt className="text-green-800">{d.label}</dt>
              <dd className="font-mono tabular-nums text-green-800">−{rupees(d.amount_inr)}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Shipping</dt>
            <dd className="font-mono tabular-nums">{order.shipping_inr === 0 ? 'Free' : rupees(order.shipping_inr)}</dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-line pt-2 text-base font-bold">
            <dt>{order.status === 'payment_pending' ? 'Total' : 'Total paid'}</dt>
            <dd className="font-mono tabular-nums">{rupees(order.total_inr)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-muted">
          {delivered ? 'Delivered to' : 'Delivering to'} {order.ship_to.name}, {order.ship_to.city}, {order.ship_to.state}{' '}
          {order.ship_to.pincode}
        </p>
      </section>

      <div role="status" aria-live="polite">
        {saveState === 'saving' ? (
          <div className="mt-5 text-sm text-charcoal">
            <Spinner size="sm" label="Saving your details…" />
          </div>
        ) : null}
        {saveState === 'saved' ? (
          <p className="mt-5 rounded-md border border-line bg-surface p-4 text-sm font-semibold text-charcoal">
            <span aria-hidden="true">✓ </span>Saved to your account.{' '}
            <Link href="/account/addresses" className="text-tan-dark underline">
              See your addresses
            </Link>
          </p>
        ) : null}
        {saveState === 'wrong-account' ? (
          <p className="mt-5 rounded-md border border-line bg-surface p-4 text-sm text-charcoal">
            This order isn&apos;t on the account you&apos;re signed in to. Log out, then sign in with the phone number you ordered with.
            <Button variant="secondary" size="sm" className="mt-3 block" loading={loggingOut} onClick={() => void logOutAndSignIn(loginHref)}>
              Log out and sign in
            </Button>
          </p>
        ) : null}
        {saveState === 'error' ? (
          <div className="mt-5 rounded-md border border-line bg-surface p-4 text-sm text-charcoal">
            <p role="alert">{saveError}</p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => void saveAddress()}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>

      {canSavePrompt && saveState === 'idle' && viewer !== 'unknown' ? (
        <section aria-labelledby="save-details" className="mt-5 rounded-md border border-line bg-surface p-5">
          <h2 id="save-details" className="font-bold text-charcoal">
            Save these details for next time
          </h2>
          <p className="mt-1 text-sm text-muted">
            {viewer === 'in'
              ? 'Keep this address on your account, see this order there and earn Beanies on it.'
              : 'Sign in with the phone number you ordered with to keep this address, see this order in your account and earn Beanies.'}
          </p>
          {viewer === 'in' ? (
            <Button variant="secondary" className="mt-3" onClick={saveInPlace}>
              Save these details
            </Button>
          ) : (
            <Link href={loginHref} className={buttonVariants({ variant: 'secondary', className: 'mt-3' })}>
              Save these details
            </Link>
          )}
        </section>
      ) : null}

      {flags.shop && delivered && viewer === 'in' ? (
        <div className="mt-5">
          <Button onClick={() => void onReorder()} loading={reordering} fullWidth>
            {reordering ? 'Adding…' : 'Order again'}
          </Button>
          {reorderError ? (
            <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
              {reorderError}
            </p>
          ) : null}
        </div>
      ) : null}

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
