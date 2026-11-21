// /account/rewards — Rewards inside the account shell (ACC nav stays visible).
// The /account layout already guards the session; this page trusts it and
// renders the same content as the standalone /rewards page, minus its own
// session-gate (the layout handles that).

import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import { getAuthUser } from '@/lib/api/auth';
import { getBalance, getLoyaltyConfig, getRecentTransactions } from '@/lib/loyalty/ledger';
import { BagIcon } from '@/components/account/ShopOrderRow';
import { Badge } from '@/components/ui/Badge';
import { splitShopRefFromNote } from '@/lib/account/orderDisplay';
import { LOYALTY_UNIT, beaniesLabel, beaniesTagline, beaniesUnit } from '@/lib/loyalty/brand';
import type { LoyaltyConfig, LoyaltyTransaction } from '@/lib/types';

export const metadata: Metadata = { title: 'Rewards' };

export const dynamic = 'force-dynamic';

export default async function AccountRewardsPage() {
  // The layout already redirects unauthenticated users, but getAuthUser is
  // needed here to pass the user id to the data fetchers below.
  const user = await getAuthUser();
  if (!user) return null;

  const [config, balance, transactions] = await Promise.all([
    getLoyaltyConfig(),
    getBalance(user.id),
    getRecentTransactions(user.id, 25),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Rewards</h1>
        {config ? (
          <p className="mt-1 text-sm text-muted">{beaniesTagline(Number(config.inr_per_point))}</p>
        ) : null}
      </div>

      <div className="rounded-md border border-line bg-cream p-6 text-center shadow-sm">
        <p className="text-sm text-muted">Your balance</p>
        <p className="mt-1 font-mono text-4xl font-bold tabular-nums text-tan-dark">{beaniesLabel(balance)}</p>
        {config ? (
          <p className="mt-2 text-sm text-muted">
            About <span className="font-mono tabular-nums">₹{Math.floor(balance * config.inr_per_point)}</span> in
            redeemable value
          </p>
        ) : null}
      </div>

      <HowItWorks config={config} />

      <div>
        <h2 className="mb-3 text-lg font-semibold text-charcoal">History</h2>
        {transactions.length === 0 ? (
          <EmptyState
            icon=""
            heading="No Beanies activity yet"
            body="Place an order and your Beanies will show up here."
            action={
              <Link href="/menu" className={buttonVariants()}>
                Browse the menu
              </Link>
            }
          />
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
      <p className="text-center text-sm text-muted">
        The loyalty program isn&apos;t set up yet. Check back soon.
      </p>
    );
  }
  const earnPct = Number((Number(config.points_per_inr) * 100).toFixed(2));
  return (
    <div className="rounded-md border border-line bg-cream p-6 shadow-sm">
      <h2 className="mb-2 text-base font-semibold text-charcoal">How Beanies work</h2>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-charcoal">
        <li>
          Earn {earnPct}% of every completed, paid order back as {LOYALTY_UNIT.many} (₹100 = {earnPct} {beaniesUnit(earnPct)}).
        </li>
        <li>Redeem {LOYALTY_UNIT.many} for ₹{Number(config.inr_per_point)} each at checkout.</li>
        <li>Minimum {beaniesLabel(config.min_redeem_points)} to redeem.</li>
        <li>Redemption is capped at {config.max_redeem_pct}% of your bill.</li>
        {config.points_expiry_days > 0 ? (
          <li>{LOYALTY_UNIT.many} expire {config.points_expiry_days} days after they&apos;re earned.</li>
        ) : (
          <li>{LOYALTY_UNIT.many} never expire.</li>
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
  const shopNote = tx.shop_order_id ? splitShopRefFromNote(tx.note) : null;
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-line bg-cream px-4 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold capitalize text-charcoal">
          {tx.type}
          {tx.shop_order_id ? (
            <Badge variant="neutral" className="normal-case">
              <BagIcon />
              Shop
            </Badge>
          ) : null}
        </p>
        <p className="text-sm text-muted">
          {dateLabel}
          {shopNote ? (
            <>
              , {shopNote.before}
              <Link href={`/shop/order/${tx.shop_order_id}`} className="font-mono tabular-nums text-tan-dark underline">
                {shopNote.ref}
              </Link>
              {shopNote.after}
            </>
          ) : tx.note ? (
            `, ${tx.note}`
          ) : (
            ''
          )}
        </p>
      </div>
      <span className={'shrink-0 font-mono font-bold tabular-nums ' + (positive ? 'text-green-700' : 'text-red-700')}>
        {positive ? '+' : ''}
        {tx.points}
      </span>
    </li>
  );
}
