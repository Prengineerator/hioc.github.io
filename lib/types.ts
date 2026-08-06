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

// Which surface created an order (phase3-migration.sql §3, FND3-2). Existing
// rows backfill to 'customer_web'; the website checkout keeps writing it.
export type OrderChannel = 'customer_web' | 'staff_pos' | 'table_qr';

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
// 'bill' = the link-based e-bill (RCT-1/2), delivered on email + WhatsApp via the
// notification engine (sendBillNotification). Its handlers live alongside the
// status events: template name in adapters.ts, body/vars in templates.ts.
export type NotificationEvent = 'accepted' | 'ready' | 'rejected' | 'cancelled' | 'bill';
// 'skipped' (BILL-3, migration 2026-08-bill-observability.sql) = deliberately not
// attempted, with the cause in `skip_reason` — distinguishes "no phone captured"
// or "channel not configured" from a send that was tried and failed.
export type NotificationStatus = 'queued' | 'sent' | 'failed' | 'skipped';

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
  // Optional owner-defined POS shortform (2026-07-menu-short-code migration).
  // Stored UPPERCASE, ^[A-Za-z0-9]{1,8}$; null when unset. Powers the staff
  // quick-add bar's top-priority code tiers; case-insensitively unique per item.
  short_code: string | null;
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
  customer_email: string | null; // optional; used for the link-based e-bill (migration 2026-07-order-email)
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
  // Phase-3 additions (phase3-migration.sql §3): dine-in channel + attribution.
  // NOTE: customer_email already exists above (link-based e-bill migration) — the
  // Phase-3 RCT-2 email-bill work reuses it rather than adding a column.
  channel: OrderChannel; // which surface created it (FND3-2)
  table_id: string | null; // dine-in table (FND3-1); null for takeaway/web
  table_label: string; // snapshot of the table label at order time (survives renames)
  created_by: string | null; // staff/manager/owner who punched a staff_pos order
  // Phase-4 addition (2026-08-counter-loyalty.sql): VAL-2/D4-3. Whose loyalty
  // account this order belongs to — server-derived from a VERIFIED phone, never
  // from a request body. Deliberately NOT user_id, which means "the session that
  // placed it" and stays null for staff orders. Null when nobody was matched.
  customer_user_id: string | null;
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
  // Phase-3 additions (phase3-migration.sql §4, FND3-4): a wrongly punched line
  // is VOIDED, never deleted — kept for audit; excluded from totals server-side.
  voided: boolean;
  void_reason: string;
  voided_by: string | null;
  voided_at: string | null;
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
  /** Why a 'skipped' row was not attempted, e.g. 'no_phone' | 'not_configured:WHATSAPP_TPL_BILL'. */
  skip_reason: string;
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
  // POS4-3 (migration 2026-08-auto-print). Opposite defaults on purpose: the
  // kitchen always wants its ticket, most counters don't want paper on every
  // settle.
  auto_print_kot: boolean;
  auto_print_bill: boolean;
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

// ===========================================================================
// PHASE 3 "Dine-In & Counter Ops" — mirrors supabase/phase3-migration.sql.
// ===========================================================================

// --- Tables registry (migration §2) ----------------------------------------
// NOTE: qr_token is intentionally OMITTED from this shape — it must never reach
// an unauthenticated client. Server routes select an explicit column list
// excluding it, and match /t/<token> server-side (service role).
export interface Table {
  id: string;
  label: string;
  zone: string; // '' = none
  capacity: number; // 0 = unspecified
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// --- Order corrections (migration §5) --------------------------------------
// Open enum: 'change_table'/'comp' reserved; rounds would attach here if the
// service model ever changes (docs/PHASE-3-SPEC.md §7).
export type AmendmentKind = 'void_item' | 'change_table' | 'comp';

export interface OrderAmendment {
  id: string;
  order_id: string;
  staff_id: string | null; // manager for gated actions
  kind: AmendmentKind;
  payload: Record<string, unknown>; // { order_item_id, reason, ... }
  created_at: string;
}

// --- Cash management (migration §6) ----------------------------------------
export type CashDayStatus = 'open' | 'closed';

// Denomination → count, e.g. { "500": 3, "200": 5, "10": 12 }. Totals are always
// derived from this server-side, never typed (OPS-2).
export type CashDenoms = Record<string, number>;

export interface CashDay {
  id: string;
  business_date: string; // 'YYYY-MM-DD' (IST business date)
  status: CashDayStatus;
  opened_by: string | null;
  opened_at: string;
  opening_denoms: CashDenoms;
  opening_total_inr: number;
  closed_by: string | null; // sign-off (manager by default)
  closed_at: string | null;
  closing_denoms: CashDenoms;
  counted_total_inr: number;
  expected_cash_inr: number; // opening + Σ cash settles − Σ cash refunds
  over_short_inr: number; // counted - expected (signed)
  notes: string;
}

// --- Permission matrix (migration §7) --------------------------------------
// Sensitive-action keys, gated at 'staff' (staff-and-up) or 'manager'
// (manager-and-up). owner always passes; unknown keys fail closed to manager —
// both enforced in lib/permissions.ts (FND3-6), not the DB.
// Note there is deliberately no 'attendance_punch' key — clocking in/out is
// gated on a valid staff session only. See lib/permissions.ts and
// docs/SECURITY-PLAYBOOK.md A-4 for why adding one would be a mistake.
export type PermissionKey =
  | 'pos_order_entry'
  | 'settle_payment'
  | 'menu_edit'
  | 'cash_day_open'
  | 'void_line'
  | 'comp_order'
  | 'refund'
  | 'cash_day_close'
  | 'attendance_edit'
  | 'attendance_approve'
  | 'leave_approve';

export type PermissionMinRole = 'staff' | 'manager';

export interface RolePermission {
  permission_key: PermissionKey;
  min_role: PermissionMinRole;
  updated_by: string | null;
  updated_at: string;
}

// --- Phase-3 analytics view rows (migration §9) ----------------------------
export interface ChannelMixRow {
  channel: OrderChannel;
  order_type: OrderType;
  orders: number;
  revenue_inr: number;
  avg_ticket_inr: number;
}

export interface TableTurnoverRow {
  table_id: string | null;
  table_label: string;
  business_date: string;
  settled_orders: number;
  revenue_inr: number;
}

export interface StaffEntryStatsRow {
  staff_id: string | null;
  business_date: string;
  orders_entered: number;
  revenue_inr: number;
}

// --- Permission-change audit (migration §10) -------------------------------
// One row per owner edit to the permission matrix (FND3-6 AC: every flip is
// audited — which key changed, from what to what, by whom, when). Written by the
// owner-only permissions route; mirrors the Phase-1 role_change_audit style.
export interface PermissionChangeAudit {
  id: string;
  permission_key: PermissionKey;
  old_min_role: PermissionMinRole | null;
  new_min_role: PermissionMinRole;
  changed_by: string | null;
  changed_at: string;
}

// --- Phase 5: attendance & payroll (2026-08-attendance.sql) ----------------

/**
 * The singleton rule set: geofence config (read by the punch route) plus the
 * payroll rules (read by the salary engine).
 *
 * NEVER send this to a client. A staffer who knows the radius knows most of
 * what they need to beat it (SECURITY-PLAYBOOK A-3) — the punch response
 * carries only accept/refuse and the staffer's own distance.
 *
 * `store_lat`/`store_lng` are null until the owner sets them, and null means
 * punching is disabled rather than universally allowed.
 */
export interface AttendanceSettings {
  id: string;
  is_singleton: boolean;
  store_lat: number | null;
  store_lng: number | null;
  geofence_radius_m: number;
  max_accuracy_m: number;
  max_fix_age_sec: number;
  grace_period_min: number;
  late_marks_per_halfday: number;
  ot_threshold_min: number;
  ot_multiplier: number;
  auto_break_min: number;
  auto_break_after_min: number;
  half_day_min_minutes: number;
  absent_below_minutes: number;
  auto_close_grace_min: number;
  max_session_hours: number;
  location_retention_days: number;
  /** How many days off one person may hold in a single week (LEAVE). */
  max_leave_days_per_week: number;
  updated_by: string | null;
  updated_at: string;
}

/** Effective-dated so a raise never rewrites what an earlier month was paid at. */
export interface StaffEmployment {
  id: string;
  user_id: string;
  monthly_salary_inr: number;
  contracted_hours_per_day: number;
  shift_start_time: string; // 'HH:MM:SS'
  shift_end_time: string;
  weekly_off_dow: number | null; // 0 = Sunday .. 6 = Saturday
  effective_from: string; // ISO date
  effective_to: string | null; // null = still in effect
  created_by: string | null;
  created_at: string;
}

export type AttendanceStatus = 'open' | 'closed' | 'auto_closed' | 'void';
/** 'manual' entries are owner-entered and must never render as verified punches. */
export type AttendanceSource = 'punch' | 'manual';
export type PunchType = 'in' | 'out';

/** GEO-2 integrity signals. Informational — a flag never blocks a punch. */
export type AttendanceFlag =
  | 'low_confidence'
  | 'static_coords'
  | 'impossible_travel'
  | 'implausible_accuracy'
  | 'auto_closed';

export interface AttendanceSession {
  id: string;
  user_id: string;
  /** Derived by DB trigger from clock_in_at in IST — never supplied by a caller. */
  business_date: string;
  clock_in_at: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_in_accuracy_m: number | null;
  clock_in_distance_m: number | null;
  clock_out_at: string | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  clock_out_accuracy_m: number | null;
  clock_out_distance_m: number | null;
  status: AttendanceStatus;
  source: AttendanceSource;
  flags: AttendanceFlag[];
  approved_by: string | null;
  approved_at: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

/** A refused punch. Recorded so a refusal is learnable, by both owner and staffer. */
export interface AttendancePunchAttempt {
  id: string;
  user_id: string;
  punch_type: PunchType;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  distance_m: number | null;
  reason: string;
  created_at: string;
}

export interface AttendanceEdit {
  id: string;
  session_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  edited_by: string | null;
  edited_at: string;
}

export type PayrollRunStatus = 'draft' | 'finalized' | 'reversed';

export interface PayrollRun {
  id: string;
  period_start: string;
  period_end: string;
  status: PayrollRunStatus;
  /** The rules and rates actually used, frozen at finalize (PAY-4). */
  rules_snapshot: Record<string, unknown>;
  generated_by: string | null;
  generated_at: string;
  finalized_at: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
}

// --- Phase 5: weekly leave planning (2026-08-leave-planning.sql) -----------

export type LeaveStatus = 'requested' | 'approved' | 'declined' | 'withdrawn';

/**
 * One requested day off. `week_start` is always a Monday and `leave_date` is
 * always Mon–Fri inside that week — both enforced by CHECK constraints, since
 * a row that violates either would put the roster and payroll into
 * disagreement about the same date.
 */
export interface LeaveRequest {
  id: string;
  user_id: string;
  week_start: string;
  leave_date: string;
  status: LeaveStatus;
  reason: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string;
  created_at: string;
  updated_at: string;
}

export type LeaveReminderKind = 'staff_submit' | 'manager_decide';

export interface LeaveReminderLog {
  id: string;
  user_id: string;
  week_start: string;
  kind: LeaveReminderKind;
  channel: 'whatsapp' | 'email' | 'inapp';
  sent_on: string;
  status: 'sent' | 'skipped' | 'failed';
  skip_reason: string;
  created_at: string;
}

export interface PayrollRunLine {
  id: string;
  run_id: string;
  user_id: string;
  monthly_salary_inr: number;
  contracted_hours_per_day: number;
  per_minute_paise: number;
  days_present: number;
  days_half: number;
  days_absent: number;
  days_off: number;
  days_paid_leave: number;
  worked_minutes: number;
  ot_minutes: number;
  late_marks: number;
  base_pay_inr: number;
  ot_pay_inr: number;
  deductions_inr: number;
  /** Signed: advances/loans/corrections (D5-7). Negative reduces net pay. */
  adjustments_inr: number;
  net_pay_inr: number;
  detail: Record<string, unknown>;
}
