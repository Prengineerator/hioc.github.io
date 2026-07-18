'use client';

// Read-only live mirror of the staff queue for the owner (O1/OWN-002). Same
// realtime hook the staff board uses; owner passes the staff API gate.

import { useCallback, useEffect, useState } from 'react';
import { useStaffOrdersRealtime } from '@/lib/realtime/hooks';
import { ACTIVE_LANES, STATUS_LABELS } from '@/lib/orders/stateMachine';
import { timeAgo } from '@/lib/utils/timeAgo';
import type { Order } from '@/lib/types';

export function LiveOps() {
  const [orders, setOrders] = useState<Order[]>([]);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/orders', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setOrders(data.orders ?? []);
    } catch {
      /* poll retries */
    }
  }, []);

  useStaffOrdersRealtime(fetchOrders);
  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const active = orders.filter((o) => (ACTIVE_LANES as string[]).includes(o.status));
  const oldest = active
    .filter((o) => o.status !== 'ready')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];

  return (
    <div>
      <div className="grid grid-cols-4 gap-2">
        {ACTIVE_LANES.map((lane) => (
          <div key={lane} className="rounded-md bg-[#f2efe9] p-3 text-center">
            <p className="text-lg font-bold text-charcoal">{active.filter((o) => o.status === lane).length}</p>
            <p className="text-[10px] uppercase text-muted">{STATUS_LABELS[lane]}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">
        {oldest ? `Oldest in progress: ${timeAgo(oldest.created_at)}` : 'Nothing in progress'}
      </p>
    </div>
  );
}
