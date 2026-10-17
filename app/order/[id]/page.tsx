'use client';

// Customer live order-status page (C1/CUS-051..056, PAY-2). Server-sourced (so
// reopening the link always shows current state), updated in real time via the
// per-order broadcast channel with a poll fallback (F2/NFR-002). No login — the
// opaque order id in the URL is the access control, exactly like the
// confirmation page. This is the page notification links point at.
//
// Phase-2 additions (PAY-1/PAY-2): while an online payment is pending
// ('placed'), this page shows the payment state distinctly from fulfillment,
// offers Retry/Pay-at-counter, and self-reconciles against the gateway on a
// bounded poll in case the webhook is late. Once paid it shows a receipt line,
// and once completed it links to leaving a review (LOY-3, another pillar).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import { CUSTOMER_PROGRESS, isTerminal } from '@/lib/orders/stateMachine';
import { useOrderRealtime, type RealtimeConnection } from '@/lib/realtime/hooks';
import { Spinner } from '@/components/ui/Spinner';
import { buttonVariants } from '@/components/ui/Button';
import { SurfaceLink } from '@/components/SurfaceLink';
import { RitualChip } from '@/components/passes/RitualChip';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { isPassSaleOrder, orderPassBill, passSaleNote, ritualTagLabel } from '@/lib/passes/ui';
import { OptInCard } from '@/components/marketing/OptInCard';
import { CAFE_ADDRESS, CAFE_PHONE_DISPLAY, CAFE_PHONE_HREF } from '@/lib/constants';
import { openRazorpayCheckout } from '@/lib/payments/razorpayCheckout';
import { canPayAtCounter, hasBill, paymentFlagMessage } from '@/lib/orders/paymentStatusUI';
import type { Order, OrderItem, OrderStatus } from '@/lib/types';
import { lineSizeSuffix } from '@/lib/menu/weight';

type OrderWithItems = Order & { items: OrderItem[]; coupon_code?: string | null };

// Human labels for the customer track (kept warmer than the internal
// STATUS_LABELS which say "New"/etc.).
const STEP_LABEL: Record<string, string> = {
  received: 'Received',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Collected',
};

// One plain-language line per status, shown above the progress track and
// announced to screen readers (aria-live) as the order moves — the numbered
// dots alone didn't say what's happening or what the customer should do.
const STATUS_HEADLINE: Record<string, { title: string; body: string }> = {
  received: { title: 'Order received', body: 'Waiting for the café to accept it.' },
  accepted: { title: 'Accepted', body: 'The café has your order and will start it shortly.' },
  preparing: { title: 'Being prepared', body: "We're making it now." },
  ready: { title: 'Ready for pickup!', body: 'Show your pickup code at the counter.' },
  completed: { title: 'Collected — enjoy!', body: 'Thanks for ordering with us.' },
};

const PAYMENT_POLL_MS = 4000;
const PAYMENT_POLL_MAX_ATTEMPTS = 30; // ~2 minutes bounded reconciliation window

// Set by the checkout pages when the customer chose to pay online but the
// gateway was unavailable, so the server placed the order as pay-at-counter.
const PAYMENT_UNAVAILABLE_MSG =
  "Online payment isn't available right now, so your order was placed as pay at the counter. Please pay when you collect it.";

export default function OrderStatusPage() {
  const params = useParams<{ id: string }>();
  const orderId = params?.id ?? null;
  const searchParams = useSearchParams();
  const paymentUnavailable = searchParams.get('payment') === 'unavailable';

  const [order, setOrder] = useState<OrderWithItems | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [paying, setPaying] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [paymentActionError, setPaymentActionError] = useState('');
  // The ?payment= flag's message is only a fallback for paymentActionError
  // (below) — once the customer has actually taken an action (retry or
  // switch), the stale "didn't go through"/"was cancelled" copy from the URL
  // must not reappear just because paymentActionError was cleared back to ''
  // for the new attempt.
  const [flagDismissed, setFlagDismissed] = useState(false);
  const pollAttempts = useRef(0);
  // Bumped whenever a retry starts or a Razorpay attempt succeeds, so the
  // reconciliation-poll effect below tears down and restarts with a fresh
  // budget instead of quietly staying exhausted from an earlier failed
  // attempt (PAY-2 issue-2: a retry's poll window must never inherit a spent
  // one from a previous failed/abandoned attempt on the same order).
  const [pollEpoch, setPollEpoch] = useState(0);

  const fetchOrder = useCallback(async () => {
    if (!orderId) return;
    try {
      const res = await fetch(`/api/orders/${orderId}`, { cache: 'no-store' });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setOrder(data.order as OrderWithItems);
    } catch {
      // Keep last-known-good; the poll/realtime will retry.
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  const connection = useOrderRealtime(orderId, fetchOrder);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  // Bounded reconciliation poll (PAY-2/FND-1 "webhook delayed" edge case):
  // while payment is pending, ask the server to check with the gateway
  // directly, then refetch the order to pick up any change.
  useEffect(() => {
    if (!orderId || order?.payment_status !== 'payment_pending') {
      pollAttempts.current = 0;
      return;
    }
    // A fresh window every time this effect (re)starts — including on a
    // pollEpoch bump — so a retry always gets its own ~2 minutes rather than
    // continuing to spend down whatever budget a prior failed attempt left.
    pollAttempts.current = 0;
    const interval = setInterval(async () => {
      if (pollAttempts.current >= PAYMENT_POLL_MAX_ATTEMPTS) {
        clearInterval(interval);
        return;
      }
      pollAttempts.current += 1;
      try {
        await fetch(`/api/payments/${orderId}/status`, { cache: 'no-store' });
      } catch {
        // Ignore — next tick (or the webhook) will catch it up.
      }
      fetchOrder();
    }, PAYMENT_POLL_MS);
    return () => clearInterval(interval);
  }, [orderId, order?.payment_status, pollEpoch, fetchOrder]);

  const handleCancel = useCallback(async () => {
    if (!orderId) return;
    setCancelling(true);
    setCancelError('');
    try {
      const res = await fetch(`/api/orders/${orderId}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCancelError(data.error ?? 'Could not cancel — please call the cafe.');
      }
      await fetchOrder();
    } catch {
      setCancelError('Could not cancel — please call the cafe.');
    } finally {
      setCancelling(false);
    }
  }, [orderId, fetchOrder]);

  const handleRetryPayment = useCallback(async () => {
    if (!orderId || !order) return;
    setPaying(true);
    setPaymentActionError('');
    setFlagDismissed(true);
    // Issue-2: a retry always gets a fresh reconciliation-poll budget, even if
    // an earlier failed/abandoned attempt on this order already spent one out
    // sitting on the "waiting on payment" screen — otherwise a payment that
    // captures on THIS attempt could go unnoticed until the webhook (if any)
    // arrives, and the order would never enter the queue or get its bill.
    pollAttempts.current = 0;
    setPollEpoch((e) => e + 1);
    const allowCounter = canPayAtCounter(order);
    try {
      const res = await fetch(`/api/payments/${orderId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.payment) {
        setPaymentActionError(data.error ?? 'Could not start payment — please try again.');
        return;
      }
      await openRazorpayCheckout(data.payment, {
        name: order.customer_name,
        phone: order.customer_phone,
        description: `Order #${formatOrderNumber(order.order_number)}`,
        onSuccess: () => {
          // The signature verified, but the payment may still only be
          // 'authorized' (not yet captured) — see app/api/payments/verify —
          // so re-arm the poll here too: this is exactly the moment a fresh
          // reconciliation window matters most.
          pollAttempts.current = 0;
          setPollEpoch((e) => e + 1);
          fetchOrder();
        },
        onDismiss: (lastFailure) => {
          setPaymentActionError(
            lastFailure
              ? `Payment failed: ${lastFailure}`
              : allowCounter
                ? 'Payment was cancelled — you can retry or pay at the counter.'
                : 'Payment was cancelled — please retry the payment.',
          );
          fetchOrder();
        },
        onFailure: (msg) => {
          setPaymentActionError(msg);
          fetchOrder();
        },
        onPaymentFailed: (msg) => setPaymentActionError(`Payment failed: ${msg}`),
      });
    } catch {
      setPaymentActionError('Network error — please try again.');
    } finally {
      setPaying(false);
    }
  }, [orderId, order, fetchOrder]);

  const handleSwitchToCounter = useCallback(async () => {
    if (!orderId) return;
    setSwitching(true);
    setPaymentActionError('');
    setFlagDismissed(true);
    try {
      const res = await fetch(`/api/payments/${orderId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'switch_to_counter' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPaymentActionError(data.error ?? 'Could not switch to pay at counter.');
      }
      await fetchOrder();
    } catch {
      setPaymentActionError('Network error — please try again.');
    } finally {
      setSwitching(false);
    }
  }, [orderId, fetchOrder]);

  if (loading) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <Spinner label="Loading your order…" />
      </div>
    );
  }

  if (notFound || !order) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Order Not Found</h1>
        <p className="mt-4 text-muted">
          We couldn&apos;t find that order. The link may be incorrect.
        </p>
        <Link
          href="/menu"
          className="mt-6 inline-block rounded-md bg-tan-dark px-6 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker"
        >
          Back to Menu
        </Link>
      </div>
    );
  }

  const rejected = order.status === 'rejected';
  const cancelled = order.status === 'cancelled';
  const negative = rejected || cancelled;
  const awaitingPayment = order.status === 'placed'; // gated on online payment (PAY-1)
  // The SALE of a HIOC Ritual, not a menu order: no kitchen, no pickup, and it
  // cannot be switched to pay-at-counter (the server refuses it).
  const isPassSale = isPassSaleOrder(order);
  const allowCounter = canPayAtCounter(order) && !isPassSale; // issue-1: web guests never see this offered
  const displayedPaymentError =
    paymentActionError ||
    (flagDismissed ? '' : paymentFlagMessage(searchParams.get('payment'), allowCounter));

  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">
          Order #<span className="font-mono tabular-nums">{formatOrderNumber(order.order_number)}</span>
        </h1>
        <ConnectionDot connection={connection} />
      </div>
      <p className="mt-1 text-sm text-muted">
        Hi {order.customer_name.split(' ')[0]} — here&apos;s your live status.
      </p>
      <PaymentBadge order={order} />

      {paymentUnavailable && !awaitingPayment && order.payment_status !== 'paid' ? (
        <p
          role="status"
          className="mt-6 rounded-md border border-tan bg-surface px-4 py-3 text-sm font-semibold text-charcoal"
        >
          {PAYMENT_UNAVAILABLE_MSG}
        </p>
      ) : null}

      {awaitingPayment ? (
        <div className="mt-6 rounded-md border border-tan bg-surface p-6 text-center">
          <h2 className="text-lg font-bold text-charcoal">Waiting on payment</h2>
          <p className="mt-2 text-sm text-charcoal">
            {isPassSale
              ? `Your ${PASS_PROGRAM_NAME} will be ready as soon as payment is confirmed`
              : 'Your order will join the kitchen queue as soon as payment is confirmed'}{' '}
            — this updates automatically, usually within a few seconds.
          </p>
          {displayedPaymentError ? (
            <p className="mt-3 text-sm font-semibold text-red-700">{displayedPaymentError}</p>
          ) : null}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={handleRetryPayment}
              disabled={paying}
              className="min-h-[44px] rounded-md bg-tan-dark px-5 py-2.5 font-semibold text-cream transition-colors hover:bg-tan-darker disabled:opacity-60"
            >
              {paying ? 'Opening payment…' : 'Retry payment'}
            </button>
            {allowCounter ? (
              <button
                type="button"
                onClick={handleSwitchToCounter}
                disabled={switching}
                className="min-h-[44px] rounded-md border border-line px-5 py-2.5 font-semibold text-charcoal transition-colors hover:border-tan disabled:opacity-60"
              >
                {switching ? 'Switching…' : 'Switch to pay at counter'}
              </button>
            ) : null}
          </div>
        </div>
      ) : negative ? (
        <div className="mt-8 rounded-md border border-red-200 bg-red-50 p-6 text-center">
          <h2 className="text-lg font-bold text-red-800">
            {rejected ? 'Order could not be accepted' : 'Order cancelled'}
          </h2>
          {order.reject_reason ? (
            <p className="mt-2 text-sm text-red-700">Reason: {order.reject_reason}</p>
          ) : null}
          <p className="mt-2 text-sm text-muted">
            {order.payment_status === 'refunded' || order.payment_status === 'partially_refunded'
              ? 'Your payment has been refunded.'
              : 'No charge was made.'}{' '}
            Sorry for the inconvenience.
          </p>
        </div>
      ) : isPassSale ? (
        <PassSaleNote paymentStatus={order.payment_status} />
      ) : (
        <>
          {STATUS_HEADLINE[order.status] ? (
            <div
              aria-live="polite"
              className={
                'mt-6 rounded-md px-4 py-3 text-center ' +
                (order.status === 'ready' ? 'bg-tan-dark text-cream' : 'bg-surface text-charcoal')
              }
            >
              <p className="text-lg font-bold">{STATUS_HEADLINE[order.status].title}</p>
              <p className="text-sm">{STATUS_HEADLINE[order.status].body}</p>
            </div>
          ) : null}

          <ProgressTrack status={order.status} />

          {order.status === 'accepted' && order.promised_ready_at ? (
            <p className="mt-4 text-center font-bold text-charcoal">
              Ready by ~{formatIstTime(new Date(order.promised_ready_at))}
            </p>
          ) : null}

          {order.status === 'completed' ? (
            <div className="mt-4 text-center">
              <Link
                href={`/order/${order.id}/review`}
                className="inline-flex min-h-[44px] items-center rounded-md border border-tan px-5 text-sm font-semibold text-tan-dark hover:bg-surface"
              >
                Rate your order
              </Link>
            </div>
          ) : null}

          {/* Pickup code, shown prominently for the counter (CUS-056). */}
          {order.pickup_code ? (
            <div className="mt-6 rounded-md border border-line bg-cream p-6 text-center shadow-sm">
              <p className="text-xs uppercase tracking-wide text-muted">Show this at the counter</p>
              <p className="mt-1 font-mono text-4xl font-bold tracking-[0.3em] tabular-nums text-charcoal">
                {order.pickup_code}
              </p>
            </div>
          ) : null}
        </>
      )}

      {/* Items + bill breakup / receipt (C5, PAY-1). */}
      <div className="mt-8 rounded-md border border-line bg-cream p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-bold text-charcoal">
          {order.payment_status === 'paid' ? 'Receipt' : 'Order Summary'}
        </h2>
        <ul className="flex flex-col gap-3">
          {order.items.map((item) => (
            <li key={item.id} className="text-sm text-charcoal">
              <div className="flex items-start justify-between">
                <span>
                  {item.name_snapshot}
                  {lineSizeSuffix(item.variant_label_snapshot, item.weight_grams)} ×{' '}
                  {item.quantity}
                  {!item.voided && item.pass_drinks && item.pass_drinks > 0 ? (
                    <RitualChip className="ml-2 align-middle">{ritualTagLabel(item.pass_drinks)}</RitualChip>
                  ) : null}
                </span>
                <span className="shrink-0 font-mono font-bold tabular-nums">₹{item.line_total_inr}</span>
              </div>
              {item.addons.length > 0 ? (
                <p className="mt-0.5 text-sm text-muted">
                  {item.addons.map((a) => a.option_name_snapshot).join(', ')}
                </p>
              ) : null}
              {item.special_instructions ? (
                <p className="mt-0.5 text-sm italic text-muted">Note: {item.special_instructions}</p>
              ) : null}
            </li>
          ))}
        </ul>
        <BillRows order={order} />
        {hasBill(order) ? (
          <div className="mt-4 text-center">
            <Link
              href={`/order/${order.id}/receipt`}
              className="inline-flex min-h-[44px] items-center rounded-md border border-tan px-5 text-sm font-semibold text-tan-dark hover:bg-surface"
            >
              View / print bill
            </Link>
          </div>
        ) : null}
      </div>

      {!awaitingPayment && !isPassSale ? (
        <p className="mt-6 text-center text-sm text-charcoal">
          Pickup: <span className="font-bold">{order.pickup_slot_label || order.pickup_time}</span>
        </p>
      ) : null}
      {/* Guest orders carry no phone — don't promise messages to nobody. A Ritual
          purchase has no progress to message about. */}
      {isPassSale ? null : (
        <p className="mt-1 text-center text-sm italic text-muted">
          {order.customer_phone
            ? <>We&apos;ll message you on {order.customer_phone} as your order progresses.</>
            : 'Keep this page open — it updates live as your order progresses.'}
        </p>
      )}

      {/* Self-cancel — only before staff accept the order (F1). */}
      {order.status === 'received' && !isPassSale ? (
        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="min-h-[44px] rounded-md border border-line px-5 py-2 text-sm font-semibold text-muted transition-colors hover:border-red-300 hover:text-red-700 disabled:opacity-50"
          >
            {cancelling ? 'Cancelling…' : 'Cancel order'}
          </button>
          {cancelError ? <p className="mt-2 text-sm text-red-700">{cancelError}</p> : null}
        </div>
      ) : null}

      {/* Marketing opt-in (spec §2). Below the order details, quiet: renders nothing
          unless the flag is on and there is a way for this customer to say yes. The
          old /order-confirmation/[orderId] URL redirects here, so this IS the
          confirmation page. */}
      <OptInCard />

      <div className="mt-10 rounded-md border border-line bg-cream p-6 text-center shadow-sm">
        <h3 className="font-semibold text-charcoal">Need help?</h3>
        <p className="mt-2 text-sm text-muted">{CAFE_ADDRESS}</p>
        <a href={CAFE_PHONE_HREF} className="mt-1 inline-block text-sm text-tan-dark hover:underline">
          {CAFE_PHONE_DISPLAY}
        </a>
      </div>
    </div>
  );
}

// Payment state shown distinctly from fulfillment status (PAY-2 AC).
function PaymentBadge({ order }: { order: OrderWithItems }) {
  const label: Record<string, string> = {
    unpaid: 'Pay at counter',
    payment_pending: 'Payment pending',
    paid: 'Paid',
    refunded: 'Refunded',
    partially_refunded: 'Partially refunded',
  };
  const tone =
    order.payment_status === 'paid'
      ? 'bg-[#e8f3ea] text-[#2f6b38]'
      : order.payment_status === 'payment_pending'
        ? 'bg-[#fbeecb] text-[#8a6116]'
        : order.payment_status === 'refunded' || order.payment_status === 'partially_refunded'
          ? 'bg-surface text-tan-dark'
          : 'bg-[#f2efe9] text-muted';
  return (
    <span className={'mt-2 inline-block rounded-md px-2.5 py-1 text-xs font-semibold ' + tone}>
      Payment: {label[order.payment_status] ?? order.payment_status}
      {order.payment_status === 'paid' && order.payment_method ? ` · ${order.payment_method}` : ''}
    </span>
  );
}

function BillRows({ order }: { order: OrderWithItems }) {
  const total = order.total_inr ?? order.subtotal_inr;
  const discountLabel = order.coupon_code ? `Discount (${order.coupon_code})` : 'Discount';
  // HIOC Ritual: total = subtotal + tax + packaging - discount - Ritual. The
  // Ritual comes before the coupon, the order they were applied in (CP-D12).
  const passBill = orderPassBill(order);
  return (
    <div className="mt-4 flex flex-col gap-1 border-t border-line pt-4 text-sm">
      <Row label="Subtotal" value={order.subtotal_inr} />
      {order.tax_inr > 0 ? <Row label="GST" value={order.tax_inr} /> : null}
      {order.packaging_inr > 0 ? <Row label="Packaging" value={order.packaging_inr} /> : null}
      {passBill ? <Row label={passBill.label} value={-passBill.discountInr} tone="success" /> : null}
      {order.discount_inr > 0 ? <Row label={discountLabel} value={-order.discount_inr} /> : null}
      <div className="mt-1 flex items-center justify-between border-t border-line pt-2">
        <span className="font-bold text-charcoal">Total</span>
        <span className="font-mono font-bold tabular-nums text-tan-dark">₹{total}</span>
      </div>
    </div>
  );
}

// `tone="success"` is the green a discount that is in effect gets in the
// checkout's bill (CheckoutForm), so the Ritual reads the same on both.
function Row({ label, value, tone }: { label: string; value: number; tone?: 'success' }) {
  const toneClass = tone === 'success' ? 'font-bold text-green-700' : 'text-charcoal';
  return (
    <div className={'flex items-center justify-between ' + toneClass}>
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value < 0 ? `-₹${Math.abs(value)}` : `₹${value}`}</span>
    </div>
  );
}

// What a Ritual purchase shows in place of the kitchen progress and the pickup
// code: whether the Ritual is active yet, and where to find it.
function PassSaleNote({ paymentStatus }: { paymentStatus: string }) {
  const note = passSaleNote(paymentStatus);
  return (
    <div aria-live="polite" className="mt-6 rounded-md bg-surface px-4 py-4 text-center text-charcoal">
      <p className="font-semibold">{note.text}</p>
      {note.link ? (
        <SurfaceLink href="/ritual" className={buttonVariants({ className: 'mt-3' })}>
          View my {PASS_PROGRAM_NAME}
        </SurfaceLink>
      ) : null}
    </div>
  );
}

// The horizontal progress track: each step filled up to the current status.
function ProgressTrack({ status }: { status: OrderStatus }) {
  const activeIndex = CUSTOMER_PROGRESS.indexOf(status as (typeof CUSTOMER_PROGRESS)[number]);
  const currentIndex = isTerminal(status) ? CUSTOMER_PROGRESS.length - 1 : activeIndex;

  return (
    <ol className="mt-8 flex items-center">
      {CUSTOMER_PROGRESS.map((step, i) => {
        const done = i <= currentIndex && currentIndex >= 0;
        const isCurrent = i === currentIndex;
        return (
          <li key={step} aria-current={isCurrent ? 'step' : undefined} className="flex flex-1 flex-col items-center">
            <div className="flex w-full items-center">
              {i > 0 ? (
                <div className={`h-1 flex-1 ${done ? 'bg-tan' : 'bg-line'}`} />
              ) : (
                <div className="flex-1" />
              )}
              <div
                className={
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ' +
                  (done ? 'bg-tan-dark text-cream' : 'bg-line text-muted') +
                  (isCurrent ? ' ring-2 ring-tan ring-offset-2' : '')
                }
              >
                {done && !isCurrent ? <span aria-hidden="true">✓</span> : <span aria-hidden="true">{i + 1}</span>}
              </div>
              {i < CUSTOMER_PROGRESS.length - 1 ? (
                <div className={`h-1 flex-1 ${i < currentIndex ? 'bg-tan' : 'bg-line'}`} />
              ) : (
                <div className="flex-1" />
              )}
            </div>
            <span className={'mt-2 text-xs ' + (done ? 'font-bold text-charcoal' : 'text-muted')}>
              {STEP_LABEL[step]}
              {done && !isCurrent ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ConnectionDot({ connection }: { connection: RealtimeConnection }) {
  const live = connection === 'live';
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted" title={connection}>
      <span
        className={
          'inline-block h-2 w-2 rounded-full ' +
          (live ? 'bg-green-500' : connection === 'connecting' ? 'bg-amber-400' : 'bg-muted')
        }
      />
      {live ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
    </span>
  );
}
