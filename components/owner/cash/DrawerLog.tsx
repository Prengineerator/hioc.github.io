'use client';

// DRW-2 — every cash-drawer opening (GET /api/cash-drawer/opens): today's count,
// split into openings for a cash payment and manual openings from the POS's
// "Open drawer" button, then the recent list with time, staffer, counter and
// order. Manual openings are the ones worth a second look: no sale is behind
// them.

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { formatOrderNumber } from '@/lib/utils/orderNumber';

interface DrawerOpenRow {
  id: string;
  openedAt: string;
  reason: 'cash_payment' | 'manual';
  orderNumber: number | null;
  openedByName: string;
  deviceName: string | null;
}

interface DrawerLogData {
  today: { total: number; cashPayment: number; manual: number };
  opens: DrawerOpenRow[];
}

const TIME_FORMAT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

export function DrawerLog() {
  const [data, setData] = useState<DrawerLogData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/cash-drawer/opens', { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? 'Could not load the drawer log.');
          return;
        }
        setData(body as DrawerLogData);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the drawer log.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Cash drawer openings</h2>
      {error ? (
        <p className="mt-3 text-sm text-red-700">{error}</p>
      ) : !data ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <Stat label="Today" value={data.today.total} />
            <Stat label="Cash payments" value={data.today.cashPayment} />
            <Stat label="Manual" value={data.today.manual} highlight={data.today.manual > 0} />
          </div>
          {data.opens.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No openings logged yet.</p>
          ) : (
            <ul className="mt-4 flex flex-col divide-y divide-line text-sm">
              {data.opens.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-charcoal">
                    <span className="font-bold">{TIME_FORMAT.format(new Date(o.openedAt))}</span>
                    {' · '}
                    {o.openedByName}
                    {o.deviceName ? <span className="text-muted"> · {o.deviceName}</span> : null}
                  </span>
                  <span className={o.reason === 'manual' ? 'font-bold text-tan-dark' : 'text-muted'}>
                    {o.reason === 'manual'
                      ? 'Manual'
                      : o.orderNumber !== null
                        ? `Cash · #${formatOrderNumber(o.orderNumber)}`
                        : 'Cash payment'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function Stat({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="rounded-md bg-surface px-2 py-3">
      <p className={'text-2xl font-bold ' + (highlight ? 'text-tan-dark' : 'text-charcoal')}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}
