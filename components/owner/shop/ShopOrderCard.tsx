'use client';

// One order on Owner → Shop orders, with what can be done to it next:
//   To ship         Send to Shiprocket (the one click, after checking the
//                   parcel's weight and size) · Ship with Amazon Shipping (see
//                   Amazon's prices and dates, then Book this one) · Mark
//                   shipped by hand · Cancel
//   In Shiprocket   Refresh from Shiprocket · Mark shipped by hand · Cancel
//   With courier, an Amazon order
//                   Refresh from Amazon · Print label · Cancel the Amazon
//                   label (before pickup only) · Mark delivered · Cancel
//   Shipped         Refresh · Mark delivered · Cancel & refund
//   Delivered       Cancel & refund (e.g. arrived damaged)
// Every action calls an /api/owner/shop route and refreshes the server page.
//
// v2 (docs/SHOP-V2-SPEC.md E6): each Home Blend line shows its grind in bold,
// with a packing checklist (grind this much for that brew method); the money
// section lists every discount (offer, coupon with its code, Beanies) then
// shipping and the total; "Intro offer reused" flags two checkouts that raced
// for the once-per-customer offer; the send dialog starts from the parcel worked
// out from the lines; Cancel says how many Beanies went back to the customer and
// Mark delivered how many they earned.
//
// Once an order is in Shiprocket, the card also checks Shiprocket's bill (its
// own order total, read back on send and on Refresh) against what the customer
// paid, and warns in red when they differ (lib/shop/status.ts).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AmazonShipDialog, type AmazonBookedAnswer } from './AmazonShipDialog';
import { isAmazonBookingHeld, labelBlobFromBase64 } from '@/lib/shop/amazonDialog';
import { defaultPackageForLines, lineOf, packingChecklist } from '@/lib/shop/catalog';
import { describePin, googleMapsLink, locationFromRow } from '@/lib/shop/location';
import { needsLinkRetry, paymentLineOf, readCancelAnswer, readRetryAnswer, whatsappShareUrl } from '@/lib/shop/ownerNewOrder';
import { jarsLabel, rupees, unitsLabel } from '@/lib/shop/pricing';
import {
  canCancel,
  canMarkDelivered,
  canCancelAmazonLabel,
  canMarkShipped,
  canShipWithAmazon,
  canSendToShiprocket,
  isAmazonOrder,
  orderCarrier,
  OWNER_STATUS_LABEL,
  shiprocketBillCheck,
  shiprocketBillWarning,
  shopOrderDiscountBreakdown,
  shopOrderRef,
  trackingUrl,
} from '@/lib/shop/status';
import type { ShopOrderRow, ShopOrderStatus } from '@/lib/shop/types';

type Panel = 'send' | 'amazon' | 'amazonCancel' | 'ship' | 'cancel' | null;

/** An owner-entered order whose payment link has not been paid yet. */
function isAwaitingLink(o: Pick<ShopOrderRow, 'status' | 'payment_channel'>): boolean {
  return o.status === 'payment_pending' && o.payment_channel === 'payment_link';
}

interface ActResult {
  error?: string;
  warning?: string;
  beanies_returned?: number;
  earned?: number;
  order?: { refunded_inr?: number | null; status?: ShopOrderStatus };
}

const STATUS_TONE: Record<ShopOrderStatus, string> = {
  payment_pending: 'border-line text-muted',
  expired: 'border-line text-muted',
  paid: 'border-amber-600 text-amber-800',
  sent_to_shiprocket: 'border-tan text-tan-dark',
  shipped: 'border-tan text-tan-dark',
  delivered: 'border-green-700 text-green-800',
  cancelled: 'border-red-700 text-red-700',
};

function when(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function addressText(o: ShopOrderRow): string {
  const pin = locationFromRow(o);
  return [
    o.customer_name,
    o.address_line1,
    o.address_line2,
    `${o.city}, ${o.state} ${o.pincode}`,
    o.phone,
    pin ? `Map pin: ${googleMapsLink(pin)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function ShopOrderCard({
  order,
  shiprocketReady,
  amazonReady = false,
  amazonMissing = [],
}: {
  order: ShopOrderRow;
  shiprocketReady: boolean;
  /** Amazon Shipping set up in Vercel and the database file applied (passed by the page). */
  amazonReady?: boolean;
  /** Names of the AMAZON_SHIPPING_* settings still empty in Vercel. */
  amazonMissing?: string[];
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'ok' | 'error' | 'warn';
    text: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // Set after Cancel / Mark delivered: the order has left this tab, so the card
  // stays mounted (actions hidden) until the owner dismisses the result.
  const [settled, setSettled] = useState(false);
  // The status the action left the order in (from the response), shown on the
  // badge while the settled card waits to be dismissed.
  const [settledStatus, setSettledStatus] = useState<ShopOrderStatus | null>(null);

  const pkg0 = defaultPackageForLines(order.lines);
  const checklist = packingChecklist(order.lines);
  const discounts = shopOrderDiscountBreakdown(order);
  const awaitingLink = isAwaitingLink(order);
  const linkUnconfirmed = needsLinkRetry(order);
  // The link a successful Retry link just made (the page data is refreshed behind it).
  const [retried, setRetried] = useState<{ url: string; expiresAt: string | null } | null>(null);
  const linkUrl = order.payment_link_url ?? retried?.url ?? null;
  const paymentLine = paymentLineOf(order);
  const [pkg, setPkg] = useState({
    weight_kg: String(pkg0.weight_kg),
    length_cm: String(pkg0.length_cm),
    breadth_cm: String(pkg0.breadth_cm),
    height_cm: String(pkg0.height_cm),
  });
  const [awb, setAwb] = useState('');
  const [courier, setCourier] = useState(order.courier_name ?? '');
  const [reason, setReason] = useState('');

  const ref = shopOrderRef(order.order_number);
  const tracking = trackingUrl(order.awb_code, orderCarrier(order));
  const amazonOrder = isAmazonOrder(order);
  const amazonHeld = isAmazonBookingHeld(order);
  const canRefreshAmazon = amazonOrder && order.status === 'shipped';
  const [labelBooked, setLabelBooked] = useState(false);
  const pin = locationFromRow(order);
  const canRefresh = Boolean(order.shiprocket_order_id) && (order.status === 'sent_to_shiprocket' || order.status === 'shipped');
  const bill = amazonOrder ? null : shiprocketBillCheck(order);
  const billWarning = amazonOrder ? null : shiprocketBillWarning(order);

  async function act(path: string, method: 'POST' | 'PATCH', body: unknown, done: string | ((data: ActResult) => string), keepResult = false) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json().catch(() => ({}))) as ActResult;
      if (!res.ok) {
        setMessage({
          tone: 'error',
          text: data.error ?? `Something went wrong (HTTP ${res.status}).`,
        });
        return;
      }
      setPanel(null);
      const text = typeof done === 'function' ? done(data) : done;
      setMessage(data.warning ? { tone: 'warn', text: `${data.warning} ${text}` } : { tone: 'ok', text });
      if (keepResult) {
        setSettled(true);
        if (data.order?.status) setSettledStatus(data.order.status);
      }
      else router.refresh();
    } catch {
      setMessage({ tone: 'error', text: 'Network error — please try again.' });
    } finally {
      setBusy(false);
    }
  }

  // The label came back with the booking: open it. If the browser blocks the new tab,
  // Print label stays on the card.
  function openLabel(b64: string) {
    const blob = labelBlobFromBase64(b64);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function amazonBooked(data: AmazonBookedAnswer) {
    if (data.label) openLabel(data.label);
    setPanel(null);
    setLabelBooked(true);
    const text = 'Booked with Amazon Shipping. Print the label, stick it on the box and hand it to the Amazon pickup.';
    setMessage(data.warning ? { tone: 'warn', text: `${data.warning} ${text}` } : { tone: 'ok', text });
    setSettled(true);
    setSettledStatus('shipped');
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(addressText(order));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage({
        tone: 'error',
        text: 'Could not copy — select the address and copy it by hand.',
      });
    }
  }

  const base = `/api/owner/shop/orders/${order.id}`;
  const refundByHand = order.payment_channel === 'offline';

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(linkUrl ?? '');
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      setMessage({ tone: 'error', text: 'Could not copy. The link is on the order in Razorpay; try again.' });
    }
  }

  async function retryLink() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${base}/payment-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      });
      const out = readRetryAnswer(res.status, await res.json().catch(() => ({})));
      if (out.kind === 'link') {
        setRetried({ url: out.url, expiresAt: out.expiresAt });
        setMessage({ tone: 'ok', text: 'The payment link is confirmed. Copy it or share it on WhatsApp.' });
      } else if (out.kind === 'paid') {
        setMessage({ tone: 'ok', text: 'Already paid: moved to To ship.' });
        router.refresh();
      } else if (out.kind === 'gone') {
        setMessage({ tone: 'warn', text: out.message });
        router.refresh();
      } else {
        setMessage({ tone: 'error', text: out.message });
      }
    } catch {
      setMessage({ tone: 'error', text: 'Network error — please try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function resendLink() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${base}/payment-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resend' }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) setMessage({ tone: 'ok', text: 'Link sent again by Razorpay.' });
      else if (res.status === 409) {
        setMessage({ tone: 'warn', text: data.error || 'This order is no longer waiting for its link. The list is refreshed.' });
        router.refresh();
      } else setMessage({ tone: 'error', text: data.error || "Razorpay didn't send the link. Copy it and send it yourself." });
    } catch {
      setMessage({ tone: 'error', text: 'Network error — please try again.' });
    } finally {
      setBusy(false);
    }
  }

  // Cancel: an unpaid link order (the link is closed first), a paid order refunded through
  // Razorpay, or one paid by UPI / cash / bank transfer (refunded by hand: a reminder, not a refund).
  async function cancelOrder() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${base}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = (await res.json().catch(() => ({}))) as ActResult & { refund_by_hand?: boolean };
      if (!res.ok) {
        const n = readCancelAnswer(res.status, data, order.total_inr);
        setMessage({ tone: n.tone, text: n.text });
        if (n.refresh) {
          setPanel(null);
          router.refresh();
        }
        return;
      }
      setPanel(null);
      let text: string;
      let tone: 'ok' | 'warn' = data.warning ? 'warn' : 'ok';
      if (data.refund_by_hand) {
        const n = readCancelAnswer(res.status, data, order.total_inr);
        text = n.text;
        tone = 'warn';
      } else {
        const n = data.beanies_returned ?? 0;
        const beanies =
          n > 0
            ? ` ${n} ${n === 1 ? 'Beanie' : 'Beanies'} returned to the customer.`
            : n < 0
              ? ` ${-n} ${n === -1 ? 'Beanie' : 'Beanies'} taken back from the customer.`
              : '';
        const refunded = data.order?.refunded_inr ?? 0;
        const money = refunded > 0 ? `Refunded ${rupees(refunded)}.` : awaitingLink ? 'Cancelled. The payment link is closed and nothing was charged.' : 'Cancelled (no online payment to refund).';
        text = `${data.warning ? `${data.warning} ` : ''}${money}${beanies}`;
      }
      setMessage({ tone, text });
      setSettled(true);
      if (data.order?.status) setSettledStatus(data.order.status);
    } catch {
      setMessage({ tone: 'error', text: 'Network error — please try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-md border border-line bg-cream p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex flex-wrap items-center gap-2 font-mono text-sm font-semibold tabular-nums text-charcoal">
            {ref}
            {order.source === 'owner' ? (
              <Badge variant="outline" className="font-sans">
                Added by owner
              </Badge>
            ) : null}
          </p>
          <p className="text-xs text-muted">
            {order.paid_at ? `Paid ${when(order.paid_at)}` : `Started ${when(order.created_at)}`}
            {order.payment_method ? ` · ${order.payment_method.toUpperCase()}` : ''}
          </p>
          {paymentLine ? <p className="text-xs font-semibold text-charcoal">{paymentLine}</p> : null}
        </div>
        <span
          className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-bold ${STATUS_TONE[settledStatus ?? order.status]}`}
        >
          {awaitingLink && !settledStatus ? 'Awaiting payment' : OWNER_STATUS_LABEL[settledStatus ?? order.status]}
        </span>
      </div>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{order.lines.every((l) => lineOf(l) === 'instant') ? jarsLabel(order.jar_count) : unitsLabel(order.jar_count)}</p>
          <ul className="mt-1 text-sm text-charcoal">
            {order.lines.map((l) => (
              <li key={`${l.product_id}:${l.grind ?? ''}`}>
                {lineOf(l) === 'home_blend' ? (
                  <>
                    {l.name} × <strong>{l.quantity}</strong>
                    {l.grind ? (
                      <>
                        {' · '}
                        <strong>{l.grind_label ?? l.grind}</strong>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    {l.name} × <strong>{l.quantity}</strong>
                  </>
                )}
              </li>
            ))}
          </ul>
          {checklist.length > 0 ? (
            <div className="mt-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Packing checklist</p>
              <ul className="mt-1 space-y-0.5 text-sm text-charcoal">
                {checklist.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden="true" className="text-muted">
                      ☐
                    </span>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <dl className="mt-3 space-y-0.5 text-sm text-charcoal">
            {discounts.length > 0 ? (
              <div className="flex justify-between gap-3">
                <dt>Items</dt>
                <dd className="font-mono tabular-nums">{rupees(order.subtotal_inr)}</dd>
              </div>
            ) : null}
            {discounts.map((d) => (
              <div key={d.kind} className="flex justify-between gap-3">
                <dt>
                  {d.kind === 'owner' ? 'Owner discount' : d.label}
                  {d.kind === 'owner' && order.owner_discount_reason ? (
                    <span className="block text-xs text-muted">“{order.owner_discount_reason}”</span>
                  ) : null}
                </dt>
                <dd className="font-mono tabular-nums">−{rupees(d.amount_inr)}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3">
              <dt>Shipping</dt>
              <dd className="font-mono tabular-nums">{order.shipping_inr ? rupees(order.shipping_inr) : 'Free'}</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-line pt-1 font-semibold">
              <dt>Total</dt>
              <dd className="font-mono tabular-nums">{rupees(order.total_inr)}</dd>
            </div>
          </dl>
          {order.intro_offer_reused ? (
            <div className="mt-2">
              <Badge variant="outline" className="border-amber-600 text-amber-800">
                <span aria-hidden="true">⚠</span> Intro offer reused
              </Badge>
              <p className="mt-1 text-xs text-muted">
                This customer had already used the introductory offer; two checkouts raced, so the price was honoured.
              </p>
            </div>
          ) : null}
        </div>
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Deliver to</p>
            <button type="button" onClick={() => void copyAddress()} className="text-xs font-semibold text-tan-dark underline">
              {copied ? 'Copied' : 'Copy address'}
            </button>
          </div>
          <address className="mt-1 whitespace-pre-line text-sm not-italic text-charcoal">
            {[order.customer_name, order.address_line1, order.address_line2, `${order.city}, ${order.state} ${order.pincode}`, order.phone]
              .filter(Boolean)
              .join('\n')}
          </address>
          <p className="mt-1 break-all text-xs text-muted">{order.email}</p>
          {pin ? (
            <p className="mt-2 text-sm">
              <a href={googleMapsLink(pin)} target="_blank" rel="noopener noreferrer" className="font-semibold text-tan-dark underline">
                Open delivery pin in Google Maps
              </a>
              <span className="block text-xs text-muted">Customer&apos;s pin, {describePin(pin)} · sent to Shiprocket with the order</span>
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted">No map pin — address only.</p>
          )}
        </div>
      </div>

      {order.shiprocket_order_id || order.awb_code || amazonOrder ? (
        <div className="mt-3 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
          {amazonOrder ? (
            <p>
              Amazon Shipping
              {order.amazon_service_name ? ` · ${order.amazon_service_name}` : ''}
              {order.amazon_charge_inr != null ? ` · ${rupees(order.amazon_charge_inr)}` : ''}
              {order.package_dims_cm ? (
                <span className="text-muted">
                  {' '}
                  · {order.package_weight_kg} kg, {order.package_dims_cm} cm
                </span>
              ) : null}
            </p>
          ) : null}
          {amazonOrder && !order.awb_code ? <p className="text-xs text-muted">No tracking number yet. Press Refresh from Amazon.</p> : null}
          {amazonOrder && order.amazon_status ? <p>Amazon says: {order.amazon_status}</p> : null}
          {order.shiprocket_order_id ? (
            <p>
              Shiprocket order <span className="font-mono tabular-nums">{order.shiprocket_order_id}</span>
              {order.shiprocket_status ? ` · ${order.shiprocket_status}` : ''}
              {order.package_dims_cm ? (
                <span className="text-muted">
                  {' '}
                  · {order.package_weight_kg} kg, {order.package_dims_cm} cm
                </span>
              ) : null}
            </p>
          ) : null}
          {order.awb_code ? (
            <p>
              {amazonOrder ? 'Tracking number' : `${order.courier_name ? `${order.courier_name} · ` : ''}AWB`} <span className="font-mono tabular-nums">{order.awb_code}</span>
              {tracking ? (
                <>
                  {' '}
                  ·{' '}
                  <a href={tracking} target="_blank" rel="noopener noreferrer" className="font-semibold text-tan-dark underline">
                    Track
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {bill?.state === 'matches' ? (
            <p className="text-green-800">
              <span aria-hidden="true">✓ </span>Shiprocket&apos;s bill{' '}
              <span className="font-mono font-semibold tabular-nums">{rupees(bill.shiprocket)}</span> matches what the customer paid
            </p>
          ) : bill?.state === 'exception' ? (
            <p className="text-xs text-muted">
              Shiprocket&apos;s bill says {rupees(bill.shiprocket)}; the customer paid {rupees(bill.paid)}. {bill.note}
            </p>
          ) : bill?.state === 'unchecked' && canRefresh ? (
            <p className="text-xs text-muted">Shiprocket&apos;s bill not checked yet — press Refresh from Shiprocket.</p>
          ) : bill?.state === 'differs' && !canRefresh ? (
            // Delivered or cancelled: nothing left to correct, so a note, not an alarm.
            <p className="text-xs text-muted">
              Shiprocket&apos;s bill said {rupees(bill.shiprocket)}; the customer paid {rupees(bill.paid)}.
            </p>
          ) : null}
        </div>
      ) : null}
      {billWarning && canRefresh ? (
        <p role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
          {billWarning}
        </p>
      ) : null}

      {order.status === 'cancelled' ? (
        <p className="mt-3 text-sm text-charcoal">
          Cancelled {when(order.cancelled_at)}
          {order.refunded_inr ? ` · refunded ${rupees(order.refunded_inr)}` : ''}
          {order.refund_id && order.refund_id !== 'pending' ? <span className="text-muted"> ({order.refund_id})</span> : null}
          {order.cancel_reason ? <span className="block text-muted">“{order.cancel_reason}”</span> : null}
        </p>
      ) : null}
      {order.refund_id === 'pending' && order.status !== 'cancelled' ? (
        <p className="mt-3 text-sm font-semibold text-amber-800">
          A refund was started but not confirmed. Check this payment in the Razorpay dashboard before trying again.
        </p>
      ) : null}

      {amazonHeld ? (
        <p role="alert" className="mt-3 rounded-md border border-amber-600 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
          An Amazon booking for this order may have gone through. Check Amazon Shipping first.
        </p>
      ) : null}

      {awaitingLink ? (
        <div className="mt-3 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
          {linkUnconfirmed && !retried ? (
            <p>
              <span className="font-semibold text-amber-800">Payment link not confirmed yet.</span>{' '}
              <span className="text-muted">The customer may not have it. Tap Retry link to check with Razorpay.</span>
            </p>
          ) : (
            <p>
              <span className="font-semibold">Waiting for the customer to pay the link.</span>
              {(retried?.expiresAt ?? order.payment_link_expires_at) ? <span className="text-muted"> Expires {when(retried?.expiresAt ?? order.payment_link_expires_at)} IST.</span> : null}
            </p>
          )}
        </div>
      ) : null}

      {/* Actions */}
      {settled ? null : (
      <div className="mt-4 flex flex-wrap gap-2">
        {linkUnconfirmed && !retried ? (
          <Button size="sm" loading={busy && panel === null} onClick={() => void retryLink()} disabled={busy}>
            Retry link
          </Button>
        ) : null}
        {awaitingLink && linkUrl ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => void copyLink()} disabled={busy}>
              {linkCopied ? 'Copied' : 'Copy link'}
            </Button>
            <a
              href={whatsappShareUrl({ orderRef: ref, totalInr: order.total_inr, url: linkUrl })}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            >
              Share on WhatsApp
            </a>
            <Button
              size="sm"
              variant="secondary"
              loading={busy && panel === null}
              onClick={() => void resendLink()}
              disabled={busy}
            >
              Resend link
            </Button>
          </>
        ) : null}
        {amazonHeld ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy && panel === null}
            onClick={() => void act(`${base}/amazon/release-hold`, 'POST', {}, 'Released. You can book this order again.')}
            disabled={busy}
          >
            I checked Amazon — nothing was booked
          </Button>
        ) : null}
        {canSendToShiprocket(order) && !amazonHeld ? (
          <Button size="sm" onClick={() => setPanel(panel === 'send' ? null : 'send')} disabled={busy}>
            Send to Shiprocket
          </Button>
        ) : null}
        {canShipWithAmazon(order) && !amazonHeld ? (
          <Button size="sm" onClick={() => setPanel(panel === 'amazon' ? null : 'amazon')} disabled={busy}>
            Ship with Amazon Shipping
          </Button>
        ) : null}
        {canRefreshAmazon ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy && panel === null}
            onClick={() => void act(`${base}/amazon/refresh`, 'POST', {}, 'Updated from Amazon.')}
            disabled={busy}
          >
            Refresh from Amazon
          </Button>
        ) : null}
        {amazonOrder && order.status === 'shipped' ? (
          <a href={`${base}/amazon/label`} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
            Print label
          </a>
        ) : null}
        {canCancelAmazonLabel(order) ? (
          <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setPanel(panel === 'amazonCancel' ? null : 'amazonCancel')} disabled={busy}>
            Cancel the Amazon label
          </Button>
        ) : null}
        {canRefresh ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy && panel === null}
            onClick={() => void act(`${base}/refresh`, 'POST', {}, 'Updated from Shiprocket.')}
            disabled={busy}
          >
            Refresh from Shiprocket
          </Button>
        ) : null}
        {canMarkShipped(order) ? (
          <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'ship' ? null : 'ship')} disabled={busy}>
            Mark shipped by hand
          </Button>
        ) : null}
        {canMarkDelivered(order) ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void act(base, 'PATCH', { action: 'mark_delivered' }, (d) =>
                d.earned && d.earned > 0
                  ? `Marked delivered. ${d.earned} ${d.earned === 1 ? 'Beanie' : 'Beanies'} earned.`
                  : 'Marked delivered.',
                true,
              )
            }
            disabled={busy}
          >
            Mark delivered
          </Button>
        ) : null}
        {canCancel(order) || awaitingLink ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-red-700"
            onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}
            disabled={busy}
          >
            {awaitingLink ? 'Cancel' : refundByHand ? 'Cancel order' : 'Cancel & refund'}
          </Button>
        ) : null}
      </div>
      )}

      {panel === 'send' ? (
        <form
          className="mt-3 rounded-md border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              `${base}/shiprocket`,
              'POST',
              pkg,
              'Sent to Shiprocket. Pick the courier and print the label in the Shiprocket panel, then press Refresh.',
            );
          }}
        >
          <p className="text-sm text-charcoal">
            Check the packed parcel. Shiprocket charges on the larger of its weight and its size (L × B × H ÷ 5000).
          </p>
          {!shiprocketReady ? (
            <p className="mt-2 text-sm font-semibold text-amber-800">
              Shiprocket isn&apos;t set up yet (SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD). Use “Mark shipped by hand” meanwhile.
            </p>
          ) : null}
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Input
              label="Weight (kg)"
              inputMode="decimal"
              value={pkg.weight_kg}
              onChange={(e) => setPkg({ ...pkg, weight_kg: e.target.value })}
            />
            <Input
              label="Length (cm)"
              inputMode="decimal"
              value={pkg.length_cm}
              onChange={(e) => setPkg({ ...pkg, length_cm: e.target.value })}
            />
            <Input
              label="Breadth (cm)"
              inputMode="decimal"
              value={pkg.breadth_cm}
              onChange={(e) => setPkg({ ...pkg, breadth_cm: e.target.value })}
            />
            <Input
              label="Height (cm)"
              inputMode="decimal"
              value={pkg.height_cm}
              onChange={(e) => setPkg({ ...pkg, height_cm: e.target.value })}
            />
          </div>
          <div className="mt-3 flex gap-2">
            <Button type="submit" size="sm" loading={busy} disabled={!shiprocketReady}>
              Create in Shiprocket
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)} disabled={busy}>
              Not now
            </Button>
          </div>
        </form>
      ) : null}

      {panel === 'amazon' ? (
        <AmazonShipDialog
          base={base}
          initialParcel={pkg}
          ready={amazonReady}
          missing={amazonMissing}
          onBooked={amazonBooked}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {panel === 'amazonCancel' ? (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-charcoal">Cancel this Amazon label? The order goes back to To ship.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              onClick={() => void act(`${base}/amazon/cancel-label`, 'POST', {}, 'Label cancelled — the order is back in To ship.', true)}
            >
              Cancel the Amazon label
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)} disabled={busy}>
              Keep the label
            </Button>
          </div>
        </div>
      ) : null}

      {panel === 'ship' ? (
        <form
          className="mt-3 rounded-md border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              base,
              'PATCH',
              { action: 'mark_shipped', awb_code: awb, courier_name: courier },
              'Marked shipped. The customer has been emailed the tracking link.',
            );
          }}
        >
          <p className="text-sm text-charcoal">
            For a parcel booked in the Shiprocket panel or with any courier. The customer is emailed the tracking link.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Input label="Tracking number (AWB)" value={awb} onChange={(e) => setAwb(e.target.value)} required />
            <Input label="Courier (optional)" value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="e.g. Delhivery" />
          </div>
          <div className="mt-3 flex gap-2">
            <Button type="submit" size="sm" loading={busy}>
              Mark shipped
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)} disabled={busy}>
              Not now
            </Button>
          </div>
        </form>
      ) : null}

      {panel === 'cancel' ? (
        <form
          className="mt-3 rounded-md border border-red-200 bg-red-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void cancelOrder();
          }}
        >
          <p className="text-sm text-charcoal">
            {awaitingLink ? (
              <>The payment link is cancelled too, so the customer can no longer pay it. Nothing was charged, so there is nothing to refund.</>
            ) : refundByHand ? (
              <>
                This cancels the order. It was paid outside the site, so nothing is refunded here: you will need to send{' '}
                <strong>{rupees(order.total_inr)}</strong> back to the customer yourself.
              </>
            ) : (
              <>
                This refunds <strong>{rupees(order.total_inr)}</strong> to the customer through Razorpay and can&apos;t be undone.
              </>
            )}
            {order.status === 'shipped' && amazonOrder
              ? canCancelAmazonLabel(order)
                ? ' The Amazon label will be cancelled too.'
                : ' The parcel is already with the courier — arrange its return with Amazon Shipping.'
              : order.status === 'shipped'
                ? ' The parcel is already with the courier — arrange its return in Shiprocket.'
                : ''}
            {order.status === 'sent_to_shiprocket' ? ' It will be cancelled in Shiprocket too.' : ''}
          </p>
          <div className="mt-3">
            <Input label="Reason (optional, for your records)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </div>
          <div className="mt-3 flex gap-2">
            <Button type="submit" size="sm" variant="danger" loading={busy}>
              {awaitingLink ? 'Cancel the order and the link' : refundByHand ? 'Cancel the order' : `Cancel and refund ${rupees(order.total_inr)}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)} disabled={busy}>
              Keep the order
            </Button>
          </div>
        </form>
      ) : null}

      {message ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={`text-sm font-semibold ${message.tone === 'error' ? 'text-red-700' : message.tone === 'warn' ? 'text-amber-800' : 'text-green-800'}`}
          >
            {message.text}
          </p>
          {settled && labelBooked ? (
            <a href={`${base}/amazon/label`} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: 'sm' })}>
              Print label
            </a>
          ) : null}
          {settled ? (
            <Button size="sm" variant="secondary" onClick={() => router.refresh()}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
