'use client';

// One order on Owner → Shop orders, with what can be done to it next:
//   To ship         Send to Shiprocket (the one click, after checking the
//                   parcel's weight and size) · Mark shipped by hand · Cancel
//   In Shiprocket   Refresh from Shiprocket · Mark shipped by hand · Cancel
//   Shipped         Refresh · Mark delivered · Cancel & refund
//   Delivered       Cancel & refund (e.g. arrived damaged)
// Every action calls an /api/owner/shop route and refreshes the server page.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { defaultPackage } from '@/lib/shop/catalog';
import { describePin, googleMapsLink, locationFromRow } from '@/lib/shop/location';
import { jarsLabel, rupees } from '@/lib/shop/pricing';
import {
  canCancel,
  canMarkDelivered,
  canMarkShipped,
  canRefreshFromShiprocket,
  canSendToShiprocket,
  OWNER_STATUS_LABEL,
  shopOrderRef,
  shopRefundState,
  trackingUrl,
} from '@/lib/shop/status';
import type { ShopOrderRow, ShopOrderStatus } from '@/lib/shop/types';

type Panel = 'send' | 'ship' | 'cancel' | null;

const STATUS_TONE: Record<ShopOrderStatus, string> = {
  payment_pending: 'border-line text-muted',
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
  return [o.customer_name, o.address_line1, o.address_line2, `${o.city}, ${o.state} ${o.pincode}`, o.phone, pin ? `Map pin: ${googleMapsLink(pin)}` : null]
    .filter(Boolean)
    .join('\n');
}

export function ShopOrderCard({ order, shiprocketReady }: { order: ShopOrderRow; shiprocketReady: boolean }) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const pkg0 = defaultPackage(order.jar_count);
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
  const tracking = trackingUrl(order.awb_code);
  const pin = locationFromRow(order);

  async function act(path: string, method: 'POST' | 'PATCH', body: unknown, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) {
        setMessage({ tone: 'error', text: data.error ?? `Something went wrong (HTTP ${res.status}).` });
        return;
      }
      setPanel(null);
      setMessage(data.warning ? { tone: 'warn', text: data.warning } : { tone: 'ok', text: done });
      router.refresh();
    } catch {
      setMessage({ tone: 'error', text: 'Network error — please try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(addressText(order));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage({ tone: 'error', text: 'Could not copy — select the address and copy it by hand.' });
    }
  }

  const base = `/api/owner/shop/orders/${order.id}`;
  const refund = shopRefundState(order);

  return (
    <li className="rounded-md border border-line bg-cream p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-sm font-semibold tabular-nums text-charcoal">{ref}</p>
          <p className="text-xs text-muted">
            {order.paid_at ? `Paid ${when(order.paid_at)}` : `Started ${when(order.created_at)}`}
            {order.payment_method ? ` · ${order.payment_method.toUpperCase()}` : ''}
          </p>
        </div>
        <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-bold ${STATUS_TONE[order.status]}`}>
          {OWNER_STATUS_LABEL[order.status]}
        </span>
      </div>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{jarsLabel(order.jar_count)}</p>
          <ul className="mt-1 text-sm text-charcoal">
            {order.lines.map((l) => (
              <li key={l.product_id}>
                {l.name} × <strong>{l.quantity}</strong>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-charcoal">
            <span className="font-mono font-semibold tabular-nums">{rupees(order.total_inr)}</span>
            <span className="text-muted">
              {' '}
              ({[order.discount_inr > 0 ? `${order.offer_name ?? 'offer'} −${rupees(order.discount_inr)}` : null, order.shipping_inr ? `incl. ${rupees(order.shipping_inr)} shipping` : 'free shipping']
                .filter(Boolean)
                .join(' · ')})
            </span>
          </p>
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

      {order.shiprocket_order_id || order.awb_code ? (
        <div className="mt-3 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
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
              {order.courier_name ? `${order.courier_name} · ` : ''}AWB <span className="font-mono tabular-nums">{order.awb_code}</span>
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
        </div>
      ) : null}

      {order.status === 'cancelled' ? (
        <p className="mt-3 text-sm text-charcoal">
          Cancelled {when(order.cancelled_at)}
          {order.refunded_inr ? ` · refunded ${rupees(order.refunded_inr)}` : ''}
          {refund === 'done' ? <span className="text-muted"> ({order.refund_id})</span> : null}
          {order.cancel_reason ? <span className="block text-muted">“{order.cancel_reason}”</span> : null}
        </p>
      ) : null}
      {refund === 'in_flight' && order.status !== 'cancelled' ? (
        <p className="mt-3 text-sm font-semibold text-amber-800">A refund is under way — reload in a minute.</p>
      ) : null}
      {refund === 'unconfirmed' && order.status !== 'cancelled' ? (
        <p className="mt-3 text-sm font-semibold text-amber-800">
          A refund was started but not confirmed. Press Cancel &amp; refund to finish it: Razorpay is asked first, so the
          customer is never refunded twice.
        </p>
      ) : null}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-2">
        {canSendToShiprocket(order) ? (
          <Button size="sm" onClick={() => setPanel(panel === 'send' ? null : 'send')} disabled={busy}>
            Send to Shiprocket
          </Button>
        ) : null}
        {canRefreshFromShiprocket(order) ? (
          <Button size="sm" variant="secondary" loading={busy && panel === null} onClick={() => void act(`${base}/refresh`, 'POST', {}, 'Updated from Shiprocket.')} disabled={busy}>
            Refresh from Shiprocket
          </Button>
        ) : null}
        {canMarkShipped(order) ? (
          <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'ship' ? null : 'ship')} disabled={busy}>
            Mark shipped by hand
          </Button>
        ) : null}
        {canMarkDelivered(order) ? (
          <Button size="sm" variant="ghost" onClick={() => void act(base, 'PATCH', { action: 'mark_delivered' }, 'Marked delivered.')} disabled={busy}>
            Mark delivered
          </Button>
        ) : null}
        {canCancel(order) ? (
          <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')} disabled={busy}>
            Cancel &amp; refund
          </Button>
        ) : null}
      </div>

      {panel === 'send' ? (
        <form
          className="mt-3 rounded-md border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(`${base}/shiprocket`, 'POST', pkg, 'Sent to Shiprocket. Pick the courier and print the label in the Shiprocket panel, then press Refresh.');
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
            <Input label="Weight (kg)" inputMode="decimal" value={pkg.weight_kg} onChange={(e) => setPkg({ ...pkg, weight_kg: e.target.value })} />
            <Input label="Length (cm)" inputMode="decimal" value={pkg.length_cm} onChange={(e) => setPkg({ ...pkg, length_cm: e.target.value })} />
            <Input label="Breadth (cm)" inputMode="decimal" value={pkg.breadth_cm} onChange={(e) => setPkg({ ...pkg, breadth_cm: e.target.value })} />
            <Input label="Height (cm)" inputMode="decimal" value={pkg.height_cm} onChange={(e) => setPkg({ ...pkg, height_cm: e.target.value })} />
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

      {panel === 'ship' ? (
        <form
          className="mt-3 rounded-md border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(base, 'PATCH', { action: 'mark_shipped', awb_code: awb, courier_name: courier }, 'Marked shipped. The customer has been emailed the tracking link.');
          }}
        >
          <p className="text-sm text-charcoal">For a parcel booked in the Shiprocket panel or with any courier. The customer is emailed the tracking link.</p>
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
            void act(`${base}/cancel`, 'POST', { reason }, `Cancelled and refunded ${rupees(order.total_inr)}.`);
          }}
        >
          <p className="text-sm text-charcoal">
            This refunds <strong>{rupees(order.total_inr)}</strong> to the customer through Razorpay and can&apos;t be undone.
            {order.status === 'shipped' ? ' The parcel is already with the courier — arrange its return in Shiprocket.' : ''}
            {order.status === 'sent_to_shiprocket' ? ' It will be cancelled in Shiprocket too.' : ''}
          </p>
          <div className="mt-3">
            <Input label="Reason (optional, for your records)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </div>
          <div className="mt-3 flex gap-2">
            <Button type="submit" size="sm" variant="danger" loading={busy}>
              Cancel and refund {rupees(order.total_inr)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)} disabled={busy}>
              Keep the order
            </Button>
          </div>
        </form>
      ) : null}

      {message ? (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`mt-3 text-sm font-semibold ${message.tone === 'error' ? 'text-red-700' : message.tone === 'warn' ? 'text-amber-800' : 'text-green-800'}`}
        >
          {message.text}
        </p>
      ) : null}
    </li>
  );
}
