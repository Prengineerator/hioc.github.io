import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { claimGuestOrders } from '@/lib/account/claim';

export const dynamic = 'force-dynamic';

// POST /api/account/claim — guest-order claim (ACC-4). Called by
// app/login/page.tsx right after any successful login. If the caller has a
// VERIFIED phone on their profile, links any past guest orders placed with
// that number (customer_phone match, user_id null) onto their account.
// No-ops (0 claimed) for a caller with no verified phone yet.
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

  if (!profile?.phone_verified || !profile.phone) {
    return NextResponse.json({ claimed: 0 });
  }

  const claimed = await claimGuestOrders(admin, user.id, profile.phone);
  return NextResponse.json({ claimed });
}
