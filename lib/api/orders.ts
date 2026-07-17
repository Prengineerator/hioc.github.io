// Shared shaping helpers for the order API responses
// (GET /api/orders, GET /api/orders/[id], POST /api/orders).

import type { Order, OrderItem, OrderItemAddon } from '@/lib/types';

// Raw row shape returned by a Supabase `orders` query embedding
// `order_items`, each of which embeds `order_item_addons`, e.g.
// `.select('*, order_items(*, order_item_addons(*))')`.
export type OrderRowWithItems = Order & {
  order_items: (OrderItem & { order_item_addons: OrderItemAddon[] | null })[] | null;
};

export type OrderItemResponse = Omit<OrderItem, 'order_id'>;
export type OrderResponse = Order & { items: OrderItemResponse[] };

/**
 * Shapes a raw Supabase `orders` row (with its embedded `order_items`, each
 * with its embedded `order_item_addons`) into the `{ order }` response
 * contract: renames `order_items` to `items`, `order_item_addons` to
 * `addons`, and drops the redundant `order_id`/`order_item_id` foreign keys.
 */
export function toOrderResponse(row: OrderRowWithItems): OrderResponse {
  const { order_items, ...order } = row;
  const items: OrderItemResponse[] = (order_items ?? []).map((item) => {
    const { order_id, order_item_addons, ...rest } = item;
    return { ...rest, addons: order_item_addons ?? [] };
  });

  return { ...order, items };
}
