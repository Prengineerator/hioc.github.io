'use client';

// Order history (ACC-2) + reorder (ACC-4). Client component: fetches the
// caller's own orders from /api/account/history (server-verified session),
// and "Order again" loads a past order's lines into the cart via
// /api/account/reorder/[orderId] then routes to /checkout.
//
// Active/Past tabs (ACC-2 usability pass): the route's optional
// `status=active|past` query param does the filtering server-side, in the
// merged id query, so pagination (`total`/`hasMore`) is correct WITHIN a
// tab rather than being computed over the whole unfiltered history and then
// sliced client-side.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CartProvider } from '@/lib/cart/CartContext';
import { useReorder } from '@/lib/account/useReorder';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import {
  ORDER_STATUS_BADGE_CLASS,
  ORDER_STATUS_LABEL,
  formatIstDate,
  isActiveOrderStatus,
  orderTypeLabel,
} from '@/lib/account/orderDisplay';
import { Spinner } from '@/components/ui/Spinner';
import type { OrderResponse } from '@/lib/api/orders';

type Tab = 'active' | 'past';

interface HistoryResponse {
  orders: OrderResponse[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  phoneVerified: boolean;
}

export default function AccountOrdersPage() {
  return (
    <CartProvider>
      <AccountOrdersContent />
    </CartProvider>
  );
}

function AccountOrdersContent() {
  const router = useRouter();
  const { reorder, reorderingId } = useReorder();

  // null tab = still deciding which one to default to (initial load).
  const [tab, setTab] = useState<Tab | null>(null);
  const [orders, setOrders] = useState<OrderResponse[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Whether the account's own profile phone is verified — echoed back by
  // /api/account/history alongside `orders`, so a not-yet-verified customer
  // can be pointed at the one thing that would surface their counter
  // orders (VERIFY-2). Shown up top whenever it's false, not just when the
  // list happens to be empty — a customer with SOME orders visible may
  // still be missing counter orders placed under an unverified number.
  const [phoneVerified, setPhoneVerified] = useState(true);

  const [notice, setNotice] = useState<string>('');

  const fetchPage = useCallback(async (t: Tab, p: number): Promise<HistoryResponse | null> => {
    const res = await fetch(`/api/account/history?page=${p}&status=${t}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  }, []);

  const applyPage = useCallback((t: Tab, p: number, data: HistoryResponse) => {
    setTab(t);
    setPage(p);
    setOrders(data.orders ?? []);
    setPageSize(data.pageSize ?? 10);
    setTotal(data.total ?? 0);
    setHasMore(Boolean(data.hasMore));
    setPhoneVerified(Boolean(data.phoneVerified));
  }, []);

  const load = useCallback(
    async (t: Tab, p: number) => {
      setLoading(true);
      setError('');
      try {
        const data = await fetchPage(t, p);
        if (!data) {
          setError('Could not load your orders.');
          return;
        }
        applyPage(t, p, data);
      } catch {
        setError('Network error — please try again.');
      } finally {
        setLoading(false);
      }
    },
    [applyPage, fetchPage],
  );

  // Initial load: default to the Active tab if it has anything in it, else
  // Past — so a customer with an order in flight lands straight on it, and
  // one with no active orders isn't shown an empty "Active" tab first.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const activeData = await fetchPage('active', 1);
        if (cancelled) return;
        if (!activeData) {
          setError('Could not load your orders.');
          return;
        }
        if (activeData.total > 0) {
          applyPage('active', 1, activeData);
          return;
        }
        const pastData = await fetchPage('past', 1);
        if (cancelled) return;
        applyPage('past', 1, pastData ?? activeData);
      } catch {
        if (!cancelled) setError('Network error — please try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to the top on every page/tab change — without this, switching
  // pages while scrolled down leaves the new page's top card off-screen.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [tab, page]);

  function switchTab(t: Tab) {
    if (t !== tab) load(t, 1);
  }

  async function handleReorder(orderId: string) {
    setNotice('');
    const result = await reorder(orderId);
    if (!result.ok) {
      setNotice(result.error ?? 'Could not reorder this order.');
      return;
    }
    if (result.notice) {
      // Small delay so the notice is readable before we navigate away.
      setNotice(result.notice);
      setTimeout(() => router.push('/checkout'), 1500);
    } else {
      router.push('/checkout');
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold text-charcoal">Your Orders</h1>

      {phoneVerified ? null : (
        <div className="rounded-md border border-[#e5e5e5] bg-[#f6efe9] px-4 py-3 text-sm text-charcoal">
          Placed an order at the counter?{' '}
          <Link href="/account/profile" className="font-bold text-tan hover:underline">
            Verify your WhatsApp number
          </Link>{' '}
          to see it here.
        </div>
      )}

      {notice ? (
        <div className="rounded-md border border-[#e5e5e5] bg-[#f6efe9] px-4 py-3 text-sm text-charcoal">
          {notice}
        </div>
      ) : null}

      <div className="flex gap-1 rounded-md border border-[#e5e5e5] p-1 text-sm">
        <button
          type="button"
          onClick={() => switchTab('active')}
          className={
            'flex min-h-[40px] flex-1 items-center justify-center rounded px-3 font-bold transition-colors ' +
            (tab === 'active' ? 'bg-tan text-cream' : 'text-charcoal')
          }
        >
          Active
        </button>
        <button
          type="button"
          onClick={() => switchTab('past')}
          className={
            'flex min-h-[40px] flex-1 items-center justify-center rounded px-3 font-bold transition-colors ' +
            (tab === 'past' ? 'bg-tan text-cream' : 'text-charcoal')
          }
        >
          Past
        </button>
      </div>

      {loading ? (
        <Spinner label="Loading your orders…" />
      ) : error ? (
        <p className="py-10 text-center text-sm text-muted">{error}</p>
      ) : orders.length === 0 ? (
        <div className="rounded-md border border-[#e5e5e5] bg-cream p-8 text-center shadow-sm">
          <p className="text-muted">{tab === 'active' ? 'No active orders.' : 'No past orders yet.'}</p>
          <Link
            href="/menu"
            className="mt-4 inline-block rounded-md bg-tan px-5 py-2 text-sm font-bold text-cream hover:bg-tan-dark"
          >
            Browse the menu
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => {
            const active = isActiveOrderStatus(order.status);
            const typeLabel = orderTypeLabel(order);
            return (
              <li key={order.id} className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/order/${order.id}`} className="font-bold text-charcoal hover:underline">
                      #{formatOrderNumber(order.order_number)}
                    </Link>
                    <p className="text-xs text-muted">
                      {formatIstDate(order.created_at)} · {formatIstTime(new Date(order.created_at))}
                      {typeLabel ? ` · ${typeLabel}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={
                        'rounded-full px-2.5 py-1 text-xs font-bold ' + ORDER_STATUS_BADGE_CLASS[order.status]
                      }
                    >
                      {ORDER_STATUS_LABEL[order.status]}
                    </span>
                    <p className="text-sm font-bold text-charcoal">₹{order.total_inr ?? order.subtotal_inr}</p>
                  </div>
                </div>

                <p className="mt-2 line-clamp-2 text-sm text-muted">
                  {order.items
                    .map((i) => `${i.name_snapshot}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`)
                    .join(', ')}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {active ? (
                    <Link href={`/order/${order.id}`} className="text-xs font-bold text-tan hover:underline">
                      Track
                    </Link>
                  ) : null}
                  {order.status === 'completed' ? (
                    <Link
                      href={`/order/${order.id}/receipt`}
                      className="text-xs font-bold text-tan hover:underline"
                    >
                      View bill
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleReorder(order.id)}
                    disabled={reorderingId === order.id}
                    className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal transition-colors hover:border-tan hover:text-tan disabled:opacity-60"
                  >
                    {reorderingId === order.id ? 'Adding to cart…' : 'Order again'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && orders.length > 0 ? (
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => tab && load(tab, page - 1)}
            disabled={page <= 1}
            className="min-h-[40px] rounded-md border border-[#e5e5e5] px-4 text-sm font-bold text-charcoal disabled:opacity-40"
          >
            Newer
          </button>
          <span className="text-sm text-muted">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => tab && load(tab, page + 1)}
            disabled={!hasMore}
            className="min-h-[40px] rounded-md border border-[#e5e5e5] px-4 text-sm font-bold text-charcoal disabled:opacity-40"
          >
            Older
          </button>
        </div>
      ) : null}
    </div>
  );
}
