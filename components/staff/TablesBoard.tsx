'use client';

// Staff tables board (POS-3). A read-only, at-a-glance projection of every
// active table's state, grouped by zone: FREE vs OCCUPIED. It reuses the exact
// board plumbing the Orders queue uses — one GET /api/orders fetch kept live via
// useStaffOrdersRealtime (Supabase postgres_changes + a poll backstop) — plus a
// one-shot GET /api/tables for the registry. All occupancy reasoning is the pure
// lib/staff/tableOccupancy helper (unit-tested); this file only renders.
//
// Flows (POS-3 AC):
//  - Tap a FREE table     → /staff/orders/new?table=<id> (POS-1, table pre-selected).
//  - Tap an OCCUPIED table → reveal its open order(s) inline (order #, status,
//    age, items, total) with a clear link to the Orders board (/staff) to
//    settle/correct via the existing detail (POS-2/POS-4). A deep-link that opens
//    the exact order on the board is a deferred nice-to-have.
//
// Money is display-only (order.total_inr); this surface never computes a bill.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui/Spinner';
import { ElapsedTime } from '@/components/staff/ElapsedTime';
import { useStaffOrdersRealtime, type RealtimeConnection } from '@/lib/realtime/hooks';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { STATUS_LABELS } from '@/lib/orders/stateMachine';
import {
  groupTablesByZone,
  isOccupied,
  orderDisplayTotal,
  orderItemCount,
  type OrderWithItems,
  type StaffTable,
  type TableOccupancy,
} from '@/lib/staff/tableOccupancy';

export function TablesBoard() {
  const router = useRouter();
  const [tables, setTables] = useState<StaffTable[]>([]);
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [expandedTableId, setExpandedTableId] = useState<string | null>(null);

  // Orders — refetched by the realtime hook (+ poll fallback), same as /staff.
  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/orders', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setOrders(data.orders ?? []);
    } catch {
      /* keep last-known-good; realtime/poll retries */
    } finally {
      setOrdersLoaded(true);
    }
  }, []);

  const connection = useStaffOrdersRealtime(fetchOrders);

  // Tables — fetched once (the active registry rarely changes mid-shift; an
  // owner add/deactivate is picked up on the next full load).
  useEffect(() => {
    fetchOrders();
    fetch('/api/tables', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { tables: [] }))
      .then((data: { tables?: StaffTable[] }) => setTables(data.tables ?? []))
      .catch(() => {})
      .finally(() => setTablesLoaded(true));
  }, [fetchOrders]);

  const zones = useMemo(() => groupTablesByZone(tables, orders), [tables, orders]);
  const loading = !tablesLoaded || !ordersLoaded;

  const occupiedCount = useMemo(
    () => zones.reduce((n, z) => n + z.tables.filter(isOccupied).length, 0),
    [zones],
  );
  const tableCount = tables.length;

  const toggleExpand = useCallback((id: string) => {
    setExpandedTableId((cur) => (cur === id ? null : id));
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Tables</h1>
          <p className="text-sm text-muted">
            {tableCount > 0
              ? `${occupiedCount} of ${tableCount} occupied`
              : 'Tap a free table to start an order.'}
          </p>
        </div>
        <ConnectionBadge connection={connection} />
      </div>

      {loading ? (
        <Spinner label="Loading tables…" />
      ) : tableCount === 0 ? (
        <p className="rounded-md border border-line bg-cream p-6 text-center text-sm text-muted">
          No active tables yet — add tables in the owner settings to see them here.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {zones.map((zone) => (
            <section key={zone.zone || '__unzoned__'} className="flex flex-col gap-3">
              <h2 className="border-b border-[#e5e5e5] pb-2 text-sm font-bold uppercase tracking-wide text-charcoal">
                {zone.zone || 'No zone'}
                <span className="ml-2 font-normal text-muted">{zone.tables.length}</span>
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {zone.tables.map((occ) => (
                  <TableTile
                    key={occ.table.id}
                    occ={occ}
                    expanded={expandedTableId === occ.table.id}
                    onStartOrder={() => router.push(`/staff/orders/new?table=${occ.table.id}`)}
                    onToggle={() => toggleExpand(occ.table.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// A single table tile. FREE tiles are one tap → POS-1 with the table pre-selected.
// OCCUPIED tiles always show a per-order summary (age · items · total) and expand
// on tap to reveal the fuller detail + a link to the Orders board.
function TableTile({
  occ,
  expanded,
  onStartOrder,
  onToggle,
}: {
  occ: TableOccupancy;
  expanded: boolean;
  onStartOrder: () => void;
  onToggle: () => void;
}) {
  const { table } = occ;
  const occupied = isOccupied(occ);

  if (!occupied) {
    return (
      <button
        type="button"
        onClick={onStartOrder}
        className="flex min-h-[104px] flex-col justify-between rounded-md border border-[#e5e5e5] bg-cream p-3 text-left shadow-sm transition hover:border-tan hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
      >
        <div className="flex items-center justify-between">
          <span className="text-base font-bold text-charcoal">{table.label}</span>
          <span className="rounded-full bg-[#e8f3ea] px-2 py-0.5 text-[11px] font-bold text-[#2f6b38]">
            Free
          </span>
        </div>
        <p className="mt-2 text-xs text-muted">
          {table.capacity > 0 ? `Seats ${table.capacity} · ` : ''}Tap to start an order
        </p>
      </button>
    );
  }

  return (
    <div className="flex min-h-[104px] flex-col rounded-md border border-tan bg-[#f6efe9] p-3 shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex flex-1 flex-col text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
      >
        <div className="flex items-center justify-between">
          <span className="text-base font-bold text-charcoal">{table.label}</span>
          <span className="rounded-full bg-tan px-2 py-0.5 text-[11px] font-bold text-cream">
            {occ.orders.length > 1 ? `${occ.orders.length} orders` : 'Occupied'}
          </span>
        </div>
        <ul className="mt-2 flex flex-col gap-1">
          {occ.orders.map((order) => (
            <li
              key={order.id}
              className="flex items-center justify-between gap-2 text-xs text-charcoal"
            >
              <ElapsedTime
                since={order.created_at}
                warnAfterMin={10}
                dangerAfterMin={20}
                className="font-bold"
              />
              <span className="text-muted">
                {orderItemCount(order)} item{orderItemCount(order) === 1 ? '' : 's'} · ₹
                {orderDisplayTotal(order)}
              </span>
            </li>
          ))}
        </ul>
      </button>

      {expanded ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-tan/40 pt-3">
          {occ.orders.map((order) => (
            <div key={order.id} className="rounded-md border border-[#e5e5e5] bg-cream p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-bold text-charcoal">
                  #{formatOrderNumber(order.order_number)}
                </span>
                <span className="rounded-full bg-[#f2efe9] px-2 py-0.5 text-[10px] font-bold text-charcoal">
                  {STATUS_LABELS[order.status]}
                </span>
              </div>
              <ul className="mt-1 flex flex-col text-muted">
                {order.items
                  .filter((i) => !i.voided)
                  .map((i) => (
                    <li key={i.id} className="truncate">
                      {i.quantity}× {i.name_snapshot}
                      {i.variant_label_snapshot ? ` · ${i.variant_label_snapshot}` : ''}
                    </li>
                  ))}
              </ul>
              <div className="mt-1 flex items-center justify-between border-t border-[#e5e5e5] pt-1">
                <span className="text-muted">
                  <ElapsedTime since={order.created_at} /> · {orderItemCount(order)} item
                  {orderItemCount(order) === 1 ? '' : 's'}
                </span>
                <span className="font-bold text-charcoal">₹{orderDisplayTotal(order)}</span>
              </div>
              {/* TAB-2: the whole point of the running tab — more items go ONTO
                  this order, so the table keeps one bill instead of collecting
                  a second order nothing ties to the first. */}
              <Link
                href={`/staff/orders/new?add=${order.id}`}
                className="mt-2 block rounded-md bg-tan px-3 py-2 text-center text-xs font-bold text-cream transition-colors hover:bg-tan-dark"
              >
                + Add items to this order
              </Link>
            </div>
          ))}
          <Link
            href="/staff"
            className="rounded-md border border-[#e5e5e5] px-3 py-2 text-center text-xs font-bold text-charcoal transition-colors hover:border-tan"
          >
            Settle or correct in Orders →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionBadge({ connection }: { connection: RealtimeConnection }) {
  const live = connection === 'live';
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted">
      <span
        className={
          'inline-block h-2 w-2 rounded-full ' +
          (live ? 'bg-green-500' : connection === 'connecting' ? 'bg-amber-400' : 'bg-muted')
        }
      />
      {live ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Polling'}
    </span>
  );
}
