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

/** A hioc order, shaped for the "Last orders" list. `source: 'hioc'`
 * distinguishes it from a `LegacyCustomerOrderResponse` below — every field
 * that existed here before the Petpooja import stays exactly as it was. */
export type HiocCustomerOrderResponse = Omit<CustomerOrderRow, 'order_items'> & {
  source: 'hioc';
  items: CustomerOrderItemResponse[];
};

/**
 * One item on an imported Petpooja bill (legacy_order_items — see
 * supabase/2026-09-petpooja-history.sql and lib/legacy/history.ts). Reuses
 * the same `name_snapshot`/`variant_label_snapshot` field names a hioc item
 * uses so the "Last orders" card can render either without a translation
 * layer, but that's where the similarity ends: Petpooja's export never
 * recorded a per-item quantity or price (`quantity` is always null — see the
 * shared import spec), and it has no concept of add-ons.
 */
export interface LegacyOrderItemResponse {
  name_snapshot: string;
  variant_label_snapshot: string;
  menu_item_id: string | null;
  variant_id: string | null;
  quantity: null;
}

/**
 * One imported Petpooja bill, shaped to slot into the SAME "Last orders" list
 * as a hioc order. `bill_no` stands in for `order_number` (Petpooja's own,
 * text, bill numbering — see legacy_orders.bill_no); `created_at` is the
 * bill's `ordered_at`. There is deliberately no `status`/`payment_status`/
 * `table_label`/`order_type` here — those are hioc order-lifecycle concepts
 * that a historical Petpooja bill was never entered into this app's pipeline
 * to have.
 */
export interface LegacyCustomerOrderResponse {
  source: 'petpooja';
  id: string;
  bill_no: string;
  created_at: string;
  total_inr: number;
  items: LegacyOrderItemResponse[];
}

/** What GET /api/customers/orders actually returns, newest first: either
 * source, told apart by `source`. */
export type CustomerOrderResponse = HiocCustomerOrderResponse | LegacyCustomerOrderResponse;

/** `order_items` → `items`, `order_item_addons` → `addons` — same rename
 * `toOrderResponse` does, over the smaller column set above. */
export function toCustomerOrderResponse(row: CustomerOrderRow): HiocCustomerOrderResponse {
  const { order_items, ...order } = row;
  const items: CustomerOrderItemResponse[] = (order_items ?? []).map((item) => {
    const { order_id, order_item_addons, ...rest } = item;
    return { ...rest, addons: order_item_addons ?? [] };
  });
  return { ...order, source: 'hioc', items };
}
