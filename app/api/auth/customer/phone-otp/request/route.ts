import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { normalizeIndianMobile } from '@/lib/phone';

export const dynamic = 'force-dynamic';

// POST /api/auth/customer/phone-otp/request — public (ACC-1). Sends a 6-digit
// SMS code to an Indian mobile number, creating a new (customer-role, via the
// profiles trigger) account if none exists for this phone yet. Mirrors
// app/api/auth/customer/otp/request/route.ts's email-OTP flow.
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { phone } = body;
  if (typeof phone !== 'string' || phone.trim().length === 0) {
    return errorResponse(400, 'phone is required and must be a non-empty string');
  }
  const normalized = normalizeIndianMobile(phone);
  if (!normalized) {
    return errorResponse(400, 'phone must be a valid 10-digit Indian mobile number');
  }
  const e164 = `+91${normalized}`;

  const supabase = createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    phone: e164,
    options: { shouldCreateUser: true },
  });

  if (error) {
    return errorResponse(400, error.message);
  }

  return NextResponse.json({ success: true, phone: e164 });
}
