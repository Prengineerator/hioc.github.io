import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { claimGuestOrders, claimGuestOrdersByEmail, claimGuestShopOrders } from '@/lib/account/claim';
import { verifiedEmailOf } from '@/lib/account/history';

export const dynamic = 'force-dynamic';

// POST /api/account/claim — guest-order claim (ACC-4). Called by
// app/login/page.tsx right after any successful login (and by checkout after
// a guest verifies their number). Links past guest orders (user_id null) onto
// the caller's account when they were placed with the caller's VERIFIED phone
// (profiles.phone_verified) or VERIFIED login email (Supabase Auth
// email_confirmed_at), café and shop orders alike (`shop_claimed` counts the
// shop ones; `claimed` is the total). No-ops (0 claimed) when the caller has neither.
export async function POST() {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const admin = createAdminSupabaseClient();
  const { data: profile, error } = await admin
    .from('profiles')
    .select('phone, phone_verified')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    return errorResponse(500, 'Failed to load profile');
  }

  const byPhone =
    profile?.phone_verified && profile.phone
      ? await claimGuestOrders(admin, user.id, profile.phone)
      : 0;
  const verifiedEmail = verifiedEmailOf(user);
  const byEmail = await claimGuestOrdersByEmail(admin, user.id, verifiedEmail);
  // Shop orders (docs/SHOP-V2-SPEC.md E4): same verified keys, own table.
  const shop = await claimGuestShopOrders(admin, user.id, {
    phone: profile?.phone_verified && profile.phone ? profile.phone : null,
    email: verifiedEmail,
  });
  return NextResponse.json({ claimed: byPhone + byEmail + shop.claimed, shop_claimed: shop.claimed });
}
