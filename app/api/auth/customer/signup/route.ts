import { errorResponse } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// POST /api/auth/customer/signup — RETIRED. Customers now sign in with a
// one-time code only (WhatsApp or email — /api/auth/customer/{phone-otp,otp}),
// which also creates the account on first use, so password accounts are no
// longer offered. Kept as a clear 410 rather than deleted so an old cached
// login page gets an explanation instead of a 404.
export async function POST() {
  return errorResponse(
    410,
    'Password accounts are no longer offered — sign in with a WhatsApp or email code instead.',
  );
}
