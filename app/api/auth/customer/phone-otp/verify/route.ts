import { NextResponse } from 'next/server';
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { normalizeIndianMobile } from '@/lib/phone';

export const dynamic = 'force-dynamic';

// POST /api/auth/customer/phone-otp/verify — public (ACC-1). Verifies the
// 6-digit SMS code and, on success, sets session cookies via the
// cookie-bound SSR client (same Set-Cookie pattern as
// /api/auth/customer/otp/verify), then records the now-verified phone on the
// caller's profile row (server-side, admin client — NEVER touches `role`).
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { phone, token } = body;
  if (typeof phone !== 'string' || phone.trim().length === 0) {
    return errorResponse(400, 'phone is required and must be a non-empty string');
  }
  if (typeof token !== 'string' || token.trim().length === 0) {
    return errorResponse(400, 'token is required and must be a non-empty string');
  }
  const normalized = normalizeIndianMobile(phone);
  if (!normalized) {
    return errorResponse(400, 'phone must be a valid 10-digit Indian mobile number');
  }
  const e164 = `+91${normalized}`;

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.auth.verifyOtp({
    phone: e164,
    token: token.trim(),
    type: 'sms',
  });

  if (error || !data.user) {
    return errorResponse(401, 'Invalid or expired code');
  }

  // The phone+token pair just validated for exactly `e164` above, so it's
  // safe to record it as verified — using our own normalized value (rather
  // than re-deriving from data.user.phone) guarantees the format matches
  // orders.customer_phone ("+91XXXXXXXXXX") for guest-claim matching (ACC-4).
  const admin = createAdminSupabaseClient();
  const { error: profileError } = await admin
    .from('profiles')
    .update({ phone: e164, phone_verified: true })
    .eq('id', data.user.id);

  if (profileError) {
    // Non-fatal — the session is valid either way; log so a drifted profile
    // row is diagnosable rather than silently wrong.
    console.error('phone-otp verify: profile update failed', profileError);
  }

  return NextResponse.json({ success: true });
}
