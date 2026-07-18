// TypeScript mirror of the Supabase schema.
// Base tables live in supabase/schema.sql; the Phase-1 "Connected Ordering"
// additions live in supabase/phase1-migration.sql. Keep this file in EXACT
// sync with BOTH — do not let them drift (Phase-1 DoD, docs/PHASE-1-SPEC.md §0).

// ---------------------------------------------------------------------------
// Enums (supabase/schema.sql + phase1-migration.sql Sections 1–2, 8)
// ---------------------------------------------------------------------------

// Full fulfillment lifecycle. 'placed' is forward-compat (used when online
// payment gates an order before 'received', Phase 2); Phase-1 orders start at
// 'received'. Terminal states: 'completed', 'rejected', 'cancelled'.
export type OrderStatus =
  | 'placed'
  | 'received'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'rejected'
  | 'cancelled';

export type OrderType = 'takeaway' | 'dine_in' | 'delivery';

export type PaymentStatus =
  | 'unpaid'
  | 'payment_pending'
  | 'paid'
  | 'refunded'
  | 'partially_refunded';

export type PaymentMethod = 'cash' | 'upi' | 'card' | 'online';

// Who performed a lifecycle transition (order_status_events.actor_role).
export type ActorRole = 'customer' | 'staff' | 'owner' | 'system';

// profiles.role — 'owner' added in phase1-migration.sql §8, 'manager' in
// phase2-migration.sql §8 (FND-5: gates refunds and other sensitive actions).
export type UserRole = 'staff' | 'customer' | 'owner' | 'manager';

export type AddonSelectionType = 'single' | 'multi';

// Notifications (phase1-migration.sql §6).
export type NotificationChannel = 'whatsapp' | 'sms' | 'push' | 'email';
export type NotificationEvent = 'accepted' | 'ready' | 'rejected' | 'cancelled';
export type NotificationStatus = 'queued' | 'sent' | 'failed';

// store_settings.store_open_override (phase1-migration.sql §7).
export type StoreOpenOverride = 'auto' | 'force_open' | 'force_closed';

// ---------------------------------------------------------------------------
// Menu catalog
// ---------------------------------------------------------------------------

export interface MenuItemVariant {
  id: string;
  menu_item_id: string;
  label: string;
  price_inr: number;
  sort_order: number;
}

export interface AddonOption {
  id: string;
  addon_group_id: string;
  name: string;
  price_inr: number;
  sort_order: number;
}

export interface AddonGroup {
  id: string;
  name: string;
  display_name: string;
  selection_type: AddonSelectionType;
  min_select: number;
  max_select: number;
  sort_order: number;
  options: AddonOption[];
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  category: string;
  parent_category: string;
  is_veg: boolean;
  is_available: boolean;
  sort_order: number;
  // Phase-1 additions (migration §5):
  image_url: string; // '' when no photo uploaded (C6 placeholder)
  unavailable_until: string | null; // 86 auto-reenable; null = not snoozed (STF-032)
  created_at: string;
  updated_at: string;
  variants: MenuItemVariant[];
  addon_groups: AddonGroup[];
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface Order {
  id: string;
  order_number: number;
  customer_name: string;
  customer_phone: string;
  pickup_time: string; // DEPRECATED free-text (schema.sql); prefer pickup_slot_* below
  status: OrderStatus;
  subtotal_inr: number;
  notes: string;
  created_at: string;
  updated_at: string;
  // Phase-1 additions (migration §3):
  order_type: OrderType;
  promised_ready_at: string | null; // ETA set by staff on accept (STF-006)
  pickup_code: string | null; // shown to customer / verified at counter (CUS-056)
  pickup_slot_start: string | null; // structured slot (CUS-026)
  pickup_slot_label: string; // e.g. 'ASAP (~15 min)', '1:30 PM'
  tax_inr: number; // GST breakup (CUS-031)
  packaging_inr: number;
  discount_inr: number;
  total_inr: number | null; // subtotal + tax + packaging - discount
  payment_status: PaymentStatus;
  payment_method: PaymentMethod | null; // null until collected (STF-041)
  reject_reason: string; // populated on rejected/cancelled (STF-003)
  version: number; // optimistic-concurrency guard (F1)
  // Phase-2 addition (migration §2): links an order to a customer account
  // (ACC-2/ACC-4). Null for guest checkout; backfilled on guest-claim by phone.
  user_id: string | null;
}

export interface OrderItemAddon {
  id: string;
  order_item_id: string;
  addon_option_id: string | null;
  group_name_snapshot: string;
  option_name_snapshot: string;
  price_inr_snapshot: number;
}

export interface OrderItem {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  variant_id: string | null;
  name_snapshot: string;
  variant_label_snapshot: string;
  price_inr_snapshot: number;
  quantity: number;
  line_total_inr: number;
  special_instructions: string; // per-line note (CUS-021); snapshotted (migration §5)
  addons: OrderItemAddon[];
}

// ---------------------------------------------------------------------------
// Order lifecycle event log (migration §4) — one row per transition (F1).
// ---------------------------------------------------------------------------

export interface OrderStatusEvent {
  id: string;
  order_id: string;
  from_status: OrderStatus | null; // null for the initial 'received' event
  to_status: OrderStatus;
  actor_id: string | null; // null for customer/system actions
  actor_role: ActorRole;
  reason: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Notifications delivery log (migration §6) — F4.
// ---------------------------------------------------------------------------

export interface NotificationRecord {
  id: string;
  order_id: string;
  channel: NotificationChannel;
  event: NotificationEvent;
  status: NotificationStatus;
  provider_ref: string;
  error: string;
  attempts: number;
  sent_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Store settings (migration §7) — singleton config row (O5).
// ---------------------------------------------------------------------------

// One weekly window; a day may have several. Times are 'HH:MM' 24h local (IST).
// 'close' may be '24:00' to mean midnight (matches CAFE_HOURS "10:00 AM–12:00 AM").
export interface OpeningHoursWindow {
  open: string;
  close: string;
}

// Keyed by 3-letter lowercase weekday: mon,tue,wed,thu,fri,sat,sun.
export type OpeningHours = Partial<Record<string, OpeningHoursWindow[]>>;

export interface StoreSettings {
  id: string;
  is_singleton: boolean;
  opening_hours: OpeningHours;
  holidays: string[]; // ISO dates, e.g. ['2026-08-15']
  last_order_cutoff_min: number;
  pickup_slot_len_min: number;
  pickup_slot_capacity: number; // 0 = unlimited
  default_prep_min: number;
  busy_buffer_min: number;
  accepting_orders: boolean;
  store_open_override: StoreOpenOverride;
  gst_percent: number;
  gst_inclusive: boolean;
  packaging_charge_inr: number;
  updated_at: string;
}

export interface RoleChangeAudit {
  id: string;
  target_user: string;
  old_role: string | null;
  new_role: string;
  changed_by: string | null;
  changed_at: string;
}

// ---------------------------------------------------------------------------
// Analytics view row shapes (migration §10) — F5 / owner dashboard.
// ---------------------------------------------------------------------------

export interface DailySalesRow {
  sale_date: string; // 'YYYY-MM-DD' (IST)
  orders: number;
  revenue_inr: number;
  aov_inr: number;
}

export interface ItemSalesRow {
  menu_item_id: string | null;
  item_name: string;
  units_sold: number;
  revenue_inr: number;
}

export interface HourlyOrdersRow {
  dow: number; // 0 = Sunday
  hour_of_day: number;
  orders: number;
  revenue_inr: number;
}

export interface OrderDurationRow {
  order_id: string;
  order_date: string;
  accept_secs: number | null;
  prep_secs: number | null;
  fulfil_secs: number | null;
}

export interface RejectReasonRow {
  status: OrderStatus;
  reason: string;
  cnt: number;
}

// ===========================================================================
// PHASE 2 "Value & Retention" — mirrors supabase/phase2-migration.sql.
// ===========================================================================

// --- Payments & refunds (migration §3) -------------------------------------
export type RefundStatus = 'pending' | 'processed' | 'failed';

export interface Payment {
  id: string;
  order_id: string;
  gateway: string; // e.g. 'razorpay'
  gateway_order_id: string;
  gateway_payment_id: string;
  method: PaymentMethod | null;
  amount_inr: number;
  status: PaymentStatus;
  signature_ok: boolean;
  error: string;
  created_at: string;
  updated_at: string;
}

export interface Refund {
  id: string;
  payment_id: string;
  order_id: string;
  amount_inr: number;
  reason: string;
  status: RefundStatus;
  gateway_ref: string;
  created_by: string | null;
  created_at: string;
  processed_at: string | null;
}

// --- Accounts (migration §4) -----------------------------------------------
// The Phase-2 columns added to the Phase-1 `profiles` table.
export interface CustomerProfile {
  id: string;
  role: UserRole;
  name: string;
  phone: string;
  phone_verified: boolean;
  marketing_consent: boolean; // DPDP: marketing only, never gates transactional
  prefs: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Favorite {
  user_id: string;
  menu_item_id: string;
  created_at: string;
}

// --- Coupons & promotions (migration §5) -----------------------------------
export type CouponDiscountType = 'percent' | 'flat';

export interface CouponScope {
  item_ids?: string[];
  category?: string[];
}

export interface Coupon {
  id: string;
  code: string;
  description: string;
  discount_type: CouponDiscountType;
  discount_value: number; // percent (0-100) or ₹
  min_order_inr: number;
  max_discount_inr: number; // 0 = no cap
  scope: CouponScope; // empty = whole menu
  valid_from: string | null;
  valid_to: string | null;
  usage_limit: number; // 0 = unlimited
  per_user_limit: number; // 0 = unlimited
  is_auto: boolean;
  active: boolean;
  created_at: string;
}

export interface CouponRedemption {
  id: string;
  coupon_id: string;
  order_id: string;
  user_id: string | null;
  discount_inr: number;
  created_at: string;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  image_url: string;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
}

// --- Loyalty (migration §6) ------------------------------------------------
export type LoyaltyTxType = 'earn' | 'redeem' | 'adjust' | 'reverse' | 'expire';

export interface LoyaltyAccount {
  user_id: string;
  points_balance: number;
  updated_at: string;
}

export interface LoyaltyTransaction {
  id: string;
  user_id: string;
  order_id: string | null;
  type: LoyaltyTxType;
  points: number; // signed: +earn / -redeem
  note: string;
  created_at: string;
}

export interface LoyaltyConfig {
  id: string;
  is_singleton: boolean;
  points_per_inr: number;
  inr_per_point: number;
  min_redeem_points: number;
  max_redeem_pct: number; // cap redemption at % of bill
  points_expiry_days: number; // 0 = never
  enrolled_by_default: boolean;
  updated_at: string;
}

// --- Reviews (migration §7) ------------------------------------------------
export interface Review {
  id: string;
  order_id: string;
  menu_item_id: string | null; // null = overall order rating
  user_id: string | null; // null = guest via order link
  rating: number; // 1-5
  comment: string;
  staff_response: string;
  responded_at: string | null;
  hidden: boolean;
  created_at: string;
}

// --- Phase-2 analytics view rows (migration §10) ---------------------------
export interface CustomerStatsRow {
  user_id: string;
  orders: number;
  revenue_inr: number;
  aov_inr: number;
  first_order_at: string;
  last_order_at: string;
}

export interface NewVsReturningRow {
  order_date: string;
  new_customers: number;
  returning_customers: number;
}

export interface PaymentMixRow {
  method: string;
  payments: number;
  collected_inr: number;
  refunded_inr_total: number;
}

export interface CouponPerformanceRow {
  code: string;
  redemptions: number;
  discount_given_inr: number;
}

export interface ReviewSummaryRow {
  review_date: string;
  menu_item_id: string | null;
  reviews: number;
  avg_rating: number;
}
