import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// POST /api/auth/customer/otp/verify — public. Verifies the 6-digit code
// and, on success, sets session cookies via the cookie-bound SSR client
// (same Set-Cookie pattern as /api/auth/login).
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { email, token } = body;
  if (typeof email !== 'string' || email.trim().length === 0) {
    return errorResponse(400, 'email is required and must be a non-empty string');
  }
  if (typeof token !== 'string' || token.trim().length === 0) {
    return errorResponse(400, 'token is required and must be a non-empty string');
  }

  const supabase = createServerSupabaseClient();
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: token.trim(),
    type: 'email',
  });

  if (error) {
    return errorResponse(401, 'Invalid or expired code');
  }

  return NextResponse.json({ success: true });
}
