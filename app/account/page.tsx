'use client';

// Account landing page — nav into the four sections (ACC-2/3/5), plus an
// "Active order" callout and the 3 most recent orders. Added for the owner's
// usability report: a customer landing here (especially a phone-only
// account that used to see "Log In" instead of this page at all — see
// components/site/AccountNav) had no visibility into "did my order
// actually go through" without digging into Orders.
//
// Client component (not the server-rendered page this used to be) because
// it now fetches the caller's own order history from
// GET /api/account/history, the same server-verified-session route the
// orders page uses.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import {
  ORDER_STATUS_BADGE_CLASS,
  ORDER_STATUS_LABEL,
  formatIstDate,
  isActiveOrderStatus,
} from '@/lib/account/orderDisplay';
import { Spinner } from '@/components/ui/Spinner';
import type { OrderResponse } from '@/lib/api/orders';

const SECTIONS = [
  {
    href: '/account/orders',
    title: 'Order history',
    body: 'See your past orders, track their status, and reorder in a tap.',
  },
  {
    href: '/account/favorites',
    title: 'Favorites',
    body: 'Your saved items, ready to add to cart.',
  },
  {
    href: '/rewards',
    title: 'Rewards',
    body: 'Your points balance, how to earn, and redeem history.',
  },
  {
    href: '/account/profile',
    title: 'Profile',
    body: 'Name, phone, email, default order type, and notification preferences.',
  },
];

export default function AccountHomePage() {
  // null = still loading; [] = loaded, no orders yet.
  const [orders, setOrders] = useState<OrderResponse[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/account/history?page=1', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setOrders(data?.orders ?? []);
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The most recent page (10 orders) is more than enough to find any order
  // still in flight — a customer realistically never has more than one or
  // two active at once.
  const activeOrder = orders?.find((o) => isActiveOrderStatus(o.status)) ?? null;
  const recentOrders = orders?.slice(0, 3) ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">My Account</h1>
        <p className="mt-1 text-sm text-muted">Manage your orders, favorites, and profile.</p>
      </div>

      {activeOrder ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-tan bg-[#f6efe9] px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wide text-tan">
              {ORDER_STATUS_LABEL[activeOrder.status]}
            </p>
            <p className="truncate text-sm font-bold text-charcoal">
              Order #{formatOrderNumber(activeOrder.order_number)} is on its way
            </p>
          </div>
          <Link
            href={`/order/${activeOrder.id}`}
            className="inline-flex min-h-[40px] shrink-0 items-center rounded-md bg-tan px-4 text-sm font-bold text-cream hover:bg-tan-dark"
          >
            Track
          </Link>
        </div>
      ) : null}

      {orders === null ? (
        <Spinner label="Loading your orders…" size="sm" />
      ) : recentOrders.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-bold text-charcoal">Recent orders</h2>
            <Link href="/account/orders" className="text-sm font-bold text-tan hover:underline">
              View all
            </Link>
          </div>
          <ul className="flex flex-col gap-2">
            {recentOrders.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/order/${order.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#e5e5e5] bg-cream p-3 shadow-sm transition-colors hover:border-tan"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-charcoal">
                      #{formatOrderNumber(order.order_number)}
                    </p>
                    <p className="text-xs text-muted">
                      {formatIstDate(order.created_at)} · {formatIstTime(new Date(order.created_at))}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={
                        'rounded-full px-2 py-0.5 text-xs font-bold ' + ORDER_STATUS_BADGE_CLASS[order.status]
                      }
                    >
                      {ORDER_STATUS_LABEL[order.status]}
                    </span>
                    <span className="text-sm font-bold text-charcoal">
                      ₹{order.total_inr ?? order.subtotal_inr}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm transition-colors hover:border-tan"
          >
            <h2 className="font-bold text-charcoal">{s.title}</h2>
            <p className="mt-1 text-sm text-muted">{s.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
