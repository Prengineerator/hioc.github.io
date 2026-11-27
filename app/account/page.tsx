'use client';

// Account landing page. "Simpler account" (docs/SHOP-V2-SPEC.md E4): four clear
// tiles — Orders, Addresses, Beanies (balance + what it is worth), Profile —
// with Favourites (and HIOC Ritual while that flag is on) as secondary links.
// Above them an "Active order" callout for a café order in flight and, when the
// shop is on, one for an undelivered shop parcel ("Your coffee is on its way").
// Below, the 3 most recent orders from both channels, each with a channel badge.
//
// Client component: it reads the caller's own history from GET
// /api/account/history (channel=all, or cafe while the shop flag is off) and
// the Beanies balance and rate from /api/loyalty/balance and /config.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import {
  ORDER_STATUS_BADGE_CLASS,
  activeOrderSentence,
  activeShopSentence,
  beaniesWorth,
  formatIstDate,
  isActiveOrderStatus,
  orderStatusLabel,
  orderTypeLabel,
} from '@/lib/account/orderDisplay';
import { CUSTOMER_STATUS_LABEL, isActiveShopStatus, shopOrderRef } from '@/lib/shop/status';
import { rupees } from '@/lib/shop/pricing';
import { beaniesLabel } from '@/lib/loyalty/brand';
import { Spinner } from '@/components/ui/Spinner';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { TasteProfileCard } from '@/components/account/TasteProfileCard';
import { CafeChannelBadge, ShopChannelBadge } from '@/components/account/ShopOrderRow';
import { flags } from '@/lib/flags';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import type { AccountHistoryItem } from '@/lib/account/historyTypes';
import type { OrderResponse } from '@/lib/api/orders';

type ShopItem = Extract<AccountHistoryItem, { channel: 'shop' }>;

const ICON = { 'aria-hidden': true, viewBox: '0 0 24 24', fill: 'none', className: 'h-6 w-6 text-tan-dark' } as const;
const STROKE = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const TILE_ICONS = {
  orders: (
    <svg {...ICON}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" {...STROKE} />
    </svg>
  ),
  addresses: (
    <svg {...ICON}>
      <path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z" {...STROKE} />
      <circle cx="12" cy="10" r="2.5" {...STROKE} />
    </svg>
  ),
  beanies: (
    <svg {...ICON}>
      <ellipse cx="12" cy="12" rx="6" ry="8.5" transform="rotate(35 12 12)" {...STROKE} />
      <path d="M8 6c3 2 5 6 8 12" {...STROKE} />
    </svg>
  ),
  profile: (
    <svg {...ICON}>
      <circle cx="12" cy="8" r="4" {...STROKE} />
      <path d="M4 21c1-4 4-6 8-6s7 2 8 6" {...STROKE} />
    </svg>
  ),
};

const TILE_CLASS =
  'flex min-h-[88px] flex-col justify-between gap-2 rounded-md border border-line bg-cream p-4 shadow-sm transition-colors hover:border-tan focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan';

function Tile({ href, icon, title, children }: { href: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Link href={href} className={TILE_CLASS}>
      <span className="flex items-center gap-2">
        {icon}
        <span className="font-semibold text-charcoal">{title}</span>
      </span>
      <span className="text-sm text-muted">{children}</span>
    </Link>
  );
}

type Beanies = { state: 'loading' } | { state: 'error' } | { state: 'ready'; balance: number; inrPerPoint: number | null };

export default function AccountHomePage() {
  // null = still loading; [] = loaded, no orders yet.
  const [items, setItems] = useState<AccountHistoryItem[] | null>(null);
  const [beanies, setBeanies] = useState<Beanies>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // channel=all only matters once the shop is on; until then the account is café-only.
    fetch(`/api/account/history?page=1&channel=${flags.shop ? 'all' : 'cafe'}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setItems(
          data?.items ??
            (data?.orders ?? []).map((o: OrderResponse): AccountHistoryItem => ({
              channel: 'cafe',
              id: o.id,
              created_at: o.created_at,
              order: o,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadBeanies = useCallback(async (isCancelled: () => boolean = () => false) => {
    setBeanies({ state: 'loading' });
    try {
      const [balRes, cfgRes] = await Promise.all([
        fetch('/api/loyalty/balance', { cache: 'no-store' }),
        fetch('/api/loyalty/config', { cache: 'no-store' }).catch(() => null),
      ]);
      if (!balRes.ok) throw new Error('balance');
      const bal = (await balRes.json()) as { balance?: number };
      const cfg = cfgRes && cfgRes.ok ? ((await cfgRes.json().catch(() => null)) as { config?: { inr_per_point?: number } | null } | null) : null;
      const rate = Number(cfg?.config?.inr_per_point);
      if (!isCancelled()) {
        setBeanies({
          state: 'ready',
          balance: Number(bal.balance) || 0,
          inrPerPoint: Number.isFinite(rate) && rate > 0 ? rate : null,
        });
      }
    } catch {
      if (!isCancelled()) setBeanies({ state: 'error' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadBeanies(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadBeanies]);

  // The most recent page (10 orders) is more than enough to find any order
  // still in flight — a customer realistically never has more than one or
  // two active at once.
  const activeOrder =
    items?.find((i) => i.channel === 'cafe' && isActiveOrderStatus(i.order.status)) ?? null;
  const activeShop =
    (flags.shop ? items?.find((i): i is ShopItem => i.channel === 'shop' && isActiveShopStatus(i.order.status)) : null) ?? null;
  const recent = items?.slice(0, 3) ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">My account</h1>
        <p className="mt-1 text-sm text-muted">Orders, addresses, Beanies and your details, in one place.</p>
      </div>

      {activeOrder && activeOrder.channel === 'cafe' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-tan bg-surface px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-tan-dark">{orderStatusLabel(activeOrder.order)}</p>
            <p className="truncate text-sm font-bold text-charcoal">
              Order #<span className="font-mono tabular-nums">{formatOrderNumber(activeOrder.order.order_number)}</span>{' '}
              {activeOrderSentence(activeOrder.order)}
            </p>
          </div>
          <Link
            href={`/order/${activeOrder.order.id}`}
            className="inline-flex min-h-[44px] shrink-0 items-center rounded-md bg-tan-dark px-4 text-sm font-semibold text-cream hover:bg-tan-darker"
          >
            Track
          </Link>
        </div>
      ) : null}

      {activeShop ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-tan bg-surface px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-tan-dark">{CUSTOMER_STATUS_LABEL[activeShop.order.status]}</p>
            <p className="text-sm font-bold text-charcoal">
              {activeShopSentence(activeShop.order)}
              <span className="font-normal text-muted">
                {' '}
                ·{' '}
                <span className="font-mono tabular-nums">{shopOrderRef(activeShop.order.order_number)}</span>
              </span>
            </p>
          </div>
          {activeShop.order.awb_code && activeShop.order.tracking_url ? (
            <a
              href={activeShop.order.tracking_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[44px] shrink-0 items-center rounded-md bg-tan-dark px-4 text-sm font-semibold text-cream hover:bg-tan-darker"
            >
              Track<span className="sr-only"> your parcel (opens in a new tab)</span>
            </a>
          ) : (
            <Link
              href={`/shop/order/${activeShop.order.id}`}
              className="inline-flex min-h-[44px] shrink-0 items-center rounded-md bg-tan-dark px-4 text-sm font-semibold text-cream hover:bg-tan-darker"
            >
              View
            </Link>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Tile href="/account/orders" icon={TILE_ICONS.orders} title="Orders">
          {flags.shop ? 'Café and shop, track and reorder' : 'Track and reorder'}
        </Tile>
        <Tile href="/account/addresses" icon={TILE_ICONS.addresses} title="Addresses">
          Saved for one-tap checkout
        </Tile>

        <div className={TILE_CLASS}>
          <Link
            href="/account/rewards"
            className="flex flex-1 flex-col justify-between gap-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
          >
            <span className="flex items-center gap-2">
              {TILE_ICONS.beanies}
              <span className="font-semibold text-charcoal">Beanies</span>
            </span>
            <span className="text-sm text-muted" aria-live="polite">
              {beanies.state === 'loading' ? (
                <>
                  <span className="sr-only">Loading your Beanies balance</span>
                  <Skeleton className="h-5 w-24" />
                </>
              ) : beanies.state === 'error' ? (
                'See your balance and history'
              ) : (
                <>
                  <span className="font-mono font-bold tabular-nums text-charcoal">{beaniesLabel(beanies.balance)}</span>
                  {beanies.inrPerPoint ? (
                    <>
                      {', worth '}
                      <span className="font-mono tabular-nums">{beaniesWorth(beanies.balance, beanies.inrPerPoint)}</span>
                    </>
                  ) : null}
                </>
              )}
            </span>
          </Link>
          {beanies.state === 'error' ? (
            <button
              type="button"
              onClick={() => void loadBeanies()}
              className="inline-flex min-h-[44px] items-center self-start text-sm font-semibold text-tan-dark hover:underline"
            >
              Couldn&apos;t load balance. Retry
            </button>
          ) : null}
        </div>

        <Tile href="/account/profile" icon={TILE_ICONS.profile} title="Profile">
          Name, phone, email, offers
        </Tile>
      </div>

      <div className="flex flex-wrap gap-x-5">
        <Link href="/account/favorites" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline">
          Favourites
        </Link>
        {/* HIOC Ritual (docs/COFFEE-PASS-SPEC.md): only while the feature is on. */}
        {flags.coffeePass ? (
          <Link href="/account/ritual" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline">
            {PASS_PROGRAM_NAME}
          </Link>
        ) : null}
      </div>

      {items === null ? (
        <Spinner label="Loading your orders…" size="sm" />
      ) : recent.length === 0 ? (
        <EmptyState
          icon=""
          heading="No orders yet"
          body="Your orders will show up here once you place one."
          action={
            <Link href="/menu" className={buttonVariants()}>
              Browse the menu
            </Link>
          }
        />
      ) : (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold text-charcoal">Recent orders</h2>
            <Link href="/account/orders" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline">
              View all
            </Link>
          </div>
          <ul className="flex flex-col gap-2">
            {recent.map((item) =>
              item.channel === 'shop' ? (
                <li key={item.id}>
                  <Link
                    href={`/shop/order/${item.order.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-cream p-3 shadow-sm transition-colors hover:border-tan"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm font-bold tabular-nums text-charcoal">
                        {shopOrderRef(item.order.order_number)}
                      </p>
                      <p className="text-sm text-muted">{formatIstDate(item.order.created_at)}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <ShopChannelBadge city={item.order.city} />
                      <span className="flex items-center gap-2">
                        <Badge variant="outline">{CUSTOMER_STATUS_LABEL[item.order.status]}</Badge>
                        <span className="font-mono text-sm font-bold tabular-nums text-charcoal">{rupees(item.order.total_inr)}</span>
                      </span>
                    </div>
                  </Link>
                </li>
              ) : (
                <li key={item.id}>
                  <Link
                    href={`/order/${item.order.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-cream p-3 shadow-sm transition-colors hover:border-tan"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm font-bold tabular-nums text-charcoal">
                        #{formatOrderNumber(item.order.order_number)}
                      </p>
                      <p className="text-sm text-muted">
                        {formatIstDate(item.order.created_at)}, {formatIstTime(new Date(item.order.created_at))}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <CafeChannelBadge detail={orderTypeLabel(item.order)} />
                      <span className="flex items-center gap-2">
                        <span
                          className={'rounded-full px-2 py-0.5 text-xs font-semibold ' + ORDER_STATUS_BADGE_CLASS[item.order.status]}
                        >
                          {orderStatusLabel(item.order)}
                        </span>
                        <span className="font-mono text-sm font-bold tabular-nums text-charcoal">
                          ₹{item.order.total_inr ?? item.order.subtotal_inr}
                        </span>
                      </span>
                    </div>
                  </Link>
                </li>
              ),
            )}
          </ul>
        </div>
      )}

      {flags.suggest ? <TasteProfileCard /> : null}
    </div>
  );
}
