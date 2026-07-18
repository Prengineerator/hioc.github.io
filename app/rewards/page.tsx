// Customer Rewards page (LOY-1/CUS-067). Server component: reads the caller's
// session + loyalty ledger directly (no client fetch waterfall needed for a
// read-only, per-request-dynamic page). Mirrors the owner dashboard's
// "server component + admin/lib reads" convention.

import Link from 'next/link';
import { getAuthUser } from '@/lib/api/auth';
import { getBalance, getLoyaltyConfig, getRecentTransactions } from '@/lib/loyalty/ledger';
import type { LoyaltyConfig, LoyaltyTransaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function RewardsPage() {
  const user = await getAuthUser();

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Rewards</h1>
        <p className="mt-4 text-muted">Log in to see your points balance and history.</p>
        <Link
          href="/login?next=/rewards"
          className="mt-6 inline-block rounded-md bg-tan px-6 py-3 font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Log In
        </Link>
      </div>
    );
  }

  const [config, balance, transactions] = await Promise.all([
    getLoyaltyConfig(),
    getBalance(user.id),
    getRecentTransactions(user.id, 25),
  ]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-charcoal">Rewards</h1>

      <div className="mt-6 rounded-md border border-[#e5e5e5] bg-cream p-6 text-center shadow-sm">
        <p className="text-xs uppercase tracking-wide text-muted">Your balance</p>
        <p className="mt-1 text-4xl font-bold text-tan">{balance} pts</p>
        {config ? (
          <p className="mt-2 text-sm text-muted">≈ ₹{Math.floor(balance * config.inr_per_point)} in redeemable value</p>
        ) : null}
      </div>

      <HowItWorks config={config} />

      <div className="mt-8">
        <h2 className="mb-3 text-lg font-bold text-charcoal">History</h2>
        {transactions.length === 0 ? (
          <p className="rounded-md border border-[#e5e5e5] bg-cream p-6 text-center text-sm text-muted">
            No points activity yet — place an order to start earning.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {transactions.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function HowItWorks({ config }: { config: LoyaltyConfig | null }) {
  if (!config) {
    return (
      <p className="mt-6 text-center text-sm text-muted">
        The loyalty program isn&apos;t configured yet — check back soon.
      </p>
    );
  }
  return (
    <div className="mt-6 rounded-md border border-[#e5e5e5] bg-cream p-6 shadow-sm">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">How points work</h2>
      <ul className="flex flex-col gap-1 text-sm text-charcoal">
        <li>• Earn {config.points_per_inr} point(s) for every ₹1 spent on a completed, paid order.</li>
        <li>• Redeem points for ₹{config.inr_per_point} each at checkout.</li>
        <li>• Minimum {config.min_redeem_points} points to redeem.</li>
        <li>• Redemption is capped at {config.max_redeem_pct}% of your bill.</li>
        {config.points_expiry_days > 0 ? (
          <li>• Points expire {config.points_expiry_days} days after they&apos;re earned.</li>
        ) : (
          <li>• Points never expire.</li>
        )}
      </ul>
    </div>
  );
}

function TransactionRow({ tx }: { tx: LoyaltyTransaction }) {
  const positive = tx.points > 0;
  const dateLabel = new Date(tx.created_at).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return (
    <li className="flex items-center justify-between rounded-md border border-[#e5e5e5] bg-cream px-4 py-3">
      <div>
        <p className="text-sm font-bold capitalize text-charcoal">{tx.type}</p>
        <p className="text-xs text-muted">
          {dateLabel}
          {tx.note ? ` · ${tx.note}` : ''}
        </p>
      </div>
      <span className={'shrink-0 font-bold ' + (positive ? 'text-green-600' : 'text-red-600')}>
        {positive ? '+' : ''}
        {tx.points}
      </span>
    </li>
  );
}
