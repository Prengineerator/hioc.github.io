'use client';

// Staff tables board (POS-3). A read-only, at-a-glance projection of every
// active table's state, grouped by zone: FREE vs OCCUPIED. Today's orders come
// from the shared orders feed (lib/staff/ordersFeed.ts — the staff shell's one
// realtime channel and one fetch per change, shared with Live orders and the
// new-order alarm), plus GET /api/tables for the registry. All occupancy reasoning is the pure
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui/Spinner';
import { ElapsedTime } from '@/components/staff/ElapsedTime';
import type { RealtimeConnection } from '@/lib/realtime/hooks';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { fetchWithTimeout } from '@/lib/pos/fetchWithTimeout';
import { readSnapshot, snapshotAgeLabel, writeSnapshot } from '@/lib/pos/localSnapshot';
import { fetchOrdersFeed, useOrdersFeed, useOrdersFeedBoard } from '@/lib/staff/ordersFeed';
import {
  TABLES_BOARD_SNAPSHOT,
  TABLES_BOARD_SNAPSHOT_OPTS,
  TABLES_SNAPSHOT,
  TABLES_SNAPSHOT_OPTS,
  toTablesBoardSnapshot,
} from '@/lib/pos/posSnapshots';
import { usePosRefresh } from '@/lib/staff/posRefresh';
import { STATUS_LABELS } from '@/lib/orders/stateMachine';
import { lineSizeLabel } from '@/lib/menu/weight';
import {
  groupTablesByZone,
  isOccupied,
  orderDisplayTotal,
  orderItemCount,
  type OrderWithItems,
  type StaffTable,
  type TableOccupancy,
} from '@/lib/staff/tableOccupancy';

// Seeding from what this machine kept must happen before the first paint, or
// the board flashes a spinner it doesn't need. A layout effect on the client;
// on the server (where there is no storage anyway) a plain effect, which
// keeps React from warning.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** A tables list read this recently (here or on New order) isn't read again on open. */
const TABLES_REFETCH_AFTER_MS = 60_000;

export function TablesBoard() {
  const router = useRouter();
  const [tables, setTables] = useState<StaffTable[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [tablesFailed, setTablesFailed] = useState(false);
  const [expandedTableId, setExpandedTableId] = useState<string | null>(null);
  // The trimmed copy of the board kept for the tab's session — what draws right
  // after a reload, until the feed's first answer replaces it.
  const [keptOrders, setKeptOrders] = useState<{ savedAt: number; data: OrderWithItems[] } | null>(null);
  const tablesFresh = useRef(false);

  // Today's orders: the shared feed, kept live by the staff shell. While this
  // board is up the feed fetches the whole day; on open it fetches at once
  // unless what it holds is moments old (coming straight from Live orders).
  const feed = useOrdersFeed();
  useOrdersFeedBoard();

  // Local first: draw the last tables this machine saw, and — after a reload,
  // when the feed holds nothing yet — the kept board, then let the answers in.
  useIsomorphicLayoutEffect(() => {
    const kt = readSnapshot(TABLES_SNAPSHOT, TABLES_SNAPSHOT_OPTS);
    if (kt) {
      setTables(kt.data);
      setTablesLoaded(true);
      tablesFresh.current = Date.now() - kt.savedAt < TABLES_REFETCH_AFTER_MS;
    }
    const ko = readSnapshot(TABLES_BOARD_SNAPSHOT, TABLES_BOARD_SNAPSHOT_OPTS);
    if (ko) setKeptOrders(ko);
  }, []);

  // Each fresh day's list also becomes the kept board for a reload (open
  // dine-in orders only, customer details blanked).
  useEffect(() => {
    if (feed.orders && feed.fullAt > 0) {
      writeSnapshot(TABLES_BOARD_SNAPSHOT, toTablesBoardSnapshot(feed.orders), TABLES_BOARD_SNAPSHOT_OPTS, feed.fullAt);
    }
  }, [feed.orders, feed.fullAt]);

  const orders = useMemo(() => feed.orders ?? keptOrders?.data ?? [], [feed.orders, keptOrders]);
  const ordersLoaded = feed.orders !== null || keptOrders !== null || feed.failed;
  // When the board on screen is not a fresh answer: when it was fetched (or
  // kept), for the "couldn't reach the server" note.
  const savedAt = feed.orders !== null ? feed.fullAt : (keptOrders?.savedAt ?? null);
  const refreshFailed = feed.failed || tablesFailed;
  const refreshing = feed.loading;
  const connection = feed.connection;

  // Tables — the active registry rarely changes mid-shift; read on open (unless
  // read a moment ago) and on Refresh, drawn from the kept copy meanwhile.
  const fetchTables = useCallback(() => {
    fetchWithTimeout('/api/tables', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`tables ${res.status}`))))
      .then((data: { tables?: StaffTable[] }) => {
        if (!Array.isArray(data.tables)) return;
        setTables(data.tables);
        setTablesFailed(false);
        writeSnapshot(TABLES_SNAPSHOT, data.tables, TABLES_SNAPSHOT_OPTS);
      })
      // A failed read keeps the kept registry rather than emptying the board.
      .catch(() => setTablesFailed(true))
      .finally(() => setTablesLoaded(true));
  }, []);

  useEffect(() => {
    if (!tablesFresh.current) fetchTables();
  }, [fetchTables]);

  // The header's Refresh / F5 (the shell refreshes the orders feed itself).
  usePosRefresh(fetchTables);

  const retry = () => {
    void fetchOrdersFeed();
    fetchTables();
  };

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
        <div className="flex items-center gap-3">
          {refreshing && ordersLoaded ? <span className="text-[11px] text-muted">Updating…</span> : null}
          <ConnectionBadge connection={connection} />
        </div>
      </div>

      {/* The board is a kept copy and the server can't be reached right now:
          say so, and offer the retry, rather than pass old seats off as live. */}
      {refreshFailed ? (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-charcoal"
        >
          <span>
            {savedAt
              ? `Showing the tables as of ${snapshotAgeLabel(savedAt)} — couldn't reach the server.`
              : "Couldn't load the latest orders — the board may be out of date."}
          </span>
          <button
            type="button"
            onClick={retry}
            className="rounded-md border border-charcoal px-3 py-1 text-xs font-bold hover:bg-charcoal hover:text-cream"
          >
            Try again
          </button>
        </div>
      ) : null}

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
              <h2 className="border-b border-line pb-2 text-sm font-bold uppercase tracking-wide text-charcoal">
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
        className="flex min-h-[104px] flex-col justify-between rounded-md border border-line bg-cream p-3 text-left shadow-sm transition hover:border-tan hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
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
    <div className="flex min-h-[104px] flex-col rounded-md border border-tan bg-surface p-3 shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex flex-1 flex-col text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
      >
        <div className="flex items-center justify-between">
          <span className="text-base font-bold text-charcoal">{table.label}</span>
          <span className="rounded-full bg-tan-dark px-2 py-0.5 text-[11px] font-bold text-cream">
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
            <div key={order.id} className="rounded-md border border-line bg-cream p-2 text-xs">
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
                      {lineSizeLabel(i.variant_label_snapshot, i.weight_grams)
                        ? ` · ${lineSizeLabel(i.variant_label_snapshot, i.weight_grams)}`
                        : ''}
                    </li>
                  ))}
              </ul>
              <div className="mt-1 flex items-center justify-between border-t border-line pt-1">
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
                className="mt-2 block rounded-md bg-tan-dark px-3 py-2 text-center text-xs font-bold text-cream transition-colors hover:bg-tan-darker"
              >
                + Add items to this order
              </Link>
            </div>
          ))}
          <Link
            href="/staff"
            className="rounded-md border border-line px-3 py-2 text-center text-xs font-bold text-charcoal transition-colors hover:border-tan"
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
