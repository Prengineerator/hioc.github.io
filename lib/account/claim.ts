import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

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
