import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api/auth';

export const dynamic = 'force-dynamic';

// GET /api/auth/me — public. Lets client components (e.g. AccountNav) read
// the current session without forcing the whole app into dynamic
// server-rendering the way reading cookies() in the root layout would.
export async function GET() {
  const user = await getAuthUser();
  return NextResponse.json({ user: user ? { email: user.email ?? null } : null });
}
