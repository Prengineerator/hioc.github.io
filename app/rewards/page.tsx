// Customer Rewards page (LOY-1/CUS-067). Server component: reads the caller's
// session + loyalty ledger directly (no client fetch waterfall needed for a
// read-only, per-request-dynamic page). Mirrors the owner dashboard's
// "server component + admin/lib reads" convention.

import Link from 'next/link';
import { getAuthUser } from '@/lib/api/auth';
import { getBalance, getLoyaltyConfig, getRecentTransactions } from '@/lib/loyalty/ledger';
import { LOYALTY_UNIT, beaniesLabel, beaniesTagline, beaniesUnit } from '@/lib/loyalty/brand';
import type { LoyaltyConfig, LoyaltyTransaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function RewardsPage() {
  const user = await getAuthUser();

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Rewards</h1>
        <p className="mt-4 text-muted">Log in to see your Beanies balance and history.</p>
        <Link
          href="/login?next=/rewards"
          className="mt-6 inline-block rounded-md bg-tan-dark px-6 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker"
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
      {config ? (
        <p className="mt-1 text-sm text-muted">{beaniesTagline(Number(config.inr_per_point))}</p>
      ) : null}

      <div className="mt-6 rounded-md border border-line bg-cream p-6 text-center shadow-sm">
        <p className="text-xs uppercase tracking-wide text-muted">Your balance</p>
        <p className="mt-1 font-mono text-4xl font-bold tabular-nums text-tan-dark">{beaniesLabel(balance)}</p>
        {config ? (
          <p className="mt-2 text-sm text-muted">
            ≈ <span className="font-mono tabular-nums">₹{Math.floor(balance * config.inr_per_point)}</span> in
            redeemable value
          </p>
        ) : null}
      </div>

      <HowItWorks config={config} />

      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-charcoal">History</h2>
        {transactions.length === 0 ? (
          <p className="rounded-md border border-line bg-cream p-6 text-center text-sm text-muted">
            No Beanies activity yet — place an order to start earning.
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
  // points_per_inr × 100 is both the % back and the points per ₹100; rounded to
  // dodge float noise (0.07 × 100 = 7.000000000000001).
  const earnPct = Number((Number(config.points_per_inr) * 100).toFixed(2));
  return (
    <div className="mt-6 rounded-md border border-line bg-cream p-6 shadow-sm">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-charcoal">How Beanies work</h2>
      <ul className="flex flex-col gap-1 text-sm text-charcoal">
        <li>
          • Earn {earnPct}% of every completed, paid order back as {LOYALTY_UNIT.many} (₹100 = {earnPct} {beaniesUnit(earnPct)}).
        </li>
        <li>• Redeem {LOYALTY_UNIT.many} for ₹{Number(config.inr_per_point)} each at checkout.</li>
        <li>• Minimum {beaniesLabel(config.min_redeem_points)} to redeem.</li>
        <li>• Redemption is capped at {config.max_redeem_pct}% of your bill.</li>
        {config.points_expiry_days > 0 ? (
          <li>• {LOYALTY_UNIT.many} expire {config.points_expiry_days} days after they&apos;re earned.</li>
        ) : (
          <li>• {LOYALTY_UNIT.many} never expire.</li>
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
    <li className="flex items-center justify-between rounded-md border border-line bg-cream px-4 py-3">
      <div>
        <p className="text-sm font-semibold capitalize text-charcoal">{tx.type}</p>
        <p className="text-sm text-muted">
          {dateLabel}
          {tx.note ? ` · ${tx.note}` : ''}
        </p>
      </div>
      <span className={'shrink-0 font-mono font-bold tabular-nums ' + (positive ? 'text-green-600' : 'text-red-600')}>
        {positive ? '+' : ''}
        {tx.points}
      </span>
    </li>
  );
}
