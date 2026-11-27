// Owner → Shop orders: the last-30-days numbers for each product line
// (docs/SHOP-V2-SPEC.md E6). Pure, so it is tested without a database.
//
// Rules:
//   - Only paid statuses count (paid, sent_to_shiprocket, shipped, delivered).
//     Unpaid, expired and cancelled orders are left out entirely.
//   - Units are the quantities on the lines. A partial refund does not take
//     units back (we can't know which units), but it does come off revenue.
//   - Revenue is the order's GOODS after discounts, shipping excluded:
//         goods = total_inr - shipping_inr - refunded_inr   (never below 0)
//     shared between the order's lines in proportion to line_total_inr, by the
//     largest-remainder method so the shares are whole rupees that add up to
//     exactly `goods`. (Without shipping_inr in the row, shipping counts as 0.)
//   - A line frozen by a v1 checkout has no `line`; it counts as instant coffee.
//   - An order refunded in full without being cancelled counts for nothing.

import { lineOf } from './catalog';
import { PAID_STATUSES } from './status';
import type { ShopLine, ShopOrderStatus, ShopProductLine } from './types';

export interface StatsOrder {
  status: ShopOrderStatus;
  lines: ShopLine[];
  total_inr: number;
  shipping_inr?: number | null;
  refunded_inr: number | null;
}

export interface LineStat {
  units: number;
  revenue_inr: number;
}

export type ShopLineStats = Record<ShopProductLine, LineStat> & {
  total: { orders: number; units: number; revenue_inr: number };
};

/** Splits `amount` whole rupees across `weights`, in proportion, summing to exactly `amount`. */
export function allocateProportionally(amount: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const total = weights.reduce((a, b) => a + b, 0);
  const w = total > 0 ? weights : weights.map(() => 1);
  const sum = total > 0 ? total : n;
  const exact = w.map((x) => (amount * x) / sum);
  const shares = exact.map(Math.floor);
  let left = amount - shares.reduce((a, b) => a + b, 0);
  const byRemainder = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < byRemainder.length; k++, left--) shares[byRemainder[k].i] += 1;
  return shares;
}

export function shopLineStats(orders: readonly StatsOrder[]): ShopLineStats {
  const out: ShopLineStats = {
    instant: { units: 0, revenue_inr: 0 },
    home_blend: { units: 0, revenue_inr: 0 },
    total: { orders: 0, units: 0, revenue_inr: 0 },
  };
  for (const o of orders) {
    if (!PAID_STATUSES.includes(o.status)) continue;
    const total = Number(o.total_inr) || 0;
    const refunded = Number(o.refunded_inr) || 0;
    if (total > 0 && refunded >= total) continue;
    const goods = Math.max(0, total - (Number(o.shipping_inr) || 0) - refunded);
    const shares = allocateProportionally(
      goods,
      o.lines.map((l) => Math.max(0, Number(l.line_total_inr) || 0)),
    );
    o.lines.forEach((l, i) => {
      const bucket = out[lineOf(l)];
      const qty = Math.max(0, Number(l.quantity) || 0);
      bucket.units += qty;
      bucket.revenue_inr += shares[i];
      out.total.units += qty;
      out.total.revenue_inr += shares[i];
    });
    out.total.orders += 1;
  }
  return out;
}
