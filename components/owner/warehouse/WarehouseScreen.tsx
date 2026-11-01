'use client';

// /owner/warehouse (docs/WAREHOUSE-SPEC.md) — four tabs held in `?tab=` so a
// reload or a link (the alert email's "Open Warehouse") lands on the same one:
//
//   Requests      the store's requests and returns, each with the owner's next
//                 step: choose who delivers, record what was sent, count a
//                 return in, settle what arrived different
//   Stock sheet   the warehouse's stock beside the store's, with what is on the
//                 road and what is still to send; purchases, counts, write-offs
//   In transit    every line on the road right now, and every line that
//                 arrived different and is not settled
//   Alerts        who is told when the store asks for stock, and what was sent
//
// One load feeds the first three (they are views of the same transfers); the
// Alerts tab loads its own on first open. Refreshes when the window regains
// focus, and publishes the waiting count to the header badge after each load.

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Spinner } from '@/components/ui/Spinner';
import { api, type WarehousePayload } from '@/components/owner/warehouse/client';
import { publishWarehouseWaiting } from '@/components/owner/warehouse/warehouseEvents';
import { TransfersTab } from '@/components/owner/warehouse/TransfersTab';
import { SheetTab } from '@/components/owner/warehouse/SheetTab';
import { TransitTab } from '@/components/owner/warehouse/TransitTab';
import { AlertsTab } from '@/components/owner/warehouse/AlertsTab';
import { transitLines, unmatchedLines } from '@/lib/inventory/warehouse';

type Tab = 'requests' | 'sheet' | 'transit' | 'alerts';
const TABS: { id: Tab; label: string }[] = [
  { id: 'requests', label: 'Requests' },
  { id: 'sheet', label: 'Stock sheet' },
  { id: 'transit', label: 'In transit' },
  { id: 'alerts', label: 'Alerts' },
];

function tabFrom(param: string | null): Tab {
  return TABS.some((t) => t.id === param) ? (param as Tab) : 'requests';
}

export function WarehouseScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const tab = tabFrom(useSearchParams().get('tab'));
  const [data, setData] = useState<WarehousePayload | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await api<WarehousePayload>('/api/owner/warehouse');
    if (res.ok) {
      setData(res.data);
      setError('');
      publishWarehouseWaiting(res.data.waiting.total);
    } else setError(res.error);
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const goTo = (next: Tab) => router.replace(`${pathname}?tab=${next}`, { scroll: false });

  const counts: Partial<Record<Tab, number>> = data
    ? {
        requests: data.waiting.total,
        transit: transitLines(data.requests).length + unmatchedLines(data.requests).length,
      }
    : {};

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Warehouse sections" className="-mx-4 overflow-x-auto px-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ul className="flex gap-1 border-b border-line">
          {TABS.map((t) => {
            const active = t.id === tab;
            const n = counts[t.id] ?? 0;
            return (
              <li key={t.id} className="shrink-0">
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => goTo(t.id)}
                  className={
                    'flex min-h-[44px] items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-tan ' +
                    (active ? 'border-tan-dark text-charcoal' : 'border-transparent text-muted hover:text-charcoal')
                  }
                >
                  {t.label}
                  {n > 0 ? (
                    <span className="rounded-full bg-tan-dark px-2 py-0.5 text-xs font-bold text-cream">
                      {n}
                      <span className="sr-only">{t.id === 'requests' ? ' waiting on you' : ' lines'}</span>
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {tab === 'alerts' ? (
        <AlertsTab />
      ) : !data ? (
        error ? null : <Spinner label="Loading the warehouse…" />
      ) : tab === 'requests' ? (
        <TransfersTab data={data} reload={load} />
      ) : tab === 'sheet' ? (
        <SheetTab data={data} reload={load} />
      ) : (
        <TransitTab data={data} onOpenRequests={() => goTo('requests')} />
      )}
    </div>
  );
}
