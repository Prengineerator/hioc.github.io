// Shared validation constants for app/api/** route handlers.
// Mirrors the enums defined in supabase/schema.sql and lib/types.ts.

import type { OrderStatus } from '@/lib/types';
import { MENU_CATEGORIES as MENU_CATEGORY_DEFS } from '@/lib/constants';

// The valid `category` values a menu item may have — sourced from the same
// real-category list the frontend uses (lib/constants.ts), so the two can
// never drift.
export const MENU_CATEGORIES: readonly string[] = MENU_CATEGORY_DEFS.map(
  (c) => c.slug,
);

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'received',
  'preparing',
  'ready',
  'completed',
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

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
