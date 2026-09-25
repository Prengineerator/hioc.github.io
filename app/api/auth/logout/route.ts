import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { unauthorized } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// POST /api/auth/logout — any authenticated user, staff or customer (must
// have a session to log out of).
export async function POST() {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  // Cookie-bound server client — signOut() clears the session cookies via
  // the same cookies() adapter used to set them at login.
  //
  // scope: 'local' — the default scope is 'global', which revokes every
  // refresh token this user holds on EVERY device: signing out in Chrome
  // would silently kill the Electron POS app's session (and vice versa).
  // Logins are meant to be independent per device (owner request, Phase 7);
  // 'local' clears only the cookie-bound session this request is using.
  const supabase = createServerSupabaseClient();
  await supabase.auth.signOut({ scope: 'local' });

  return NextResponse.json({ success: true });
}
