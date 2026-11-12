// Owner-side helpers for /owner/shop that don't touch the database. Pure.

import type { CsvTable } from '@/lib/reports/csv';
import { OWNER_STATUS_LABEL, shopOrderRef } from './status';
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

function istDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 330 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

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
      'Items',
      'Jars',
      'Jars (₹)',
      'Shipping (₹)',
      'Total paid (₹)',
      'Refunded (₹)',
      'Payment method',
      'Razorpay payment id',
      'Shiprocket order id',
      'AWB',
      'Courier',
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
      o.lines.map((l) => `${l.name} × ${l.quantity}`).join('; '),
      o.jar_count,
      o.subtotal_inr,
      o.shipping_inr,
      o.total_inr,
      o.refunded_inr ?? '',
      o.payment_method ?? '',
      o.razorpay_payment_id ?? '',
      o.shiprocket_order_id ?? '',
      o.awb_code ?? '',
      o.courier_name ?? '',
    ]),
  };
}
