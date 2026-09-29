import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/http';
import { expireLoyaltyPoints } from '@/lib/loyalty/ledger';

export const dynamic = 'force-dynamic';

// Loyalty points expiry. The Rewards page promises "points expire N days after
// they're earned" (loyalty_config.points_expiry_days); this is the job that
// keeps that promise by writing 'expire' rows into the ledger.
//
// Safe to run repeatedly — expireLoyaltyPoints() treats earlier expire rows as
// spent credit, so a retried or twice-run cron writes nothing the second time.
// A no-op when points_expiry_days is 0 (never expire).
//
// Protected by CRON_SECRET, fails CLOSED when unset.

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const { users, points } = await expireLoyaltyPoints();
  return NextResponse.json({ users, points });
}
