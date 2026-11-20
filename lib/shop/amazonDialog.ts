// Pure helpers for the "Ship with Amazon Shipping" dialog on Owner → Shop orders
// (components/owner/shop/AmazonShipDialog.tsx). Client-safe: no server imports.
import { amazonBookingHeld } from './status';

export interface AmazonParcelFields {
  weight_kg: string;
  length_cm: string;
  breadth_cm: string;
  height_cm: string;
}

export interface AmazonRateRow {
  rateId: string;
  serviceName: string;
  carrierName?: string;
  chargeInr: number;
  deliveryBy: string | null;
  /** Opaque signed value from the server; Book sends only this. Never shown. */
  quote: string;
}

const PARCEL_KEYS = ['weight_kg', 'length_cm', 'breadth_cm', 'height_cm'] as const;

/** True when the parcel on screen is not the one the price list was worked out for. */
export function isPriceListStale(priced: AmazonParcelFields | null, current: AmazonParcelFields): boolean {
  if (!priced) return true;
  return PARCEL_KEYS.some((k) => priced[k].trim() !== current[k].trim());
}

/** "by Mon 24 Nov" in IST, or "delivery date not given". */
export function formatDeliveryBy(iso: string | null | undefined): string {
  if (!iso) return 'delivery date not given';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'delivery date not given';
  const parts = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `by ${get('weekday')} ${get('day')} ${get('month')}`;
}

/** Reads the rates answer defensively; rows without an id or a price are dropped. */
export function readRatesAnswer(data: unknown): {
  rates: AmazonRateRow[];
  parcel: AmazonParcelFields | null;
} {
  const r = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const rates = (Array.isArray(r.rates) ? r.rates : []).flatMap((x): AmazonRateRow[] => {
    const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    if (typeof o.rateId !== 'string' || typeof o.quote !== 'string' || !o.quote || typeof o.chargeInr !== 'number' || !Number.isFinite(o.chargeInr)) return [];
    return [
      {
        rateId: o.rateId,
        quote: o.quote,
        serviceName: typeof o.serviceName === 'string' && o.serviceName ? o.serviceName : 'Amazon Shipping',
        carrierName: typeof o.carrierName === 'string' ? o.carrierName : undefined,
        chargeInr: o.chargeInr,
        deliveryBy: typeof o.deliveryBy === 'string' ? o.deliveryBy : null,
      },
    ];
  });
  const p = (typeof r.parcel === 'object' && r.parcel !== null ? r.parcel : null) as Record<string, unknown> | null;
  const parcel = p ? ({ weight_kg: String(p.weight_kg ?? ''), length_cm: String(p.length_cm ?? ''), breadth_cm: String(p.breadth_cm ?? ''), height_cm: String(p.height_cm ?? '') } as AmazonParcelFields) : null;
  return { rates: [...rates].sort((a, b) => a.chargeInr - b.chargeInr), parcel };
}

/**
 * An earlier booking may have gone through and the server is holding the order
 * (amazon_booking_at set far in the future). A normal claim lasts minutes.
 * Same rule as the server (amazonBookingHeld in lib/shop/status.ts), for a paid order.
 */
export function isAmazonBookingHeld(order: { status: string; amazon_booking_at?: string | null }): boolean {
  return order.status === 'paid' && amazonBookingHeld(order);
}

/** Plain words when Amazon returned no usable service. */
export const NO_AMAZON_SERVICE_MESSAGE = 'Amazon Shipping has no service for this parcel and pincode. Use Send to Shiprocket instead.';

/** The base64 label from /book as a PDF Blob, or null if it is not valid base64. */
export function labelBlobFromBase64(b64: string): Blob | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Only a real PDF is opened; anything else falls back to the Print label link.
    const isPdf = bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
    return isPdf ? new Blob([bytes], { type: 'application/pdf' }) : null;
  } catch {
    return null;
  }
}

export const BOOKING_UNCLEAR_MESSAGE = 'Amazon may have booked this — check Amazon Shipping before booking again.';

/**
 * What to tell the owner when Book did not come back as a success. `data` is the
 * parsed body, or null when it could not be read. A message from our own routes
 * is shown as it is; a gateway timeout, a network failure (status 0) or an
 * unreadable body means we cannot tell whether Amazon booked, so say so.
 */
export function bookFailure(status: number, data: unknown): { message: string; unclear: boolean } {
  const err = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).error : undefined;
  if (typeof err === 'string' && err.trim() && status !== 504) return { message: err, unclear: false };
  if (status === 0 || status === 504 || data === null || status === 502 || status === 503) {
    return { message: BOOKING_UNCLEAR_MESSAGE, unclear: true };
  }
  return { message: `Something went wrong (HTTP ${status}).`, unclear: false };
}
