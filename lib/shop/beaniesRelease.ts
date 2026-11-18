// Which of a signed-in customer's OWN unpaid shop orders hold Beanies that a new
// checkout may ask to release first (docs/SHOP-V2-SPEC.md E5). Read-only and
// light on imports so the quote (lib/shop/context.ts) can use it. The release
// itself is releaseOwnPendingShopBeanies in lifecycle.ts. Both use the same
// filter, so the quote and checkout agree.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toShopOrderRow } from '@/lib/shop/server';
import type { ShopOrderRow } from '@/lib/shop/types';

/** An order must be at least this old before a new checkout may release it (a payment may be in flight). */
export const RELEASE_MIN_AGE_SEC = 60;
/** Most orders one checkout releases. */
export const RELEASE_MAX_ORDERS = 5;

/**
 * The customer's own `payment_pending` shop orders that hold Beanies, older than
 * RELEASE_MIN_AGE_SEC, oldest first, at most RELEASE_MAX_ORDERS. The order opened
 * by `excludeIdempotencyKey` (the one this checkout would reuse) is left out.
 * Never throws; a failure reads as "nothing to release".
 */
export async function loadReleasablePendingOrders(
  admin: SupabaseClient,
  userId: string,
  opts: { excludeIdempotencyKey?: string | null; now?: Date } = {},
): Promise<ShopOrderRow[]> {
  try {
    const now = opts.now ?? new Date();
    const cutoff = new Date(now.getTime() - RELEASE_MIN_AGE_SEC * 1000).toISOString();
    const { data, error } = await admin
      .from('shop_orders')
      .select('*')
      .eq('status', 'payment_pending')
      .eq('user_id', userId)
      .gt('beanies_redeemed', 0)
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(RELEASE_MAX_ORDERS + 1);
    if (error) {
      console.error('shop beanies release: lookup failed', error);
      return [];
    }
    const key = opts.excludeIdempotencyKey ?? null;
    return ((data ?? []) as Record<string, unknown>[])
      .map((raw) => toShopOrderRow(raw))
      .filter((o) => !(key && o.idempotency_key === key))
      .slice(0, RELEASE_MAX_ORDERS);
  } catch (e) {
    console.error('shop beanies release: lookup threw', e);
    return [];
  }
}

/** Beanies held by the customer's releasable pending orders (what checkout would free up). */
export async function releasableShopBeanies(admin: SupabaseClient, userId: string, now?: Date): Promise<number> {
  const orders = await loadReleasablePendingOrders(admin, userId, { now });
  return orders.reduce((sum, o) => sum + (Number.isFinite(o.beanies_redeemed) ? Math.max(0, o.beanies_redeemed) : 0), 0);
}
