import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// POST /api/auth/login — public (this IS the login action).
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { email, password } = body;
  if (typeof email !== 'string' || email.trim().length === 0) {
    return errorResponse(400, 'email is required and must be a non-empty string');
  }
  if (typeof password !== 'string' || password.length === 0) {
    return errorResponse(400, 'password is required and must be a non-empty string');
  }

  // Cookie-bound server client — signInWithPassword writes the resulting
  // session tokens back out as Set-Cookie headers via the cookies() adapter
  // in lib/supabase-server.ts (the @supabase/ssr cookie-writing pattern).
  const supabase = createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return errorResponse(401, 'Invalid email or password');
  }

  return NextResponse.json({ success: true });
}
