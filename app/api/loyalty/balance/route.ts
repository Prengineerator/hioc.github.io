import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/api/auth';
import { unauthorized } from '@/lib/api/http';
import { getBalance, getRecentTransactions } from '@/lib/loyalty/ledger';

export const dynamic = 'force-dynamic';

// GET /api/loyalty/balance — any logged-in customer (or staff/owner). Returns
// the caller's own points balance + recent ledger entries (LOY-1 Rewards
// page; also usable by checkout to show "you have N points").
//   { balance: number, transactions: LoyaltyTransaction[] }
export async function GET() {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  const [balance, transactions] = await Promise.all([
    getBalance(user.id),
    getRecentTransactions(user.id, 20),
  ]);

  return NextResponse.json({ balance, transactions });
}
