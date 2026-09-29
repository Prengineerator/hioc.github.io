'use client';

// Store expenses paid from the cash drawer — ice, water, milk (lib/cash/expenses.ts).
// Any counter staffer can punch one: a category, an amount and an optional
// note. It is recorded as a categorised cash-out, so the drawer math stays
// right (no phantom shortage) and the owner sees every rupee that left the
// drawer. Manager-only bank deposits / float top-ups stay in CashMovementForm.
// Validation uses the SAME validateExpense as POST /api/cash-expenses.

import { useCallback, useEffect, useState } from 'react';
import {
  EXPENSE_CATEGORIES,
  MAX_EXPENSE_NOTE_LEN,
  expenseCategoryLabel,
  validateExpense,
  type ApproveExpensesBody,
  type ApproveExpensesResponse,
  type ExpenseBody,
  type ExpenseEntry,
  type ExpenseListResponse,
  type ExpenseStatus,
} from '@/lib/cash/expenses';

// IST, same shape as the owner cash screen's formatWhen.
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

const PILL: Record<ExpenseStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-100 text-amber-900' },
  approved: { label: 'Approved', className: 'bg-green-100 text-green-800' },
  undone: { label: 'Undone', className: 'bg-surface text-muted' },
};

function StatusPill({ status }: { status: ExpenseStatus }) {
  const p = PILL[status];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${p.className}`}>{p.label}</span>
  );
}

export function CashExpenseForm() {
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [list, setList] = useState<ExpenseListResponse | null>(null);
  const [listError, setListError] = useState('');
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveMsg, setApproveMsg] = useState('');

  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/cash-expenses', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // 403 carries a message fit to show; anything else keeps last-known-good.
        if (res.status === 403) setListError((data?.error as string) ?? "You don't have permission to see expenses.");
        return;
      }
      setListError('');
      setList(data as ExpenseListResponse);
    } catch {
      /* keep last-known-good */
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const amountInr = amount.trim() === '' ? 0 : Number(amount);
  const checked = validateExpense({ category, amountInr, note });
  const readyLabel =
    checked.ok
      ? `Record ${inr(checked.expense.amountInr)} — ${expenseCategoryLabel(checked.expense.category)}`
      : 'Record expense';

  async function submit() {
    if (busy) return;
    setError('');
    setNotice('');
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    try {
      const body: ExpenseBody = {
        category: checked.expense.category,
        amountInr: checked.expense.amountInr,
        note: checked.expense.note,
      };
      const res = await fetch('/api/cash-expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        setError((data.error as string) ?? 'Could not record that.');
        return;
      }
      const recorded = (data as { expense?: ExpenseEntry }).expense;
      setNotice(
        `Recorded ${inr(body.amountInr)} — ${expenseCategoryLabel(body.category)}.` +
          (recorded?.status === 'approved' ? '' : " You can undo it until it's approved."),
      );
      setAmount('');
      setNote('');
      setCategory('');
      await loadList();
    } catch {
      setError('Network problem — please try again.');
    } finally {
      setBusy(false);
    }
  }

  const isOther = category === 'other';

  const approvable = list ? list.expenses.filter((e) => e.canApprove) : [];

  async function approve(ids: string[]) {
    if (approveBusy || ids.length === 0) return;
    setApproveBusy(true);
    setApproveMsg('');
    try {
      const body: ApproveExpensesBody = { ids };
      const res = await fetch('/api/cash-expenses/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        setApproveMsg((data.error as string) ?? 'Could not approve.');
        return;
      }
      const r = data as ApproveExpensesResponse;
      setApproveMsg(`Approved ${r.approved.length}; skipped ${r.skipped.length}.`);
      await loadList();
    } catch {
      setApproveMsg('Network problem — please try again.');
    } finally {
      setApproveBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-md px-4 pb-6">
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted">Expenses</h2>
      <p className="mt-1 text-xs text-muted">
        Paid for something from the drawer — ice, water, milk? Punch it here so the cash matches.
      </p>

      <div className="mt-3 rounded-md border border-line bg-white p-4">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="What was it for?">
          {EXPENSE_CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(c.key)}
              disabled={busy}
              aria-pressed={category === c.key}
              className={`min-h-[44px] rounded-md border px-3 py-2.5 text-sm font-bold transition-colors disabled:opacity-50 ${
                category === c.key ? 'border-charcoal bg-charcoal text-cream' : 'border-[#ddd] text-charcoal'
              }`}
            >
              {c.label}
            </button>
          ))}
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
            className="mt-1 min-h-[44px] w-full rounded-md border border-line px-3 py-2.5 text-right text-base tabular-nums focus:border-tan focus:outline-none disabled:bg-surface"
          />
        </label>

        <label className="mt-3 block text-sm">
          <span className="text-charcoal">Note{isOther ? '' : ' (optional)'}</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={MAX_EXPENSE_NOTE_LEN}
            placeholder={isOther ? 'What was it for? (required)' : 'e.g. 2 bags from the ice vendor'}
            disabled={busy}
            className="mt-1 min-h-[44px] w-full rounded-md border border-line px-3 py-2.5 text-sm focus:border-tan focus:outline-none disabled:bg-surface"
          />
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="mt-4 min-h-[44px] w-full rounded-md bg-tan-dark px-4 py-2.5 text-sm font-bold text-cream transition-colors hover:bg-tan-darker disabled:opacity-50"
        >
          {busy ? 'Recording…' : readyLabel}
        </button>

        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-green-700">{notice}</p> : null}
      </div>

      {listError ? <p className="mt-4 text-sm text-red-700">{listError}</p> : null}

      {list ? (
        <div className="mt-4">
          <p className="text-sm font-bold text-charcoal">
            {list.dayOpen ? 'Today' : 'Last 24 hours'}: {inr(list.totalInr)} · {list.expenses.length}{' '}
            {list.expenses.length === 1 ? 'entry' : 'entries'}
            {list.pendingInr > 0 ? ` · ${inr(list.pendingInr)} awaiting approval` : ''}
          </p>
          {approvable.length >= 2 ? (
            <button
              type="button"
              onClick={() => void approve(approvable.map((e) => e.id))}
              disabled={approveBusy}
              className="mt-2 min-h-[44px] w-full rounded-md bg-tan-dark px-4 py-2.5 text-sm font-bold text-cream transition-colors hover:bg-tan-darker disabled:opacity-50"
            >
              {approveBusy ? 'Approving…' : `Approve all (${approvable.length})`}
            </button>
          ) : null}
          {approveMsg ? <p className="mt-2 text-sm text-charcoal">{approveMsg}</p> : null}
          {list.expenses.length > 0 ? (
            <ul className="mt-2 divide-y divide-[#eee] rounded-md border border-line bg-white">
              {list.expenses.map((e) => (
                <ExpenseRow
                  key={e.id}
                  entry={e}
                  approveBusy={approveBusy}
                  onApprove={() => void approve([e.id])}
                  onChanged={loadList}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ExpenseRow({
  entry,
  approveBusy,
  onApprove,
  onChanged,
}: {
  entry: ExpenseEntry;
  approveBusy: boolean;
  onApprove: () => void;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [rowError, setRowError] = useState('');

  const label = entry.categoryLabel || expenseCategoryLabel(entry.category);
  const showNote = entry.reason && entry.reason !== label;
  const undone = entry.status === 'undone';

  async function undo() {
    if (undoing) return;
    setUndoing(true);
    setRowError('');
    try {
      const res = await fetch(`/api/cash-expenses/${entry.id}/undo`, { method: 'POST' });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        setRowError((data.error as string) ?? 'Could not undo that.');
        setConfirming(false);
        await onChanged();
        return;
      }
      setConfirming(false);
      await onChanged();
    } catch {
      setRowError('Network problem — please try again.');
    } finally {
      setUndoing(false);
    }
  }

  return (
    <li className={`px-4 py-3 text-sm ${undone ? 'bg-surface/50' : ''}`}>
      <div className={`flex items-center justify-between gap-2 ${undone ? 'text-muted' : ''}`}>
        <span className={`font-bold ${undone ? 'text-muted' : 'text-charcoal'}`}>{label}</span>
        <span className={`shrink-0 font-bold tabular-nums ${undone ? 'text-muted line-through' : 'text-charcoal'}`}>
          − {inr(entry.amountInr)}
        </span>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
        <StatusPill status={entry.status} />
        {entry.status === 'approved' && entry.approvedByName ? <span>by {entry.approvedByName}</span> : null}
        {undone ? <span>Undone by {entry.undoneByName ?? 'staff'}</span> : null}
      </p>
      {showNote ? <p className={`mt-0.5 text-xs ${undone ? 'text-muted' : 'text-charcoal'}`}>{entry.reason}</p> : null}
      <p className="mt-0.5 text-xs text-muted">
        {entry.recordedByName ? `${entry.recordedByName} · ` : ''}
        {formatWhen(entry.createdAt)}
      </p>

      {confirming ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-charcoal">
            Undo {inr(entry.amountInr)} {label}?
          </span>
          <button
            type="button"
            onClick={() => void undo()}
            disabled={undoing}
            className="min-h-[44px] rounded-md bg-red-700 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-800 disabled:opacity-50"
          >
            {undoing ? 'Undoing…' : 'Yes'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={undoing}
            className="min-h-[44px] rounded-md border border-[#ddd] px-4 py-2 text-sm font-bold text-charcoal disabled:opacity-50"
          >
            No
          </button>
        </div>
      ) : entry.canUndo || entry.canApprove ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {entry.canApprove ? (
            <button
              type="button"
              onClick={onApprove}
              disabled={approveBusy}
              className="min-h-[44px] rounded-md bg-tan-dark px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-darker disabled:opacity-50"
            >
              Approve
            </button>
          ) : null}
          {entry.canUndo ? (
            <button
              type="button"
              onClick={() => {
                setRowError('');
                setConfirming(true);
              }}
              className="min-h-[44px] rounded-md border border-[#ddd] px-4 py-2 text-sm font-bold text-charcoal"
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
      {rowError ? (
        <p role="alert" className="mt-2 text-xs font-bold text-red-700">
          {rowError}
        </p>
      ) : null}
    </li>
  );
}
