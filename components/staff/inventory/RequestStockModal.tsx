'use client';

// "Request stock" / "Request from warehouse" (docs/INVENTORY-SPEC.md INV-D22,
// docs/WAREHOUSE-SPEC.md). Two steps, and nothing is sent until the second:
//
//   1. Choose   add as many items as you need (search, tick, quantity), or
//               add them from the Stock list with "+ Add"; low items are
//               suggested when you start a fresh request
//   2. Review   every item and quantity in one list — change a quantity,
//               remove a line, add a note — then Send
//
// The list is this person's own draft (useRequestDraft): closing the sheet
// keeps it, reopening brings it back, and sending clears it. On a shared POS
// each PIN operator has their own.

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { formatQty, UNIT_LABELS } from '@/lib/inventory/rules';
import {
  addToDraft,
  draftCount,
  isInDraft,
  MAX_NOTE,
  removeFromDraft,
  requestBodyFrom,
  reviewDraft,
  setDraftNote,
  setDraftQty,
  suggestedQtyText,
} from '@/lib/inventory/requestDraft';
import { api, inputBase, inputClass, primaryButton, secondaryButton, type InventoryItemView } from '@/components/staff/inventory/client';
import type { RequestDraftApi } from '@/components/staff/inventory/useRequestDraft';

export type RequestStep = 'choose' | 'review';

export function RequestStockModal({
  warehouse,
  items,
  draftApi,
  initialStep,
  onClose,
  onSent,
}: {
  /** Filled from the warehouse: the owner is told. */
  warehouse: boolean;
  /** Every stock item (retired ones are not offered). */
  items: InventoryItemView[];
  draftApi: RequestDraftApi;
  initialStep: RequestStep;
  onClose: () => void;
  onSent: (message: string) => Promise<void>;
}) {
  const { draft, update, clear } = draftApi;
  const [step, setStep] = useState<RequestStep>(initialStep);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const stocked = useMemo(() => items.filter((i) => i.isActive), [items]);
  const review = useMemo(() => reviewDraft(draft, items), [draft, items]);
  const count = draftCount(draft);

  // Items retired since they were added are dropped from the draft for good.
  useEffect(() => {
    if (review.dropped.length === 0) return;
    update((prev) => review.dropped.reduce((d, id) => removeFromDraft(d, id), prev));
  }, [review.dropped, update]);

  const q = query.trim().toLowerCase();
  const chosen = review.lines;
  const matches = q ? stocked.filter((i) => !isInDraft(draft, i.id) && (i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q))) : [];
  const title = warehouse ? 'Request from warehouse' : 'Request stock';

  async function send() {
    setError('');
    if (!review.ok) return setError(review.firstProblem ?? 'Check the request.');
    setBusy(true);
    const res = await api<{ id: string }>('/api/inventory/requests', 'POST', requestBodyFrom(review, draft));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    const n = review.lines.length;
    clear();
    await onSent(
      warehouse
        ? `Request sent — ${n} item${n === 1 ? '' : 's'}. The owner has been told and chooses who delivers it.`
        : `Request sent — ${n} item${n === 1 ? '' : 's'}. A manager assigns someone to pick it.`,
    );
  }

  const qtyInput = (itemId: string, name: string, unit: (typeof chosen)[number]['unit'], value: string, invalid: boolean) => (
    <label className="flex items-center gap-1 text-sm">
      <input
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        value={value}
        onChange={(e) => update((d) => setDraftQty(d, itemId, e.target.value))}
        className={`${inputBase} w-24 text-right tabular-nums ${invalid ? 'border-red-400' : ''}`}
        aria-label={`Quantity of ${name}`}
        aria-invalid={invalid || undefined}
      />
      <span className="w-10 text-muted">{UNIT_LABELS[unit]}</span>
    </label>
  );

  if (step === 'review') {
    return (
      <Modal
        open
        onClose={onClose}
        size="lg"
        title="Review your request"
        subtitle={`${count} item${count === 1 ? '' : 's'}. Check each quantity — nothing is sent until you tap Send.`}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className={secondaryButton} onClick={() => setStep('choose')} disabled={busy}>
              ← Add more
            </button>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {error || (!review.ok && review.firstProblem) ? (
                <p className="text-sm text-red-700" role="alert">
                  {error || review.firstProblem}
                </p>
              ) : null}
              <button type="button" className={primaryButton} onClick={send} disabled={busy || !review.ok}>
                {busy ? 'Sending…' : `Send request (${review.lines.length})`}
              </button>
            </div>
          </div>
        }
      >
        {chosen.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#ddd] p-6 text-center text-sm text-muted">
            Nothing in your request yet.{' '}
            <button type="button" className="font-semibold text-charcoal underline" onClick={() => setStep('choose')}>
              Add items
            </button>
          </p>
        ) : (
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-medium">Item</th>
                <th className="hidden py-1 text-right font-medium sm:table-cell">At the store</th>
                <th className="py-1 pl-2 text-right font-medium">Asking for</th>
                <th className="py-1">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {chosen.map((l, idx) => (
                <tr key={l.itemId} className="border-t border-[#f0f0f0] align-top">
                  <td className="py-2 pr-2">
                    <span className="font-semibold text-charcoal">
                      {idx + 1}. {l.name}
                    </span>
                    <span className="block text-xs text-muted sm:hidden">{formatQty(l.onHand, l.unit)} at the store</span>
                    {l.low ? <span className="block text-xs font-semibold text-amber-800">Low</span> : null}
                    {l.warning ? <span className="block text-xs font-semibold text-amber-800">{l.warning}</span> : null}
                    {l.problem ? <span className="block text-xs font-semibold text-red-700">{l.problem}</span> : null}
                  </td>
                  <td className="hidden py-2 text-right text-muted sm:table-cell">{formatQty(l.onHand, l.unit)}</td>
                  <td className="py-2 pl-2">
                    <div className="flex justify-end">{qtyInput(l.itemId, l.name, l.unit, l.qtyText, l.problem !== null)}</div>
                  </td>
                  <td className="py-2 pl-1 text-right">
                    <button
                      type="button"
                      className="min-h-[44px] min-w-[44px] rounded-md text-lg leading-none text-muted hover:bg-[#f4f4f4] hover:text-red-700"
                      onClick={() => update((d) => removeFromDraft(d, l.itemId))}
                      aria-label={`Remove ${l.name} from the request`}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <label className="mt-4 block text-sm">
          <span className="text-charcoal">Note (optional)</span>
          <input
            value={draft.note}
            onChange={(e) => update((d) => setDraftNote(d, e.target.value))}
            className={`${inputClass} mt-1`}
            maxLength={MAX_NOTE}
            placeholder="e.g. needed before the evening rush"
          />
        </label>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={title}
      subtitle="Add everything you need — you’ll review the whole list before it is sent. Your list is kept if you close this."
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted">
            {count} item{count === 1 ? '' : 's'} in your request
          </span>
          <button type="button" className={primaryButton} onClick={() => setStep('review')} disabled={count === 0}>
            Review request →
          </button>
        </div>
      }
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find an item to add"
        className={inputClass}
        aria-label="Find an item to add"
      />
      {matches.length > 0 ? (
        <ul className="mt-2 max-h-56 divide-y divide-[#eee] overflow-y-auto rounded-md border border-[#e5e5e5]">
          {matches.slice(0, 30).map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-[#faf7f4]"
                onClick={() => {
                  update((d) => addToDraft(d, i.id, suggestedQtyText(i)));
                  setQuery('');
                }}
              >
                <span>
                  <span className="font-semibold text-charcoal">{i.name}</span>
                  <span className="block text-xs text-muted">
                    {formatQty(i.onHand, i.unit)} at the store
                    {i.openRequestNumbers.length ? ` · already on #${i.openRequestNumbers.join(', #')}` : ''}
                  </span>
                </span>
                <span className="text-sm font-bold text-tan-dark">+ Add</span>
              </button>
            </li>
          ))}
        </ul>
      ) : q ? (
        <p className="mt-2 text-sm text-muted">No other item matches “{query.trim()}”.</p>
      ) : null}

      <h3 className="mt-4 text-xs font-bold uppercase tracking-[0.15em] text-muted">Your request</h3>
      {chosen.length === 0 ? (
        <p className="mt-2 rounded-md border border-dashed border-[#ddd] p-4 text-center text-sm text-muted">
          Search above, or tap “+ Add” on items in the Stock list.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-[#eee]">
          {chosen.map((l) => (
            <li key={l.itemId} className="flex items-center gap-3 py-2">
              <span className="flex-1 text-sm">
                <span className="font-semibold text-charcoal">{l.name}</span>
                <span className="block text-xs text-muted">
                  {formatQty(l.onHand, l.unit)} at the store{l.warning ? ` · ${l.warning.toLowerCase()}` : ''}
                </span>
              </span>
              {qtyInput(l.itemId, l.name, l.unit, l.qtyText, false)}
              <button
                type="button"
                className="min-h-[44px] min-w-[44px] rounded-md text-lg leading-none text-muted hover:bg-[#f4f4f4] hover:text-red-700"
                onClick={() => update((d) => removeFromDraft(d, l.itemId))}
                aria-label={`Remove ${l.name} from the request`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
