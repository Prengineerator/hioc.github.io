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
//
// Channel chips (docs/SHOP-V2-SPEC.md E4): All · Café · Shop, kept in the URL as
// ?channel= and sent on as `&channel=`. `items[]` is the merged, newest-first
// list; café rows render as before and shop rows as <ShopOrderRow>. The chips
// are hidden (and the channel is always 'all') while flags.shop is off.

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CartProvider } from '@/lib/cart/CartContext';
import { useReorder } from '@/lib/account/useReorder';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import {
  ORDER_STATUS_BADGE_CLASS,
  orderStatusLabel,
  formatIstDate,
  isActiveOrderStatus,
  orderTypeLabel,
} from '@/lib/account/orderDisplay';
import { hasBill } from '@/lib/orders/paymentStatusUI';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import { ChannelFilter, parseChannel } from '@/components/account/ChannelFilter';
import { CafeChannelBadge, ShopOrderRow } from '@/components/account/ShopOrderRow';
import type { AccountHistoryItem, AccountHistoryResponse, HistoryChannelFilter } from '@/lib/account/historyTypes';
import type { OrderResponse } from '@/lib/api/orders';
import { lineSizeSuffix } from '@/lib/menu/weight';

type Tab = 'active' | 'past';

interface LegacyOrderResponse {
  source: 'petpooja';
  id: string;
  bill_no: string;
  created_at: string;
  total_inr: number;
  status: string;
  channel: string;
  items: Array<{ name_snapshot: string; variant_label_snapshot: string; weight_grams?: number | null }>;
}

const CHANNEL_LABELS: Record<string, string> = {
  counter: 'Counter',
  delivery: 'Delivery',
  zomato: 'Zomato',
  swiggy: 'Swiggy',
  qr: 'QR order',
  dine_in: 'Dine-in',
};

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] || channel;
}

type HistoryResponse = Omit<AccountHistoryResponse, 'petpooja_orders' | 'items'> & {
  items?: AccountHistoryItem[];
  petpooja_orders?: LegacyOrderResponse[];
};

export default function AccountOrdersPage() {
  return (
    <CartProvider>
      <Suspense fallback={<Spinner label="Loading your orders…" />}>
        <AccountOrdersContent />
      </Suspense>
    </CartProvider>
  );
}

function AccountOrdersContent() {
  const router = useRouter();
  const { reorder, reorderingId } = useReorder();
  const channel: HistoryChannelFilter = parseChannel(useSearchParams().get('channel'));

  // null tab = still deciding which one to default to (initial load).
  const [tab, setTab] = useState<Tab | null>(null);
  const [items, setItems] = useState<AccountHistoryItem[]>([]);
  const [petpoojaOrders, setPetpoojaOrders] = useState<LegacyOrderResponse[]>([]);
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

  // Only the newest history request may update the list: tapping Past while
  // the first (Active) load is still in flight must not let that older
  // response land afterwards and show Active orders under the Past tab.
  const latestRequest = useRef(0);

  // The channel in play for any load; a ref so tab/page handlers always use the latest chip.
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const tabRef = useRef<Tab | null>(null);
  tabRef.current = tab;

  const fetchPage = useCallback(async (t: Tab, p: number, c: HistoryChannelFilter): Promise<HistoryResponse | null> => {
    const res = await fetch(`/api/account/history?page=${p}&status=${t}&channel=${c}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  }, []);

  const applyPage = useCallback((t: Tab, p: number, data: HistoryResponse) => {
    setTab(t);
    setPage(p);
    // `items` is the merged list; fall back to café-only `orders` if a response lacks it.
    setItems(
      data.items ??
        (data.orders ?? []).map((o): AccountHistoryItem => ({ channel: 'cafe', id: o.id, created_at: o.created_at, order: o })),
    );
    setPetpoojaOrders(data.petpooja_orders ?? []);
    setPageSize(data.pageSize ?? 10);
    setTotal(data.total ?? 0);
    setHasMore(Boolean(data.hasMore));
    setPhoneVerified(Boolean(data.phoneVerified));
  }, []);

  const load = useCallback(
    async (t: Tab, p: number) => {
      const req = ++latestRequest.current;
      setLoading(true);
      setError('');
      try {
        const data = await fetchPage(t, p, channelRef.current);
        if (req !== latestRequest.current) return;
        if (!data) {
          setError('Could not load your orders.');
          return;
        }
        applyPage(t, p, data);
      } catch {
        if (req === latestRequest.current) setError('No connection. Check your internet and try again.');
      } finally {
        if (req === latestRequest.current) setLoading(false);
      }
    },
    [applyPage, fetchPage],
  );

  // Initial load: default to the Active tab if it has anything in it, else
  // Past — so a customer with an order in flight lands straight on it, and
  // one with no active orders isn't shown an empty "Active" tab first.
  // Changing the channel chip reloads page 1 of the tab already open.
  useEffect(() => {
    const keepTab = tabRef.current;
    if (keepTab) {
      load(keepTab, 1);
      return;
    }
    const req = ++latestRequest.current;
    let cancelled = false;
    const stale = () => cancelled || req !== latestRequest.current;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const activeData = await fetchPage('active', 1, channel);
        if (stale()) return;
        if (!activeData) {
          setError('Could not load your orders.');
          return;
        }
        if (activeData.total > 0) {
          applyPage('active', 1, activeData);
          return;
        }
        const pastData = await fetchPage('past', 1, channel);
        if (stale()) return;
        applyPage('past', 1, pastData ?? activeData);
      } catch {
        if (!stale()) setError('No connection. Check your internet and try again.');
      } finally {
        if (!stale()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  // Scroll to the top on every page/tab change — without this, switching
  // pages while scrolled down leaves the new page's top card off-screen.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [tab, page]);

  // A reorder that shows a notice first navigates 1.5 s later; leaving the page
  // in the meantime must not yank the customer to checkout from elsewhere.
  const redirectTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(redirectTimer.current), []);

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
    if (result.added === 0) {
      // Every item is unavailable today: stay here and say so, rather than
      // opening an empty checkout (same guard as components/account/OrderAgainStrip).
      setNotice(result.notice || 'None of these items are available right now.');
      return;
    }
    if (result.notice) {
      // Small delay so the notice is readable before we navigate away.
      setNotice(result.notice);
      redirectTimer.current = window.setTimeout(() => router.push('/checkout'), 1500);
    } else {
      router.push('/checkout');
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold text-charcoal">Your orders</h1>

      {phoneVerified ? null : (
        <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-charcoal">
          Placed an order at the counter?{' '}
          <Link href="/account/profile" className="font-semibold text-tan-dark hover:underline">
            Verify your WhatsApp number
          </Link>{' '}
          to see it here.
        </div>
      )}

      {notice ? (
        <div role="status" className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-charcoal">
          {notice}
        </div>
      ) : null}

      <ChannelFilter value={channel} />

      <div role="group" aria-label="Order list" className="flex gap-1 rounded-md border border-muted/80 p-1 text-sm">
        <button
          type="button"
          aria-pressed={tab === 'active'}
          onClick={() => switchTab('active')}
          className={
            'flex min-h-[44px] flex-1 items-center justify-center rounded px-3 font-semibold transition-colors ' +
            (tab === 'active' ? 'bg-tan-dark text-cream' : 'text-charcoal')
          }
        >
          Active
        </button>
        <button
          type="button"
          aria-pressed={tab === 'past'}
          onClick={() => switchTab('past')}
          className={
            'flex min-h-[44px] flex-1 items-center justify-center rounded px-3 font-semibold transition-colors ' +
            (tab === 'past' ? 'bg-tan-dark text-cream' : 'text-charcoal')
          }
        >
          Past
        </button>
      </div>

      {loading ? (
        <Spinner label="Loading your orders…" />
      ) : error ? (
        <p className="py-10 text-center text-sm text-muted">{error}</p>
      ) : items.length === 0 && !(tab === 'past' && channel !== 'shop' && petpoojaOrders.length > 0) ? (
        channel === 'shop' ? (
          <EmptyState
            icon=""
            heading="No shop orders yet"
            body={tab === 'active' ? 'Coffee on its way to you shows up here.' : 'Orders delivered to you will show up here.'}
            action={
              <Link href="/shop" className={buttonVariants()}>
                Browse the shop
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon=""
            heading={tab === 'active' ? 'No active orders' : 'No past orders yet'}
            body={tab === 'active' ? 'Orders that are being made show up here.' : 'Orders you collect will show up here.'}
            action={
              <Link href="/menu" className={buttonVariants()}>
                Browse the menu
              </Link>
            }
          />
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            if (item.channel === 'shop') return <ShopOrderRow key={item.id} order={item.order} />;
            const order = item.order;
            const active = isActiveOrderStatus(order.status);
            const typeLabel = orderTypeLabel(order);
            return (
              <li key={order.id} className="rounded-md border border-line bg-cream p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/order/${order.id}`}
                      className="font-mono font-bold tabular-nums text-charcoal hover:underline"
                    >
                      #{formatOrderNumber(order.order_number)}
                    </Link>
                    <p className="text-sm text-muted">
                      {formatIstDate(order.created_at)}, {formatIstTime(new Date(order.created_at))}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <CafeChannelBadge detail={typeLabel} />
                    <span
                      className={
                        'rounded-full px-2.5 py-1 text-xs font-semibold ' + ORDER_STATUS_BADGE_CLASS[order.status]
                      }
                    >
                      {orderStatusLabel(order)}
                    </span>
                    <p className="font-mono text-sm font-bold tabular-nums text-charcoal">
                      ₹{order.total_inr ?? order.subtotal_inr}
                    </p>
                  </div>
                </div>

                <p className="mt-2 line-clamp-2 text-sm text-muted">
                  {order.items
                    .map((i) => `${i.name_snapshot}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`)
                    .join(', ')}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {active ? (
                    <Link href={`/order/${order.id}`} className="inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline">
                      Track
                    </Link>
                  ) : null}
                  {hasBill(order) ? (
                    <Link
                      href={`/order/${order.id}/receipt`}
                      className="inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline"
                    >
                      View bill
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleReorder(order.id)}
                    disabled={reorderingId === order.id}
                    className="min-h-[44px] rounded-md border border-muted/80 px-3 py-1.5 text-sm font-semibold text-charcoal transition-colors hover:border-tan hover:text-tan-dark disabled:opacity-60"
                  >
                    {reorderingId === order.id ? 'Adding to cart…' : 'Order again'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Bills from before the new app come with every history response, so
          show them on page 1 of Past only (not repeated on every page). */}
      {petpoojaOrders.length > 0 && tab === 'past' && page === 1 && channel !== 'shop' && (
        <div className="mt-8 flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-charcoal">Earlier orders, from before our new app</h2>
          <ul className="flex flex-col gap-3">
            {petpoojaOrders.map((order) => (
              <li key={order.id} className="rounded-md border border-line bg-cream p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono font-bold tabular-nums text-charcoal">Bill #{order.bill_no}</p>
                    <p className="text-sm text-muted">
                      {formatIstDate(order.created_at)}, {formatIstTime(new Date(order.created_at))}
                      {order.channel ? `, ${channelLabel(order.channel)}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={
                        'rounded-full px-2.5 py-1 text-xs font-semibold ' +
                        (order.status === 'completed'
                          ? 'bg-green-100 text-green-800'
                          : order.status === 'cancelled'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-gray-100 text-gray-800')
                      }
                    >
                      {order.status === 'completed' ? 'Completed' : 'Cancelled'}
                    </span>
                    <p className="font-mono text-sm font-bold tabular-nums text-charcoal">
                      ₹{Math.round(order.total_inr).toLocaleString('en-IN')}
                    </p>
                  </div>
                </div>

                <p className="mt-2 line-clamp-2 text-sm text-muted">
                  {order.items.map((i) => `${i.name_snapshot}${lineSizeSuffix(i.variant_label_snapshot, i.weight_grams)}`).join(', ')}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!loading && !error && items.length > 0 ? (
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => tab && load(tab, page - 1)}
            disabled={page <= 1}
            className="min-h-[44px] rounded-md border border-muted/80 px-4 text-sm font-semibold text-charcoal disabled:opacity-40"
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
            className="min-h-[44px] rounded-md border border-muted/80 px-4 text-sm font-semibold text-charcoal disabled:opacity-40"
          >
            Older
          </button>
        </div>
      ) : null}
    </div>
  );
}
