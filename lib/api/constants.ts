// Shared validation constants for app/api/** route handlers.
// Mirrors the enums defined in supabase/schema.sql, phase1-migration.sql,
// and lib/types.ts.

import type { OrderStatus, OrderType, PaymentMethod } from '@/lib/types';
import { MENU_CATEGORIES as MENU_CATEGORY_DEFS } from '@/lib/constants';

// The valid `category` values a menu item may have — sourced from the same
// real-category list the frontend uses (lib/constants.ts), so the two can
// never drift.
export const MENU_CATEGORIES: readonly string[] = MENU_CATEGORY_DEFS.map(
  (c) => c.slug,
);

// Full Phase-1 lifecycle enum (order_status). Note the API no longer accepts
// an arbitrary status on the transition route — the state machine
// (lib/orders/stateMachine.ts) governs which transitions are legal — but this
// list is still the source of truth for validating a status *value*.
export const ORDER_STATUSES: readonly OrderStatus[] = [
  'placed',
  'received',
  'accepted',
  'preparing',
  'ready',
  'completed',
  'rejected',
  'cancelled',
];

export const ORDER_TYPES: readonly OrderType[] = [
  'takeaway',
  'dine_in',
  'delivery',
];

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'upi',
  'card',
  'online',
];

// Standard (RFC 4122-ish) UUID, case-insensitive — good enough to short-circuit
// obviously-malformed ids before round-tripping to Postgres.
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMenuCategory(value: unknown): value is string {
  return typeof value === 'string' && MENU_CATEGORIES.includes(value);
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === 'string' &&
    (ORDER_STATUSES as readonly string[]).includes(value)
  );
}

export function isOrderType(value: unknown): value is OrderType {
  return (
    typeof value === 'string' && (ORDER_TYPES as readonly string[]).includes(value)
  );
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return (
    typeof value === 'string' &&
    (PAYMENT_METHODS as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
