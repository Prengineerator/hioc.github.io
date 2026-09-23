'use client';

// CC-3 — manager/owner entries for money that moves through the drawer
// without being a sale: bank deposits, petty expenses, float top-ups
// (docs/PHASE-5-CASH-COUNTS.md). Without these, a deposit or a top-up would
// read as a shortage/overage at the next count. Rendered on the cash page
// only when the server has already decided the signed-in account is
// manager/owner (see app/staff/cash/page.tsx).

import { useCallback, useEffect, useState } from 'react';
import type { CashMovementBody } from '@/lib/cash/counts';

interface MovementRaw {
  id?: string;
  direction?: 'out' | 'in';
  amountInr?: number;
  amount_inr?: number;
  reason?: string;
  createdByName?: string;
  created_by_name?: string;
  createdAt?: string;
  created_at?: string;
}

interface MovementView {
  id: string;
  direction: 'out' | 'in';
  amountInr: number;
  reason: string;
  createdByName: string;
}

function extractList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.movements)) return obj.movements;
    if (Array.isArray(obj.rows)) return obj.rows;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

function normalize(m: MovementRaw, i: number): MovementView {
  return {
    id: m.id ?? String(i),
    direction: m.direction === 'in' ? 'in' : 'out',
    amountInr: Math.max(0, Math.floor(Number(m.amountInr ?? m.amount_inr) || 0)),
    reason: m.reason ?? '',
    createdByName: m.createdByName ?? m.created_by_name ?? '',
  };
}

export function CashMovementForm() {
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recent, setRecent] = useState<MovementView[]>([]);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch('/api/cash-movements', { cache: 'no-store' });
      if (!res.ok) return; // GET may not exist yet — the form still works without it
      const data = await res.json().catch(() => null);
      setRecent(extractList(data).map((m, i) => normalize(m as MovementRaw, i)));
    } catch {
      /* keep last-known-good */
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  async function submit() {
    setError('');
    setNotice('');
    const amountInr = Math.floor(Number(amount));
    if (!Number.isFinite(amountInr) || amountInr <= 0) {
      setError('Enter an amount greater than ₹0.');
      return;
    }
    if (reason.trim().length < 5) {
      setError('Say what this is for (at least 5 characters) — the owner sees this note.');
      return;
    }
    setBusy(true);
    try {
      const body: CashMovementBody = { direction, amountInr, reason: reason.trim() };
      const res = await fetch('/api/cash-movements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        setError((data.error as string) ?? 'Could not record that.');
        return;
      }
      setNotice(`Recorded ₹${amountInr} cash ${direction}.`);
      setAmount('');
      setReason('');
      await loadRecent();
    } catch {
      setError('Network problem — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-md px-4 pb-10">
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted">Cash out / cash in</h2>
      <p className="mt-1 text-xs text-muted">
        For bank deposits, petty expenses and float top-ups — so a deposit or top-up never reads as a shortage.
      </p>

      <div className="mt-3 rounded-md border border-[#e5e5e5] bg-white p-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDirection('out')}
            disabled={busy}
            className={`min-h-[44px] rounded-md border px-3 py-2.5 text-sm font-bold transition-colors disabled:opacity-50 ${
              direction === 'out' ? 'border-charcoal bg-charcoal text-cream' : 'border-[#ddd] text-charcoal'
            }`}
          >
            Cash out
          </button>
          <button
            type="button"
            onClick={() => setDirection('in')}
            disabled={busy}
            className={`min-h-[44px] rounded-md border px-3 py-2.5 text-sm font-bold transition-colors disabled:opacity-50 ${
              direction === 'in' ? 'border-charcoal bg-charcoal text-cream' : 'border-[#ddd] text-charcoal'
            }`}
          >
            Cash in
          </button>
        </div>

        <label className="mt-3 block text-sm">
          <span className="text-charcoal">Amount (₹)</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            disabled={busy}
            className="mt-1 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-right text-base tabular-nums focus:border-tan focus:outline-none disabled:bg-[#f6efe9]"
          />
        </label>

        <label className="mt-3 block text-sm">
          <span className="text-charcoal">Reason</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={direction === 'out' ? 'e.g. bank deposit' : 'e.g. float top-up'}
            disabled={busy}
            className="mt-1 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none disabled:bg-[#f6efe9]"
          />
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="mt-4 min-h-[44px] w-full rounded-md bg-tan px-4 py-2.5 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:opacity-50"
        >
          {busy ? 'Recording…' : `Record cash ${direction}`}
        </button>

        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-green-700">{notice}</p> : null}
      </div>

      {recent.length > 0 ? (
        <ul className="mt-4 divide-y divide-[#eee] rounded-md border border-[#e5e5e5] bg-white">
          {recent.slice(0, 10).map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 px-4 py-3 text-sm">
              <span className="text-charcoal">
                {m.direction === 'out' ? '−' : '+'} ₹{m.amountInr}
                {m.reason ? <span className="ml-2 text-xs text-muted">{m.reason}</span> : null}
              </span>
              {m.createdByName ? <span className="shrink-0 text-xs text-muted">{m.createdByName}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
