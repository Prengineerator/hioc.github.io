// Shared shaping helpers for the order API responses
// (GET /api/orders, GET /api/orders/[id], POST /api/orders).

import type { Order, OrderItem, OrderItemAddon, PaymentMethod } from '@/lib/types';

// Raw row shape returned by a Supabase `orders` query embedding
// `order_items`, each of which embeds `order_item_addons`, e.g.
// `.select('*, order_items(*, order_item_addons(*))')`.
export type OrderRowWithItems = Order & {
  order_items: (OrderItem & { order_item_addons: OrderItemAddon[] | null })[] | null;
  /** Present when the query embeds `order_payments(method, amount_inr, created_at)`. */
  order_payments?: { method: PaymentMethod; amount_inr: number; created_at?: string }[] | null;
};

/** The embed that gives an order its split-payment parts (toOrderResponse → `payments`). */
export const ORDER_PAYMENTS_EMBED = 'order_payments(method, amount_inr, created_at)';

export type OrderItemResponse = Omit<OrderItem, 'order_id'>;
export type OrderResponse = Order & { items: OrderItemResponse[] };

/**
 * Shapes a raw Supabase `orders` row (with its embedded `order_items`, each
 * with its embedded `order_item_addons`) into the `{ order }` response
 * contract: renames `order_items` to `items`, `order_item_addons` to
 * `addons`, and drops the redundant `order_id`/`order_item_id` foreign keys.
 */
export function toOrderResponse(row: OrderRowWithItems): OrderResponse {
  const { order_items, order_payments, ...order } = row;
  const items: OrderItemResponse[] = (order_items ?? []).map((item) => {
    const { order_id, order_item_addons, ...rest } = item;
    return { ...rest, addons: order_item_addons ?? [] };
  });

  if (order_payments === undefined) return { ...order, items };
  const payments = [...(order_payments ?? [])]
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    .map((p) => ({ method: p.method, amount_inr: p.amount_inr }));
  return { ...order, items, payments };
}
