// Pure helpers for the "Ship with Amazon Shipping" dialog on Owner → Shop orders
// (components/owner/shop/AmazonShipDialog.tsx). Client-safe: no server imports.

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
 * TODO: use amazonBookingHeld from lib/shop/status.ts once it lands.
 */
export function isAmazonBookingHeld(
  order: { status: string; amazon_booking_at?: string | null },
  now: number = Date.now(),
): boolean {
  if (order.status !== 'paid' || !order.amazon_booking_at) return false;
  const t = new Date(order.amazon_booking_at).getTime();
  return Number.isFinite(t) && t > now + 60 * 60 * 1000;
}

/** Plain words when Amazon returned no usable service. */
export const NO_AMAZON_SERVICE_MESSAGE = 'Amazon Shipping has no service for this parcel and pincode. Use Send to Shiprocket instead.';

/** The base64 label from /book as a PDF Blob, or null if it is not valid base64. */
export function labelBlobFromBase64(b64: string): Blob | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.length ? new Blob([bytes], { type: 'application/pdf' }) : null;
  } catch {
    return null;
  }
}
