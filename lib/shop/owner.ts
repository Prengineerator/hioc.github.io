// Owner-side helpers for /owner/shop that don't touch the database. Pure.
// Shipped-by-hand and cancel inputs, the Products card edits (docs/SHOP-V2-SPEC.md
// E1), the shop settings edits (E2, E5) and the accountant's CSV (E6).

import type { CsvTable } from '@/lib/reports/csv';
import { grindLabel, lineOf, PLACEHOLDER_PRICE_INR } from './catalog';
import { googleMapsLink, locationFromRow } from './location';
import { normalizeOfferTiers } from './pricing';
import { OWNER_STATUS_LABEL, orderCarrier, shopOrderRef } from './status';
import type { ShopOrderRow } from './types';

const AWB_RE = /^[A-Za-z0-9-]{4,40}$/;

export type ShippedInput = { ok: true; awb_code: string; courier_name: string | null } | { ok: false; error: string };

/** "Mark shipped" by hand: the AWB (tracking number) is required, the courier optional. */
export function parseShippedInput(body: Record<string, unknown>): ShippedInput {
  const awb = typeof body.awb_code === 'string' ? body.awb_code.replace(/\s+/g, '') : '';
  if (!AWB_RE.test(awb)) return { ok: false, error: 'Enter the tracking number (AWB): 4–40 letters or digits' };
  const courierRaw = typeof body.courier_name === 'string' ? body.courier_name.replace(/\s+/g, ' ').trim() : '';
  if (courierRaw.length > 60) return { ok: false, error: 'Courier name is too long (60 characters at most)' };
  return { ok: true, awb_code: awb, courier_name: courierRaw || null };
}

/** The owner's cancel reason: optional, one line, at most 200 characters. */
export function parseCancelReason(raw: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, reason: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'reason must be text' };
  const reason = raw.replace(/\s+/g, ' ').trim();
  if (reason.length > 200) return { ok: false, error: 'Reason is too long (200 characters at most)' };
  return { ok: true, reason };
}

// ---------------------------------------------------------------------------
// Products card (E1): one PATCH may change any of these on one product.
// Price changes never touch existing orders: their lines are frozen at checkout.
// ---------------------------------------------------------------------------

export type ProductPatch = Partial<{
  price_inr: number;
  listed: boolean;
  in_stock: boolean;
  ship_weight_kg: number;
  description: string;
}>;

/** A product still at the seed price can't be listed on the shop. */
export function canListProduct(priceInr: number): boolean {
  return Number.isFinite(priceInr) && priceInr > PLACEHOLDER_PRICE_INR;
}

/**
 * The listing guard for a product PATCH, as one pure decision. The product ends
 * up listed when the patch says so, or when it is already listed and the patch
 * says nothing about it; it may only end up listed at a real price (the patch's
 * price if it sets one, else the stored one). So { price_inr: 1 } on a listed
 * product is refused too, not just { listed: true }. Returns the 400 message,
 * or null when the patch is fine.
 */
export const LIST_PRICE_ERROR = 'Set a real price before listing this product';

export function productPatchListingError(
  patch: Pick<ProductPatch, 'price_inr' | 'listed'>,
  current: { price_inr: unknown; listed: unknown },
): string | null {
  const willBeListed = patch.listed ?? current.listed === true;
  if (!willBeListed) return null;
  const price = patch.price_inr ?? Number(current.price_inr);
  return canListProduct(price) ? null : LIST_PRICE_ERROR;
}

/** True when the patch needs a v2 column (anything but the v1 in-stock toggle). */
export function productPatchNeedsV2(patch: ProductPatch): boolean {
  return Object.keys(patch).some((k) => k !== 'in_stock');
}

export function parseProductPatch(body: Record<string, unknown>): { ok: true; patch: ProductPatch } | { ok: false; error: string } {
  const patch: ProductPatch = {};
  if (body.price_inr !== undefined) {
    const p = body.price_inr;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 100000) {
      return { ok: false, error: 'Price must be whole rupees, ₹1 to ₹1,00,000' };
    }
    patch.price_inr = p;
  }
  for (const key of ['listed', 'in_stock'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return { ok: false, error: `${key} must be true or false` };
    patch[key] = body[key] as boolean;
  }
  if (body.ship_weight_kg !== undefined) {
    const w = body.ship_weight_kg;
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0.05 || w > 10) {
      return { ok: false, error: 'Packed weight must be between 0.05 and 10 kg' };
    }
    patch.ship_weight_kg = Math.round(w * 1000) / 1000;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return { ok: false, error: 'Description must be text' };
    const d = body.description.replace(/\s+/g, ' ').trim();
    if (d.length > 160) return { ok: false, error: 'Description is too long (160 characters at most)' };
    patch.description = d;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to change' };
  return { ok: true, patch };
}

// ---------------------------------------------------------------------------
// Shop settings (E2, E5): the online offer, shipping and the Beanies cap.
// ---------------------------------------------------------------------------

export type ShopSettingsPatch = Partial<{
  offer_active: boolean;
  offer_name: string;
  offer_tier_prices: number[];
  shipping_fee_inr: number;
  free_shipping_min_inr: number;
  beanies_max_redeem_pct: number;
}>;

export function parseShopSettingsPatch(body: Record<string, unknown>): { ok: true; patch: ShopSettingsPatch } | { ok: false; error: string } {
  const patch: ShopSettingsPatch = {};
  if (body.offer_active !== undefined) {
    if (typeof body.offer_active !== 'boolean') return { ok: false, error: 'offer_active must be true or false' };
    patch.offer_active = body.offer_active;
  }
  if (body.offer_name !== undefined) {
    const name = typeof body.offer_name === 'string' ? body.offer_name.replace(/\s+/g, ' ').trim() : '';
    if (name.length < 1 || name.length > 40) return { ok: false, error: 'Offer name must be 1–40 characters' };
    patch.offer_name = name;
  }
  if (body.offer_tier_prices !== undefined) {
    const tiers = normalizeOfferTiers(body.offer_tier_prices);
    if (!tiers) {
      return { ok: false, error: 'Prices must be whole rupees for 2 to 6 jar counts, each more than the one before (e.g. 399, 599, 749).' };
    }
    patch.offer_tier_prices = tiers;
  }
  const ints: [keyof ShopSettingsPatch, number, number, string][] = [
    ['shipping_fee_inr', 0, 500, 'Shipping fee must be whole rupees, ₹0 to ₹500'],
    ['free_shipping_min_inr', 0, 100000, 'Free-shipping minimum must be whole rupees, ₹0 to ₹1,00,000'],
    ['beanies_max_redeem_pct', 0, 50, 'Beanies limit must be a whole percent, 0 to 50'],
  ];
  for (const [key, min, max, error] of ints) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return { ok: false, error };
    (patch as Record<string, number>)[key] = v;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to change' };
  return { ok: true, patch };
}

function istDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 330 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const PAYMENT_CHANNEL_LABEL: Record<string, string> = {
  checkout: 'Razorpay checkout',
  payment_link: 'Razorpay payment link',
  offline: 'Offline',
};
const OFFLINE_METHOD_LABEL: Record<string, string> = {
  upi_direct: 'UPI to café',
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
};

const CARRIER_LABEL: Record<string, string> = { shiprocket: 'Shiprocket', amazon: 'Amazon Shipping' };

/** The shop orders as a sheet for the accountant (GET /api/owner/shop/orders/export). */
export function shopOrdersCsvTable(orders: readonly ShopOrderRow[]): CsvTable {
  return {
    columns: [
      'Order',
      'Paid at (IST)',
      'Status',
      'Customer',
      'Phone',
      'Email',
      'Address',
      'City',
      'State',
      'Pincode',
      'Map pin',
      'Items',
      'Channel',
      'Line(s)',
      'Grind(s)',
      'Units',
      'Goods (₹)',
      'Offer',
      'Total discount (₹)',
      'Offer (₹)',
      'Coupon code',
      'Coupon (₹)',
      'Beanies used',
      'Beanies (₹)',
      'Intro offer reused',
      'Shipping (₹)',
      'Total paid (₹)',
      'Refunded (₹)',
      'Payment method',
      'Razorpay payment id',
      'Shiprocket order id',
      'AWB',
      'Courier',
      'Carrier',
      'Amazon label (₹)',
      'Source',
      'Payment channel',
      'Offline method',
      'Payment reference',
      'Owner discount (₹)',
      'Owner discount reason',
    ],
    rows: orders.map((o) => [
      shopOrderRef(o.order_number),
      istDateTime(o.paid_at ?? o.created_at),
      OWNER_STATUS_LABEL[o.status] ?? o.status,
      o.customer_name,
      o.phone,
      o.email,
      [o.address_line1, o.address_line2].filter(Boolean).join(', '),
      o.city,
      o.state,
      o.pincode,
      (() => {
        const pin = locationFromRow(o);
        return pin ? googleMapsLink(pin) : '';
      })(),
      o.lines.map((l) => `${l.name}${l.grind ? ` (${l.grind_label ?? grindLabel(l.grind)})` : ''} × ${l.quantity}`).join('; '),
      'Shop',
      [...new Set(o.lines.map((l) => (lineOf(l) === 'home_blend' ? 'Home Blend' : 'Instant')))].join('; '),
      [...new Set(o.lines.flatMap((l) => (l.grind ? [l.grind_label ?? grindLabel(l.grind)] : [])))].join('; '),
      o.jar_count,
      o.subtotal_inr,
      o.offer_name ?? '',
      o.discount_inr,
      // Legacy v1 rows have only discount_inr (it was the offer).
      o.offer_discount_inr || o.coupon_discount_inr || o.beanies_discount_inr ? o.offer_discount_inr : o.discount_inr,
      o.coupon_code ?? '',
      o.coupon_discount_inr || 0,
      o.beanies_redeemed || 0,
      o.beanies_discount_inr || 0,
      o.intro_offer_reused ? 'Yes' : '',
      o.shipping_inr,
      o.total_inr,
      o.refunded_inr ?? '',
      o.payment_method ?? '',
      o.razorpay_payment_id ?? '',
      o.shiprocket_order_id ?? '',
      o.awb_code ?? '',
      o.courier_name ?? '',
      CARRIER_LABEL[orderCarrier(o) ?? ''] ?? '',
      o.amazon_charge_inr ?? '',
      o.source === 'owner' ? 'owner' : 'website',
      PAYMENT_CHANNEL_LABEL[o.payment_channel] ?? 'Razorpay checkout',
      o.offline_method ? OFFLINE_METHOD_LABEL[o.offline_method] ?? o.offline_method : '',
      o.payment_reference ?? '',
      o.owner_discount_inr || 0,
      o.owner_discount_reason ?? '',
    ]),
  };
}
