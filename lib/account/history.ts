import 'server-only';

// Pure merge/dedupe/paginate/security rules behind GET /api/account/history
// (ACC-2, widened by the "customer login should show every order" fix).
// Kept dependency-free — no Supabase import here — so the rules that matter
// most (dedupe by id, newest first, and the one security rule below) can be
// tested without mocking a database.
//
// A caller's orders come from up to three Supabase queries run by the route
// handler (owner-linked, and — only when the caller's own phone is verified
// — unclaimed guest orders). This module is what turns those lists into one
// correct page.

export interface OrderIdRow {
  id: string;
  created_at: string;
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

export interface OwnedOrderFields {
  user_id?: string | null;
  customer_user_id?: string | null;
  customer_phone?: string | null;
}

/**
 * Whether an order belongs to `userId`, by the same three rules
 * GET /api/account/history applies above — reused by the reorder route
 * (ACC-4) so a past order that surfaces in history only because of a
 * counter link or an unclaimed guest match is also reorderable, not just
 * viewable, instead of silently 404ing.
 */
export function ownsOrder(
  order: OwnedOrderFields | null | undefined,
  userId: string,
  profile: CallerProfile | null | undefined,
): boolean {
  if (!order || !userId) return false;
  if (order.user_id === userId) return true;
  if (order.customer_user_id === userId) return true;
  return (
    !order.user_id &&
    includeGuestOrdersByPhone(profile) &&
    Boolean(order.customer_phone) &&
    order.customer_phone === profile!.phone
  );
}
