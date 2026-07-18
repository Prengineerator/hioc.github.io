'use client';

// Live staff order cockpit (S1–S3, S5, S7). Realtime board (< 2s via
// useStaffOrdersRealtime, poll fallback), persistent new-order alert, order
// detail with accept/reject/ETA/advance/cancel/payment, search, and a
// full-screen counter mode with a screen wake-lock.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OrderQueueBoard } from '@/components/staff/OrderQueueBoard';
import { OrderDetailModal } from '@/components/staff/OrderDetailModal';
import { NewOrderAlert } from '@/components/staff/NewOrderAlert';
import { Spinner } from '@/components/ui/Spinner';
import { useStaffOrdersRealtime } from '@/lib/realtime/hooks';
import { PRIMARY_NEXT } from '@/lib/orders/stateMachine';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { unlockChime, playChime } from '@/lib/staff/chime';
import type { Order, OrderItem, PaymentMethod } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

export default function StaffOrdersPage() {
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OrderWithItems | null>(null);
  const [newOrderIds, setNewOrderIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [counterMode, setCounterMode] = useState(false);
  const [prepMin, setPrepMin] = useState(15);
  const [toast, setToast] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(false);
  const prevReceivedRef = useRef<Set<string> | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/orders', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const next: OrderWithItems[] = data.orders ?? [];
      setOrders(next);

      const received = new Set(next.filter((o) => o.status === 'received').map((o) => o.id));
      if (prevReceivedRef.current) {
        const prev = prevReceivedRef.current;
        setNewOrderIds((cur) => {
          const s = new Set(cur);
          received.forEach((id) => !prev.has(id) && s.add(id));
          s.forEach((id) => !received.has(id) && s.delete(id));
          return s;
        });
      }
      prevReceivedRef.current = received;
    } catch {
      /* keep last-known-good; realtime/poll retries */
    } finally {
      setLoading(false);
    }
  }, []);

  const connection = useStaffOrdersRealtime(fetchOrders);

  useEffect(() => {
    fetchOrders();
    fetch('/api/store-settings')
      .then((r) => r.json())
      .then((d) => setPrepMin(d?.settings?.default_prep_min ?? 15))
      .catch(() => {});
  }, [fetchOrders]);

  // Keep the open detail modal in sync with fresh data.
  useEffect(() => {
    if (selected) {
      const fresh = orders.find((o) => o.id === selected.id);
      if (fresh && fresh !== selected) setSelected(fresh);
    }
  }, [orders, selected]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  // One-time audio unlock (browsers block sound until a user gesture, S2). Plays
  // a test chime so staff confirm it works.
  const enableSound = useCallback(async () => {
    const ok = await unlockChime();
    setSoundEnabled(ok);
    if (ok) playChime();
  }, []);

  const patchStatus = useCallback(
    async (o: OrderWithItems, to: Order['status'], extra?: { reason?: string; promised_ready_at?: string }) => {
      // Optimistic move.
      setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: to } : x)));
      setNewOrderIds((prev) => {
        if (!prev.has(o.id)) return prev;
        const s = new Set(prev);
        s.delete(o.id);
        return s;
      });
      try {
        const res = await fetch(`/api/orders/${o.id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: to, version: o.version, ...extra }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(d.error ?? 'Could not update order');
        }
      } finally {
        fetchOrders();
      }
    },
    [fetchOrders],
  );

  const handlePrimary = useCallback(
    (o: OrderWithItems) => {
      const next = PRIMARY_NEXT[o.status];
      // 'received' → Accept needs an ETA, and 'ready' → Complete needs pickup-
      // code verification — both open the detail view instead of transitioning
      // blindly. 'accepted'/'preparing' advance in one tap.
      if (o.status === 'received' || o.status === 'ready') {
        setSelected(o);
        return;
      }
      if (next) patchStatus(o, next);
    },
    [patchStatus],
  );

  const handlePayment = useCallback(
    async (o: OrderWithItems, method: PaymentMethod) => {
      try {
        await fetch(`/api/orders/${o.id}/payment`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payment_method: method }),
        });
      } finally {
        fetchOrders();
      }
    },
    [fetchOrders],
  );

  // Refund (PAY-3) — the server route is manager/owner-gated (FND-5); a plain
  // staff member sees this fail with a clear message rather than the button
  // being hidden (role isn't plumbed to this client page).
  const handleRefund = useCallback(
    async (o: OrderWithItems, amountInr: number, reason: string) => {
      try {
        const res = await fetch(`/api/orders/${o.id}/refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount_inr: amountInr, reason }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(d.error ?? 'Refund failed — only managers can issue refunds.');
        } else {
          showToast('Refund issued.');
        }
      } catch {
        showToast('Refund failed — please try again.');
      } finally {
        fetchOrders();
      }
    },
    [fetchOrders],
  );

  const closeModalAfter = (fn: () => void) => {
    fn();
    setSelected(null);
  };

  // Counter mode: full-screen + keep the screen awake (S1/S13).
  useEffect(() => {
    if (!counterMode) return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {});
    return () => {
      lock?.release().catch(() => {});
    };
  }, [counterMode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(
      (o) =>
        o.customer_name.toLowerCase().includes(q) ||
        o.customer_phone.includes(q) ||
        formatOrderNumber(o.order_number).toLowerCase().includes(q) ||
        String(o.order_number).includes(q) ||
        // Pickup code the customer shows at the counter (CUS-056) — staff type
        // it to pull up the order and hand over the right one.
        (o.pickup_code ?? '').includes(q),
    );
  }, [orders, query]);

  return (
    <div className={counterMode ? 'fixed inset-0 z-40 overflow-auto bg-cream' : 'mx-auto max-w-7xl px-4 py-8'}>
      <div className={counterMode ? 'px-4 py-4' : ''}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-charcoal">Today&apos;s Orders</h1>
          <div className="flex items-center gap-3">
            <ConnectionBadge connection={connection} />
            <button
              type="button"
              onClick={enableSound}
              className={
                'rounded-md border px-3 py-1.5 text-xs font-bold ' +
                (soundEnabled
                  ? 'border-[#e5e5e5] text-charcoal hover:border-tan'
                  : 'border-amber-400 bg-amber-50 text-amber-700')
              }
            >
              {soundEnabled ? '🔔 Sound on' : '🔔 Enable sound'}
            </button>
            <button
              onClick={() => setCounterMode((v) => !v)}
              className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
            >
              {counterMode ? 'Exit counter mode' : 'Counter mode'}
            </button>
          </div>
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search order #, name, phone, or pickup code…"
          className="mb-4 w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-sm sm:max-w-sm"
        />

        <NewOrderAlert count={newOrderIds.size} soundEnabled={soundEnabled} />

        {loading ? (
          <Spinner label="Loading orders…" />
        ) : (
          <OrderQueueBoard orders={filtered} onOpen={setSelected} onPrimary={handlePrimary} />
        )}
      </div>

      {toast ? (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-charcoal px-4 py-2 text-sm text-cream shadow-lg">
          {toast}
        </div>
      ) : null}

      {selected ? (
        <OrderDetailModal
          order={selected}
          defaultPrepMin={prepMin}
          onClose={() => setSelected(null)}
          onTransition={(o, to, extra) => closeModalAfter(() => patchStatus(o, to, extra))}
          onPayment={(o, m) => handlePayment(o, m)}
          onRefund={(o, amountInr, reason) => handleRefund(o, amountInr, reason)}
        />
      ) : null}
    </div>
  );
}

function ConnectionBadge({ connection }: { connection: 'connecting' | 'live' | 'reconnecting' }) {
  const live = connection === 'live';
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted">
      <span className={'inline-block h-2 w-2 rounded-full ' + (live ? 'bg-green-500' : connection === 'connecting' ? 'bg-amber-400' : 'bg-muted')} />
      {live ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Polling'}
    </span>
  );
}
