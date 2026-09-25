// Shared shaping for GET /api/customers/orders (the POS "Last orders" list) —
// the counter-staff sibling of lib/api/orders.ts's toOrderResponse, over a
// narrower set of columns. Kept out of the route so the frontend (the "Last
// orders" modal + the repeat-order mapper) can import the response type
// without pulling in the route's Supabase/auth imports.

import type { Order, OrderItem, OrderItemAddon } from '@/lib/types';

/** Raw row shape for `.select(CUSTOMER_ORDERS_SELECT)` — only the columns the
 * POS card/modal actually renders, plus the full item/addon tree (needed to
 * both display and Repeat a line). */
export type CustomerOrderRow = Pick<
  Order,
  | 'id'
  | 'order_number'
  | 'order_type'
  | 'status'
  | 'payment_status'
  | 'total_inr'
  | 'subtotal_inr'
  | 'created_at'
  | 'table_label'
> & {
  order_items: (OrderItem & { order_item_addons: OrderItemAddon[] | null })[] | null;
};

export type CustomerOrderItemResponse = Omit<OrderItem, 'order_id'>;
export type CustomerOrderResponse = Omit<CustomerOrderRow, 'order_items'> & {
  items: CustomerOrderItemResponse[];
};

/** `order_items` → `items`, `order_item_addons` → `addons` — same rename
 * `toOrderResponse` does, over the smaller column set above. */
export function toCustomerOrderResponse(row: CustomerOrderRow): CustomerOrderResponse {
  const { order_items, ...order } = row;
  const items: CustomerOrderItemResponse[] = (order_items ?? []).map((item) => {
    const { order_id, order_item_addons, ...rest } = item;
    return { ...rest, addons: order_item_addons ?? [] };
  });
  return { ...order, items };
}
