import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// POST /api/auth/customer/otp/request — public. Sends a 6-digit email
// code, creating a new (customer-role, via the profiles trigger) account
// if none exists for this email yet.
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { email } = body;
  if (typeof email !== 'string' || email.trim().length === 0) {
    return errorResponse(400, 'email is required and must be a non-empty string');
  }

  const supabase = createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: true },
  });

  if (error) {
    return errorResponse(400, error.message);
  }

  return NextResponse.json({ success: true });
}
