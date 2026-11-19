// Instant Coffee shop types (docs/INSTANT-COFFEE-SHOP.md). Safe to import from
// both server and client code: no server-only imports here.

export type ShopOrderStatus =
  | 'payment_pending'
  | 'paid'
  | 'sent_to_shiprocket'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'expired';

/** Who entered the order: the customer on the website, or the owner by hand. */
export type ShopOrderSource = 'web' | 'owner';
/** How an order is paid: Checkout.js (website), a Razorpay payment link, or already paid offline. */
export type ShopPaymentChannel = 'checkout' | 'payment_link' | 'offline';
/** How an offline order was paid. */
export type ShopOfflineMethod = 'upi_direct' | 'cash' | 'bank_transfer';

/** Which catalogue line a product belongs to. */
export type ShopProductLine = 'instant' | 'home_blend';

/** How a Home Blend pack is ground (whole bean needs no grinding). */
export type GrindCode = 'whole_bean' | 'espresso' | 'moka' | 'filter' | 'french_press';

/** A flavour as the shop sells it (a shop_products row). */
export interface ShopProduct {
  id: string;
  name: string;
  sku: string;
  price_inr: number;
  net_qty: string;
  in_stock: boolean;
  sort_order: number;
  line: ShopProductLine;
  display_name: string;
  pack_grams: number;
  ship_weight_kg: number;
  listed: boolean;
  requires_grind: boolean;
  description: string;
}

/** One priced line of an order, frozen on shop_orders.lines at checkout. */
export interface ShopLine {
  product_id: string;
  name: string;
  sku: string;
  unit_price_inr: number;
  quantity: number;
  line_total_inr: number;
  // v2 fields. Rows frozen by v1 checkouts lack them; read a missing line as
  // 'instant'. For v2 lines `sku` is the LINE SKU: base SKU + grind suffix
  // (e.g. HIOC-HB-250G-FLT).
  line?: ShopProductLine;
  base_sku?: string;
  pack_grams?: number;
  grind?: GrindCode | null;
  grind_label?: string | null;
  ship_weight_kg?: number;
}

/** The delivery address and contact, validated (lib/shop/address.ts). */
export interface ShopAddress {
  customer_name: string;
  /** +91XXXXXXXXXX */
  phone: string;
  email: string;
  address_line1: string;
  address_line2: string;
  /** A nearby landmark for the courier (80 characters at most, '' when none). */
  landmark: string;
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
  /** Units (the name is from v1, when every unit was a jar). */
  jar_count: number;
  subtotal_inr: number;
  /** What the online offer took off (0 without one). */
  discount_inr: number;
  /** The offer's name when it was bought, e.g. "Introductory offer". */
  offer_name: string | null;
  offer_discount_inr: number;
  coupon_id: string | null;
  coupon_code: string | null;
  coupon_discount_inr: number;
  beanies_redeemed: number;
  beanies_discount_inr: number;
  intro_offer_applied: boolean;
  intro_offer_reused: boolean;
  goods_weight_kg: number | null;
  idempotency_key: string | null;
  checkout_fingerprint: string | null;
  save_address_label: string | null;
  customer_address_id: string | null;
  capture_effects_at: string | null;
  // Owner-entered orders (docs/SHOP-OWNER-ORDERS-SPEC.md). Absent on rows read
  // before supabase/2026-11-shop-owner-orders.sql: read as a website order.
  source: ShopOrderSource;
  created_by: string | null;
  payment_channel: ShopPaymentChannel;
  offline_method: ShopOfflineMethod | null;
  payment_reference: string | null;
  owner_discount_inr: number;
  owner_discount_reason: string | null;
  razorpay_payment_link_id: string | null;
  payment_link_url: string | null;
  payment_link_expires_at: string | null;
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
  /**
   * Shiprocket's own order total as last read back from Shiprocket (what its
   * invoice and emails say). Null until read, or before
   * supabase/2026-11-shop-shiprocket-total.sql is applied.
   */
  shiprocket_total_inr: number | null;
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
  /** The delivery pin, if the customer dropped one (lib/shop/location.ts). */
  location_lat: number | string | null;
  location_lng: number | string | null;
  location_accuracy_m: number | null;
  location_source: 'gps' | 'map' | null;
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
  discount_inr: number;
  offer_name: string | null;
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
  unit_count: number;
  offer_discount_inr: number;
  coupon_code: string | null;
  coupon_discount_inr: number;
  beanies_redeemed: number;
  beanies_discount_inr: number;
  intro_offer_applied: boolean;
  discounts: ShopDiscountLine[];
  /** True for an order placed without an account. */
  is_guest: boolean;
  /** Beanies this order will earn once paid, when known. */
  beanies_to_earn: number | null;
}

/**
 * The online offer (shop_settings): tier_prices[n - 1] is what n jars cost,
 * any flavours. Null when the owner has it switched off.
 */
export interface ShopOffer {
  name: string;
  tier_prices: number[];
}

/** The parcel the owner hands to Shiprocket: kilograms and centimetres. */
export interface ShopPackage {
  weight_kg: number;
  length_cm: number;
  breadth_cm: number;
  height_cm: number;
}

/** Shop-wide settings (shop_settings): offer, shipping and Beanies rules. */
export interface ShopSettings {
  offer: ShopOffer | null;
  shipping_fee_inr: number;
  free_shipping_min_inr: number;
  beanies_max_redeem_pct: number;
}

/** What checkout needs to know about a coupon (the discounts table, shop side). */
export interface ShopCouponTerms {
  id: string;
  code: string;
  discount_type: 'percent' | 'flat';
  discount_value: number;
  min_order_inr: number;
  max_discount_inr: number;
  shop_product_ids: string[];
  is_auto: boolean;
}

/** An address saved on a customer's account (customer_addresses row). */
export interface CustomerAddress {
  id: string;
  user_id: string;
  label: string;
  customer_name: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  landmark: string;
  city: string;
  state: string;
  pincode: string;
  location_lat: number | null;
  location_lng: number | null;
  location_source: 'gps' | 'map' | null;
  is_default: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What a saved address holds: the delivery address without the email. */
export type SavedAddressFields = Omit<ShopAddress, 'email'>;

/** One line of the discount breakdown on a receipt. */
export interface ShopDiscountLine {
  kind: 'offer' | 'coupon' | 'beanies' | 'owner';
  label: string;
  amount_inr: number;
}

/** One order in the customer's shop history (their own, so no address). */
export interface ShopHistoryOrder {
  id: string;
  order_number: number;
  status: ShopOrderStatus;
  lines: ShopLine[];
  unit_count: number;
  total_inr: number;
  city: string;
  awb_code: string | null;
  tracking_url: string | null;
  created_at: string;
  paid_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}
