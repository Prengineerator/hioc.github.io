import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { earnForShopOrder } from '@/lib/loyalty/ledger';
import { isMissingShopSchema } from '@/lib/shop/server';

/**
 * Guest-order claim (ACC-4): links any past guest orders (user_id null)
 * placed with the caller's now-VERIFIED phone number onto their account, by
 * matching `orders.customer_phone` (stored E.164, e.g. "+919876543210" — see
 * app/api/orders/route.ts). Called on every login (app/login/page.tsx) so a
 * returning guest's history appears automatically once they sign in with the
 * same number.
 *
 * Server-only (service role) — customers have no client-side write access to
 * `orders`, by design (Phase-1 F1/RLS).
 */
export async function claimGuestOrders(
  admin: SupabaseClient,
  userId: string,
  phone: string,
): Promise<number> {
  if (!phone) return 0;

  const { data, error } = await admin
    .from('orders')
    .update({ user_id: userId })
    .eq('customer_phone', phone)
    .is('user_id', null)
    .select('id');

  if (error) {
    console.error('claimGuestOrders: update failed', error);
    return 0;
  }
  return data?.length ?? 0;
}

/**
 * Same as claimGuestOrders, keyed on the caller's VERIFIED login email
 * (lib/account/history.ts verifiedEmailOf) instead of their phone — so a
 * guest who gave an email at checkout and later logs in with that email (or
 * adds it to a phone login) finds those orders on their account. Orders
 * store `customer_email` already lowercased (lib/email.ts).
 */
export async function claimGuestOrdersByEmail(
  admin: SupabaseClient,
  userId: string,
  verifiedEmail: string | null,
): Promise<number> {
  if (!verifiedEmail) return 0;

  const { data, error } = await admin
    .from('orders')
    .update({ user_id: userId })
    .eq('customer_email', verifiedEmail)
    .is('user_id', null)
    .select('id');

  if (error) {
    console.error('claimGuestOrdersByEmail: update failed', error);
    return 0;
  }
  return data?.length ?? 0;
}

/**
 * Guest SHOP orders (docs/SHOP-V2-SPEC.md E4): links shop_orders with no
 * account (user_id null) to the caller when the order's phone matches the
 * caller's VERIFIED phone or its email matches the caller's VERIFIED login
 * email. Both keys come from the caller's own proof (never from an order), so
 * a null key matches nothing.
 *
 * Beanies (E5): an order that is already 'delivered' when claimed earns
 * straight away (earnForShopOrder is idempotent); one still on its way earns
 * when it is delivered, because it now has an account.
 *
 * The introductory offer is once per customer: the claim row the guest's
 * order made (shop_intro_claims) moves to the account too, best effort. If
 * the account already holds a claim (unique violation 23505) the guest row is
 * left as it is. A database without the shop tables yet claims nothing.
 */
export async function claimGuestShopOrders(
  admin: SupabaseClient,
  userId: string,
  keys: { phone: string | null; email: string | null },
): Promise<{ claimed: number; earned: number }> {
  const none = { claimed: 0, earned: 0 };
  const phone = keys.phone || null;
  const email = keys.email ? keys.email.trim().toLowerCase() : null;
  if (!userId || (!phone && !email)) return none;

  let claimed = 0;
  let earned = 0;
  const deliveredIds: string[] = [];

  for (const [column, value] of [['phone', phone], ['email', email]] as const) {
    if (!value) continue;
    const { data, error } = await admin
      .from('shop_orders')
      .update({ user_id: userId })
      .eq(column, value)
      .is('user_id', null)
      .select('id, status');
    if (error) {
      if (!isMissingShopSchema(error)) console.error('claimGuestShopOrders: update failed', error);
      if (isMissingShopSchema(error)) return none;
      continue;
    }
    for (const row of (data ?? []) as { id: string; status: string }[]) {
      claimed += 1;
      if (row.status === 'delivered') deliveredIds.push(row.id);
    }
  }

  for (const id of deliveredIds) {
    try {
      if ((await earnForShopOrder(id)) > 0) earned += 1;
    } catch (e) {
      console.error('claimGuestShopOrders: earn failed', e);
    }
  }

  for (const [column, value] of [['phone', phone], ['email', email]] as const) {
    if (!value) continue;
    const { error } = await admin
      .from('shop_intro_claims')
      .update({ user_id: userId })
      .eq(column, value)
      .is('user_id', null);
    // 23505: the account already holds a claim, so the guest one stays as is.
    if (error && error.code !== '23505' && !isMissingShopSchema(error)) {
      console.error('claimGuestShopOrders: intro claim link failed', error);
    }
  }

  return { claimed, earned };
}
