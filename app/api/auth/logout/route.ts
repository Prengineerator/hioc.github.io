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
  const supabase = createServerSupabaseClient();
  await supabase.auth.signOut();

  return NextResponse.json({ success: true });
}
