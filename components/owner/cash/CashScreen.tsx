'use client';

// Owner Cash screen (docs/PHASE-5-CASH-COUNTS.md, CC-4): the pending-shortage
// review queue, per-staffer totals for the month, and the read-only count
// log. Talks to /api/owner/cash-shortages and /api/owner/cash-counts; no
// optimistic UI — every decision refetches, same convention TeamManager uses.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import type { TeamMember } from '@/lib/staff/accounts';
import { ShortageDecisionModal, type ShortageAction } from './ShortageDecisionModal';
import { ShortageCard } from './ShortageCard';
import { CountLog } from './CountLog';
import { DrawerLog } from './DrawerLog';
import type { ActiveStaffOption, OwnerCashCountRow, OwnerCashMovementRow, OwnerShortageRow } from './types';
import { rupees } from './types';

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

interface StaffTotal {
  userId: string;
  name: string;
  approved: number;
  pending: number;
  waived: number;
}

export function CashScreen() {
  const [pending, setPending] = useState<OwnerShortageRow[]>([]);
  const [monthRows, setMonthRows] = useState<OwnerShortageRow[]>([]);
  const [counts, setCounts] = useState<OwnerCashCountRow[]>([]);
  const [movements, setMovements] = useState<OwnerCashMovementRow[]>([]);
  const [staff, setStaff] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [modal, setModal] = useState<{ shortage: OwnerShortageRow; action: ShortageAction } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const month = currentMonth();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [pendingRes, monthRes, countsRes, staffRes] = await Promise.all([
        fetch('/api/owner/cash-shortages?status=pending', { cache: 'no-store' }),
        fetch(`/api/owner/cash-shortages?month=${month}`, { cache: 'no-store' }),
        fetch('/api/owner/cash-counts', { cache: 'no-store' }),
        fetch('/api/owner/staff', { cache: 'no-store' }),
      ]);

      if (pendingRes.status === 409 || countsRes.status === 409) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);

      const pendingData = await pendingRes.json().catch(() => ({}));
      if (!pendingRes.ok) throw new Error(pendingData.error ?? 'Could not load shortages.');
      const monthData = await monthRes.json().catch(() => ({}));
      if (!monthRes.ok) throw new Error(monthData.error ?? 'Could not load shortages.');
      const countsData = await countsRes.json().catch(() => ({}));
      if (!countsRes.ok) throw new Error(countsData.error ?? 'Could not load the count log.');
      const staffData = await staffRes.json().catch(() => ({}));

      setPending((pendingData.shortages ?? []) as OwnerShortageRow[]);
      setMonthRows((monthData.shortages ?? []) as OwnerShortageRow[]);
      setCounts((countsData.counts ?? []) as OwnerCashCountRow[]);
      setMovements((countsData.movements ?? []) as OwnerCashMovementRow[]);
      setStaff(staffRes.ok ? ((staffData.members ?? []) as TeamMember[]) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the cash screen.');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const totals = useMemo<StaffTotal[]>(() => {
    const byUser = new Map<string, StaffTotal>();
    for (const row of monthRows) {
      const entry = byUser.get(row.userId) ?? { userId: row.userId, name: row.userName, approved: 0, pending: 0, waived: 0 };
      entry[row.status] += row.amountInr;
      byUser.set(row.userId, entry);
    }
    return [...byUser.values()].sort((a, b) => b.approved + b.pending - (a.approved + a.pending));
  }, [monthRows]);

  const activeStaffOptions = useMemo<ActiveStaffOption[]>(
    () => staff.filter((m) => m.status === 'active' && m.role !== 'customer').map((m) => ({ id: m.id, name: m.name })),
    [staff],
  );

  function handleDecided(updated: OwnerShortageRow) {
    setModal(null);
    setToast(
      updated.status === 'approved'
        ? 'Approved — deducted at the next payroll run.'
        : updated.status === 'waived'
          ? 'Waived.'
          : `Reassigned to ${updated.userName}.`,
    );
    void load();
  }

  if (!loading && unavailable) {
    return (
      <EmptyState
        icon="💰"
        heading="Cash counts aren't set up yet"
        body="Apply supabase/2026-09-cash-counts.sql, then this page will track shortages and the count log."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Cash</h1>
        <p className="text-sm text-muted">Shortages the drawer counts have revealed, and the count log behind them.</p>
      </div>

      {error ? <p className="text-sm font-bold text-red-700">{error}</p> : null}

      <Card>
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Pending shortages</h2>
        {loading ? (
          <p className="mt-3 text-sm text-muted">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing pending — the drawer&apos;s clean.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {pending.map((s) => (
              <ShortageCard key={s.id} shortage={s} onAction={(action) => setModal({ shortage: s, action })} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted">This month, by staffer</h2>
        {!loading && totals.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No shortages recorded this month.</p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {totals.map((t) => (
              <div key={t.userId} className="rounded-md border border-line p-3">
                <p className="font-bold text-charcoal">{t.name}</p>
                <dl className="mt-2 flex flex-col gap-1 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted">Approved</dt>
                    <dd className="text-charcoal">{rupees(t.approved)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Pending</dt>
                    <dd className="text-charcoal">{rupees(t.pending)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Waived</dt>
                    <dd className="text-charcoal">{rupees(t.waived)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        )}
      </Card>

      <CountLog counts={counts} movements={movements} />

      <DrawerLog />

      <ShortageDecisionModal
        shortage={modal?.shortage ?? null}
        action={modal?.action ?? null}
        staffOptions={activeStaffOptions}
        onClose={() => setModal(null)}
        onDone={handleDecided}
      />

      {toast ? (
        <div
          role="status"
          className="fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[60] mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-md bg-charcoal px-4 py-2 text-center text-sm text-cream shadow-lg sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
