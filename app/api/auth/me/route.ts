import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

interface ProfileNamePhone {
  name: string | null;
  phone: string | null;
}

// GET /api/auth/me — public. Lets client components (e.g. AccountNav,
// AccountHeader) read the current session without forcing the whole app
// into dynamic server-rendering the way reading cookies() in the root
// layout would.
//
// Root-cause fix (owner bug report, 2026-09): a WhatsApp/phone-OTP account
// — including what guest checkout's OTP creates — has NO email. This used
// to respond with just `{ user: { email } }`, and AccountNav treated
// `!data.user?.email` as "logged out" — so a logged-in phone customer saw
// "Log In" and never saw "My Account". The shape below always carries `id`
// (proof of a real session) so callers check `data.user != null`, not any
// particular field. `email` is kept for back-compat with any other caller
// still reading it directly.
//
// `name`/`phone` come from `profiles` (admin client — profiles has no
// customer self-read policy for phone/name, only `profiles_select_own` for
// the whole row via RLS which the anon client *could* use, but the admin
// client keeps this consistent with every other account route). `phone`
// falls back to the Supabase Auth user's own `phone` (set the moment a
// phone-OTP session is created) when the profiles row hasn't been
// backfilled yet — see phone-otp/verify's profile update, which is
// best-effort and can lag a beat behind the session itself.
export async function GET() {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ user: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from('profiles')
    .select('name, phone')
    .eq('id', user.id)
    .maybeSingle();

  const row = profile as ProfileNamePhone | null;
  const name = row?.name?.trim() || null;
  const phone = row?.phone?.trim() || user.phone?.trim() || null;

  return NextResponse.json(
    {
      user: {
        id: user.id,
        email: user.email ?? null,
        phone,
        name,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
