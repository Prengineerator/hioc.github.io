'use client';

// "Ship with Amazon Shipping" panel on one shop order (Owner → Shop orders → To ship).
// 1. The owner checks the parcel and taps Get Amazon prices (books nothing).
// 2. Each service is listed cheapest first with its price and delivery date.
// 3. Book this one books that service on the café's Amazon Shipping account.
// Routes: /api/owner/shop/orders/[id]/amazon/{rates,book}; Book sends only the row's signed quote. Pure helpers (stale
// check, IST dates) are in lib/shop/amazonDialog.ts.

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  formatDeliveryBy,
  isPriceListStale,
  NO_AMAZON_SERVICE_MESSAGE,
  readRatesAnswer,
  type AmazonParcelFields,
  type AmazonRateRow,
} from '@/lib/shop/amazonDialog';
import { rupees } from '@/lib/shop/pricing';

export interface AmazonBookedAnswer {
  order?: { status?: string };
  label?: string;
  warning?: string;
  error?: string;
}

export function AmazonShipDialog({
  base,
  initialParcel,
  ready,
  missing,
  onBooked,
  onClose,
}: {
  /** /api/owner/shop/orders/[id] */
  base: string;
  initialParcel: AmazonParcelFields;
  ready: boolean;
  missing: string[];
  onBooked: (data: AmazonBookedAnswer) => void;
  onClose: () => void;
}) {
  const [pkg, setPkg] = useState<AmazonParcelFields>(initialParcel);
  const [priced, setPriced] = useState<{ parcel: AmazonParcelFields; rates: AmazonRateRow[] } | null>(null);
  const [pricing, setPricing] = useState(false);
  const [booking, setBooking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const busy = pricing || booking !== null;

  function edit(next: AmazonParcelFields) {
    setPkg(next);
    // A price list belongs to the parcel it was asked for.
    if (priced && isPriceListStale(priced.parcel, next)) setPriced(null);
    setError(null);
  }

  async function post(path: string, body: unknown) {
    const res = await fetch(`${base}/amazon/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, data };
  }

  async function getPrices() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPricing(true);
    setError(null);
    setPriced(null);
    try {
      const { res, data } = await post('rates', pkg);
      if (!res.ok) {
        setError(typeof data.error === 'string' && data.error ? data.error : `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      const out = readRatesAnswer(data);
      if (out.rates.length === 0) {
        setError(NO_AMAZON_SERVICE_MESSAGE);
        return;
      }
      setPriced({ parcel: out.parcel ?? pkg, rates: out.rates });
    } catch {
      setError('Network error — please try again.');
    } finally {
      inFlight.current = false;
      setPricing(false);
    }
  }

  async function book(rate: AmazonRateRow) {
    if (inFlight.current || !priced || isPriceListStale(priced.parcel, pkg)) return;
    inFlight.current = true;
    setBooking(rate.rateId);
    setError(null);
    try {
      const { res, data } = await post('book', { quote: rate.quote });
      if (!res.ok) {
        setError(typeof data.error === 'string' && data.error ? data.error : `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      onBooked(data as AmazonBookedAnswer);
    } catch {
      setError('Network error. Check the order before trying again: Amazon may already have booked it.');
    } finally {
      inFlight.current = false;
      setBooking(null);
    }
  }

  const field = (key: keyof AmazonParcelFields, label: string) => (
    <Input label={label} inputMode="decimal" value={pkg[key]} onChange={(e) => edit({ ...pkg, [key]: e.target.value })} disabled={busy} />
  );

  return (
    <div className="mt-3 rounded-md border border-line p-3">
      <p className="text-sm text-charcoal">
        Check the packed parcel. Amazon Shipping charges on the larger of its weight and its size (L × B × H ÷ 5000). Nothing is booked until you pick a price.
      </p>
      {!ready ? (
        <p className="mt-2 text-sm font-semibold text-amber-800">
          {missing.length > 0
            ? `Amazon Shipping isn't set up yet: add ${missing.join(', ')} in Vercel. Use Send to Shiprocket meanwhile.`
            : "Amazon Shipping isn't set up yet: apply the Amazon Shipping database file first. Use Send to Shiprocket meanwhile."}
        </p>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {field('weight_kg', 'Weight (kg)')}
        {field('length_cm', 'Length (cm)')}
        {field('breadth_cm', 'Breadth (cm)')}
        {field('height_cm', 'Height (cm)')}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" loading={pricing} disabled={!ready || busy} onClick={() => void getPrices()}>
          Get Amazon prices
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Not now
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}

      {priced ? (
        <ul className="mt-3 space-y-2" aria-label="Amazon Shipping prices">
          {priced.rates.map((r) => (
            <li key={r.rateId} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-charcoal">{r.serviceName}</p>
                <p className="text-sm text-charcoal">
                  <span className="font-mono font-semibold tabular-nums">{rupees(r.chargeInr)}</span>
                  <span className="text-muted"> · {formatDeliveryBy(r.deliveryBy)}</span>
                </p>
              </div>
              <Button size="sm" loading={booking === r.rateId} disabled={busy} onClick={() => void book(r)}>
                Book this one
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
