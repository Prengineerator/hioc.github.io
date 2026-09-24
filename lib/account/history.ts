import 'server-only';

import { isTerminal } from '@/lib/orders/stateMachine';
import type { OrderStatus } from '@/lib/types';

// Pure merge/dedupe/paginate/security/status-filter rules behind
// GET /api/account/history (ACC-2, widened by the "customer login should
// show every order" fix; status filter added for the Active/Past tabs on
// the account orders page). Kept dependency-free of Supabase — so the rules
// that matter most (dedupe by id, newest first, the one security rule
// below, and the status partition) can be tested without mocking a
// database. `isTerminal` is the one exception: it's the same pure,
// Supabase-free state-machine predicate the order-status route and the
// customer order-tracking page already use, and reusing it here (rather
// than re-listing which statuses are terminal) is what guarantees "Active"
// here can never silently drift from what the rest of the app calls active.
//
// A caller's orders come from up to three Supabase queries run by the route
// handler (owner-linked, and unclaimed guest orders matched by the caller's
// own verified phone and/or verified login email). This module is what turns those lists into one
// correct page.

export interface OrderIdRow {
  id: string;
  created_at: string;
}

export type HistoryStatusFilter = 'active' | 'past';

export function isValidHistoryStatusFilter(value: unknown): value is HistoryStatusFilter {
  return value === 'active' || value === 'past';
}

/**
 * "Active" = still moving toward fulfillment (placed/received/accepted/
 * preparing/ready); "Past" = terminal (completed/rejected/cancelled) — the
 * exact complement of `isTerminal()` (lib/orders/stateMachine.ts), which is
 * what the Active/Past tabs on the account orders page (and the "Active
 * order" callout on the account overview) mean by each word.
 */
export function isActiveOrderStatus(status: OrderStatus): boolean {
  return !isTerminal(status);
}

export interface OrderStatusRow extends OrderIdRow {
  status: OrderStatus;
}

/**
 * Narrows an already-merged, newest-first order list to just the Active or
 * Past bucket. Applied AFTER `mergeOrderRows` and BEFORE
 * `paginateOrderRows`, so `total`/`hasMore` reflect the filtered set — not
 * the caller's whole history — and pagination stays correct within a tab.
 * A missing/invalid filter is a no-op (returns `rows` unchanged).
 */
export function filterOrderRowsByStatus<T extends OrderStatusRow>(
  rows: T[],
  filter: HistoryStatusFilter | null | undefined,
): T[] {
  if (!filter) return rows;
  return rows.filter((row) =>
    filter === 'active' ? isActiveOrderStatus(row.status) : !isActiveOrderStatus(row.status),
  );
}

/**
 * Combines however many source lists (owner-linked orders, phone-matched
 * guest orders, …) into one, newest first, with each order id appearing
 * exactly once.
 *
 * An order that satisfies more than one source — e.g. a staff-linked counter
 * order (`customer_user_id` match) whose `customer_phone` also matches the
 * caller's own verified phone — keeps whichever copy was listed first. Every
 * source carries the same `{ id, created_at }` shape, so which copy wins is
 * never observable.
 */
export function mergeOrderRows<T extends OrderIdRow>(sources: T[][]): T[] {
  const seen = new Map<string, T>();
  for (const rows of sources) {
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.set(row.id, row);
      }
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.created_at === b.created_at) return 0;
    return a.created_at > b.created_at ? -1 : 1;
  });
}

export interface OrderPage<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/**
 * Slices an already-sorted (newest-first) list into one 1-indexed page. An
 * out-of-range `page` (0, negative, non-integer) is treated as page 1 rather
 * than producing a negative offset.
 */
export function paginateOrderRows<T>(rows: T[], page: number, pageSize: number): OrderPage<T> {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const from = (safePage - 1) * pageSize;
  const items = rows.slice(from, from + pageSize);
  return {
    items,
    total: rows.length,
    hasMore: from + items.length < rows.length,
  };
}

export interface CallerProfile {
  phone: string | null;
  phone_verified: boolean | null;
}

/**
 * Security rule: a guest order (no account linked — `user_id` null, matched
 * only by `orders.customer_phone`) may surface in a caller's history ONLY
 * when that CALLER's own profile phone is verified. An unverified phone
 * must never widen what a caller can see — the whole point of gating on
 * `phone_verified` is that a caller can type any number as their guess, and
 * "I typed it" must never be treated as "it's mine". The order's own
 * `customer_phone` was never itself re-verified as belonging to the caller;
 * it only has to match the caller's already-verified number.
 */
export function includeGuestOrdersByPhone(profile: CallerProfile | null | undefined): boolean {
  return Boolean(profile?.phone_verified && profile.phone);
}

/**
 * The caller's VERIFIED login email, lowercased — or null. Supabase Auth only
 * sets `email_confirmed_at` once the address has been proven (magic link /
 * confirmation link / email-change confirmation), so an unconfirmed address
 * a caller merely typed never counts. Orders store `customer_email` already
 * lowercased (lib/email.ts normalizeEmail), so an exact match is enough.
 */
export function verifiedEmailOf(
  user: { email?: string | null; email_confirmed_at?: string | null } | null | undefined,
): string | null {
  if (!user?.email || !user.email_confirmed_at) return null;
  const email = user.email.trim().toLowerCase();
  return email || null;
}

export interface OwnedOrderFields {
  user_id?: string | null;
  customer_user_id?: string | null;
  customer_phone?: string | null;
  customer_email?: string | null;
}

/**
 * Whether an order belongs to `userId`, by the same rules
 * GET /api/account/history applies above — reused by the reorder route
 * (ACC-4) so a past order that surfaces in history only because of a
 * counter link or an unclaimed guest match is also reorderable, not just
 * viewable, instead of silently 404ing.
 *
 * An unclaimed guest order (user_id null) matches by the caller's verified
 * phone OR verified login email — the same direction-of-trust rule for both:
 * what the ORDER says is only ever compared against what the CALLER proved.
 */
export function ownsOrder(
  order: OwnedOrderFields | null | undefined,
  userId: string,
  profile: CallerProfile | null | undefined,
  verifiedEmail: string | null = null,
): boolean {
  if (!order || !userId) return false;
  if (order.user_id === userId) return true;
  if (order.customer_user_id === userId) return true;
  if (order.user_id) return false;
  if (
    includeGuestOrdersByPhone(profile) &&
    Boolean(order.customer_phone) &&
    order.customer_phone === profile!.phone
  ) {
    return true;
  }
  return (
    Boolean(verifiedEmail) &&
    Boolean(order.customer_email) &&
    order.customer_email!.toLowerCase() === verifiedEmail
  );
}
