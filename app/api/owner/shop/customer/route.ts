import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { normalizeIndianMobile } from '@/lib/phone';
import { lookupOwnerCustomer } from '@/lib/shop/ownerCustomer';

export const dynamic = 'force-dynamic';

// GET /api/owner/shop/customer?phone=<10 digits or +91…> — owner only (401 otherwise).
// What the New order page offers for a returning customer. Read only, for that one number.
// 200 { name, email, account_linked, addresses: [{ label, customer_name, phone,
//   address_line1, address_line2, landmark, city, state, pincode, source: 'saved' | 'last_order' }] }
// The addresses are the saved ones of the account holding this phone VERIFIED, then the
// address on this phone's latest paid shop order (left out when it is the same place).
// 400 { error } for a number that is not a 10-digit Indian mobile.
export async function GET(request: Request) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!(await rateLimitOk(`owner-shop-customer:${clientIp(request)}`, 60, 600))) {
    return errorResponse(429, 'Too many tries — please wait a few minutes.');
  }
  const raw = new URL(request.url).searchParams.get('phone') ?? '';
  const digits = normalizeIndianMobile(raw);
  if (!digits) return errorResponse(400, 'Enter a 10-digit Indian mobile number');

  const found = await lookupOwnerCustomer(createAdminSupabaseClient(), `+91${digits}`);
  const { user_id: _userId, ...safe } = found;
  void _userId;
  return NextResponse.json(safe, { headers: { 'Cache-Control': 'no-store' } });
}
