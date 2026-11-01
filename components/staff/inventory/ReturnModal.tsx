'use client';

// "Send back to warehouse" (docs/WAREHOUSE-SPEC.md, WH-D6) — a manager sends
// store stock to the warehouse: too much of something, a near-expiry batch
// the warehouse can use elsewhere, an item being retired. It leaves the
// store's stock the moment it is sent (earliest expiry first) and is in
// transit until the owner counts it in at the warehouse; the owner is told.
// POST /api/inventory/returns re-checks everything, and refuses more than the
// store's records hold (count it first).

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { formatQty, UNIT_LABELS } from '@/lib/inventory/rules';
import {
  api,
  inputBase,
  inputClass,
  primaryButton,
  shortDate,
  type InventoryItemView,
  type PersonRef,
} from '@/components/staff/inventory/client';
import { DelivererPicker, type DelivererChoice } from '@/components/staff/inventory/DelivererPicker';

export function ReturnModal({
  items,
  people,
  onClose,
  onDone,
}: {
  items: InventoryItemView[];
  people: PersonRef[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const stocked = items.filter((i) => i.onHand > 0);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [who, setWho] = useState<DelivererChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = Object.keys(qty);
  const q = query.trim().toLowerCase();
  const shown = stocked.filter((i) => chosen.includes(i.id) || (q && i.name.toLowerCase().includes(q)));

  async function submit() {
    setError('');
    const lines = chosen.map((id) => ({ itemId: id, qty: Number(qty[id]) }));
    if (lines.length === 0) return setError('Pick at least one item to send back.');
    for (const l of lines) {
      const item = stocked.find((i) => i.id === l.itemId);
      if (!Number.isFinite(l.qty) || l.qty <= 0) return setError(`Enter how much ${item?.name ?? 'of each item'} is going back.`);
      if (item && l.qty > item.onHand) return setError(`The store only has ${formatQty(item.onHand, item.unit)} of ${item.name}.`);
    }
    if (!who) return setError('Say who is taking it to the warehouse.');
    setBusy(true);
    const res = await api<{ id: string; emailed: string }>('/api/inventory/returns', 'POST', { lines, note, ...who });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone('On its way to the warehouse — it has come off the store’s stock. The owner has been told and counts it in.');
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Send back to warehouse"
      subtitle="It comes off the store’s stock now, earliest expiry first, and the owner counts it in at the warehouse. Anything that doesn’t match is flagged."
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span className="text-sm text-muted">{chosen.length} item(s)</span>}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy}>
            {busy ? 'Sending…' : 'Send it back'}
          </button>
        </div>
      }
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find an item to send back"
        className={inputClass}
        aria-label="Find an item to send back"
      />
      <ul className="mt-3 divide-y divide-[#eee]">
        {shown.map((i) => {
          const on = i.id in qty;
          return (
            <li key={i.id} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                checked={on}
                className="h-5 w-5"
                aria-label={`Send back ${i.name}`}
                onChange={(e) =>
                  setQty((prev) => {
                    const next = { ...prev };
                    if (e.target.checked) next[i.id] = '';
                    else delete next[i.id];
                    return next;
                  })
                }
              />
              <span className="flex-1 text-sm">
                <span className="font-semibold text-charcoal">{i.name}</span>
                <span className="block text-xs text-muted">
                  {formatQty(i.onHand, i.unit)} at the store{i.nextExpiry ? ` · earliest expiry ${shortDate(i.nextExpiry)}` : ''}
                </span>
              </span>
              {on ? (
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="number"
                    min={0}
                    max={i.onHand}
                    step="any"
                    inputMode="decimal"
                    value={qty[i.id]}
                    onChange={(e) => setQty((prev) => ({ ...prev, [i.id]: e.target.value }))}
                    className={`${inputBase} w-24 text-right tabular-nums`}
                    aria-label={`Quantity of ${i.name} to send back`}
                  />
                  <span className="w-10 text-muted">{UNIT_LABELS[i.unit]}</span>
                </label>
              ) : null}
            </li>
          );
        })}
        {shown.length === 0 ? (
          <li className="py-4 text-center text-sm text-muted">{stocked.length ? 'Search to add an item.' : 'The store has no stock to send back.'}</li>
        ) : null}
      </ul>
      <div className="mt-4">
        <DelivererPicker idPrefix="return" people={people} onChange={setWho} />
      </div>
      <label className="mt-3 block text-sm">
        <span className="text-charcoal">Why (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputClass} mt-1`} maxLength={300} placeholder="e.g. too many cups, the warehouse can use them" />
      </label>
    </Modal>
  );
}
