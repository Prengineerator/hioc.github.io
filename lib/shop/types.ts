// Instant Coffee shop types (docs/INSTANT-COFFEE-SHOP.md). Safe to import from
// both server and client code: no server-only imports here.

export type ShopOrderStatus =
  | 'payment_pending'
  | 'paid'
  | 'sent_to_shiprocket'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

/** A flavour as the shop sells it (a shop_products row). */
export interface ShopProduct {
  id: string;
  name: string;
  sku: string;
  price_inr: number;
  net_qty: string;
  in_stock: boolean;
  sort_order: number;
}

/** One priced line of an order, frozen on shop_orders.lines at checkout. */
export interface ShopLine {
  product_id: string;
  name: string;
  sku: string;
  unit_price_inr: number;
  quantity: number;
  line_total_inr: number;
}

/** The delivery address and contact, validated (lib/shop/address.ts). */
export interface ShopAddress {
  customer_name: string;
  /** +91XXXXXXXXXX */
  phone: string;
  email: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  pincode: string;
}

/** A shop_orders row as the server reads it. */
export interface ShopOrderRow extends ShopAddress {
  id: string;
  order_number: number;
  status: ShopOrderStatus;
  lines: ShopLine[];
  jar_count: number;
  subtotal_inr: number;
  shipping_inr: number;
  total_inr: number;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  payment_method: string | null;
  paid_at: string | null;
  shiprocket_order_id: string | null;
  shiprocket_shipment_id: string | null;
  shiprocket_status: string | null;
  shiprocket_sending_at: string | null;
  awb_code: string | null;
  courier_name: string | null;
  package_weight_kg: number | string | null;
  package_dims_cm: string | null;
  sent_to_shiprocket_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  refund_id: string | null;
  refunded_inr: number | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What the customer's order page shows (GET /api/shop/orders/[id]). The id in
 * the URL is the only key, so this leaves out the street address, phone and
 * email: someone handed the link sees the parcel, not the person.
 */
export interface ShopOrderPublicView {
  id: string;
  order_number: number;
  status: ShopOrderStatus;
  lines: ShopLine[];
  jar_count: number;
  subtotal_inr: number;
  shipping_inr: number;
  total_inr: number;
  ship_to: { name: string; city: string; state: string; pincode: string };
  awb_code: string | null;
  courier_name: string | null;
  tracking_url: string | null;
  refunded_inr: number | null;
  created_at: string;
  paid_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}

/** The parcel the owner hands to Shiprocket: kilograms and centimetres. */
export interface ShopPackage {
  weight_kg: number;
  length_cm: number;
  breadth_cm: number;
  height_cm: number;
}
