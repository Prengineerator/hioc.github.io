'use client';

// Owner → Warehouse → Stock sheet (docs/WAREHOUSE-SPEC.md). One row per stock
// item: what the warehouse holds (with its own low level and expiry), what is
// on the road each way, what the store holds, and what the store has asked
// for that hasn't been sent. The owner keeps the warehouse side of it:
//
//   Record purchase   stock bought in (or the opening count), one batch per line
//   Count             what is physically there; clears "count needed"
//   Write off         thrown away — a batch, or earliest expiry first
//   Low level         when the warehouse should buy more
//
// Items themselves (name, unit, perishable) are added and edited on the Stock
// screen, as before, so one item means the same thing in both places.

import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { expiryState, formatQty, UNIT_LABELS } from '@/lib/inventory/rules';
import {
  api,
  inputBase,
  inputClass,
  primaryButton,
  secondaryButton,
  shortDate,
  when,
  type WarehousePayload,
  type WarehouseSheetRow,
} from '@/components/owner/warehouse/client';

type Filter = 'all' | 'low' | 'attention' | 'moving';

function Chip({ tone, children }: { tone: 'red' | 'amber' | 'grey' | 'blue'; children: React.ReactNode }) {
  const tones = {
    red: 'border-red-200 bg-red-50 text-red-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    grey: 'border-line bg-[#f4f4f4] text-muted',
    blue: 'border-blue-200 bg-blue-50 text-blue-900',
  };
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

const needsAttention = (r: WarehouseSheetRow) => r.warehouse.countNeeded || r.warehouse.expiredQty > 0 || r.warehouse.soonQty > 0;
const moving = (r: WarehouseSheetRow) => r.inTransit.toStore > 0 || r.inTransit.toWarehouse > 0 || r.awaitingDispatch > 0;

export function SheetTab({ data, reload }: { data: WarehousePayload; reload: () => Promise<void> }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [adjusting, setAdjusting] = useState<{ row: WarehouseSheetRow; kind: 'count' | 'waste' } | null>(null);
  const [levelFor, setLevelFor] = useState<WarehouseSheetRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const counts = {
    low: data.items.filter((r) => r.warehouse.low).length,
    attention: data.items.filter(needsAttention).length,
    moving: data.items.filter(moving).length,
  };
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.items
      .filter((r) => (filter === 'low' ? r.warehouse.low : filter === 'attention' ? needsAttention(r) : filter === 'moving' ? moving(r) : true))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q))
      .sort((a, b) => (a.category || 'Other').localeCompare(b.category || 'Other') || a.name.localeCompare(b.name));
  }, [data.items, filter, query]);

  const done = async (message: string) => {
    setPurchaseOpen(false);
    setAdjusting(null);
    setLevelFor(null);
    setNotice(message);
    await reload();
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} onClick={() => setPurchaseOpen(true)} disabled={data.items.length === 0}>
          Record purchase
        </button>
        <a href="/api/owner/warehouse/sheet" className={`${secondaryButton} inline-flex items-center`} download>
          Download sheet (CSV)
        </a>
      </div>
      {notice ? (
        <p role="status" className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          {notice}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stock"
          className={`${inputBase} w-full max-w-xs`}
          aria-label="Search the stock sheet"
        />
        {(
          [
            ['all', 'All'],
            ['low', `Low in warehouse (${counts.low})`],
            ['attention', `Needs attention (${counts.attention})`],
            ['moving', `Moving (${counts.moving})`],
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`min-h-[44px] rounded-full border px-4 text-sm font-semibold ${
              filter === f ? 'border-charcoal bg-charcoal text-cream' : 'border-[#ddd] bg-white text-charcoal'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {data.items.length === 0 ? (
        <p className="mt-6 rounded-md border border-dashed border-[#ddd] bg-white p-6 text-center text-sm text-muted">
          No stock items yet. Add them on the Stock screen (staff site → More → Stock → Add item); they appear here for the warehouse.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-md border border-line bg-white">
          <table className="w-full min-w-[760px] text-sm tabular-nums">
            <thead className="bg-surface text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Warehouse</th>
                <th className="px-3 py-2 text-right font-medium">Low at</th>
                <th className="px-3 py-2 text-right font-medium">→ Store</th>
                <th className="px-3 py-2 text-right font-medium">→ Warehouse</th>
                <th className="px-3 py-2 text-right font-medium">Store</th>
                <th className="px-3 py-2 text-right font-medium">Asked, not sent</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <SheetRow
                  key={r.id}
                  row={r}
                  today={data.today}
                  open={expanded === r.id}
                  onToggle={() => setExpanded((v) => (v === r.id ? null : r.id))}
                  onCount={() => setAdjusting({ row: r, kind: 'count' })}
                  onWaste={() => setAdjusting({ row: r, kind: 'waste' })}
                  onLevel={() => setLevelFor(r)}
                />
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-muted">
                    Nothing matches.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {purchaseOpen ? <PurchaseModal data={data} onClose={() => setPurchaseOpen(false)} onDone={done} /> : null}
      {adjusting ? <AdjustModal row={adjusting.row} kind={adjusting.kind} onClose={() => setAdjusting(null)} onDone={done} /> : null}
      {levelFor ? <LevelModal row={levelFor} onClose={() => setLevelFor(null)} onDone={done} /> : null}
    </div>
  );
}

function SheetRow({
  row: r,
  today,
  open,
  onToggle,
  onCount,
  onWaste,
  onLevel,
}: {
  row: WarehouseSheetRow;
  today: string;
  open: boolean;
  onToggle: () => void;
  onCount: () => void;
  onWaste: () => void;
  onLevel: () => void;
}) {
  const w = r.warehouse;
  return (
    <>
      <tr className="border-t border-[#f0f0f0] align-top">
        <td className="px-3 py-2">
          <button type="button" onClick={onToggle} aria-expanded={open} className="text-left font-semibold text-charcoal underline-offset-2 hover:underline">
            {r.name}
          </button>
          <span className="block text-xs text-muted">{r.category || 'Other'}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {!r.isActive ? <Chip tone="grey">Retired</Chip> : null}
            {w.low ? <Chip tone="amber">Low — buy</Chip> : null}
            {w.countNeeded ? <Chip tone="red">Count needed</Chip> : null}
            {w.expiredQty > 0 ? <Chip tone="red">{formatQty(w.expiredQty, r.unit)} expired</Chip> : null}
            {w.soonQty > 0 ? <Chip tone="amber">{formatQty(w.soonQty, r.unit)} expiring soon</Chip> : null}
            {r.storeLow ? <Chip tone="blue">Low at the store</Chip> : null}
          </span>
        </td>
        <td className="px-3 py-2 text-right font-semibold">
          {formatQty(w.onHand, r.unit)}
          {w.nextExpiry ? <span className="block text-xs font-normal text-muted">next expiry {shortDate(w.nextExpiry)}</span> : null}
        </td>
        <td className="px-3 py-2 text-right">{w.parLevel > 0 ? formatQty(w.parLevel, r.unit) : '—'}</td>
        <td className="px-3 py-2 text-right">{r.inTransit.toStore > 0 ? formatQty(r.inTransit.toStore, r.unit) : '—'}</td>
        <td className="px-3 py-2 text-right">{r.inTransit.toWarehouse > 0 ? formatQty(r.inTransit.toWarehouse, r.unit) : '—'}</td>
        <td className="px-3 py-2 text-right">{formatQty(r.storeOnHand, r.unit)}</td>
        <td className="px-3 py-2 text-right">{r.awaitingDispatch > 0 ? formatQty(r.awaitingDispatch, r.unit) : '—'}</td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap justify-end gap-1.5">
            <button type="button" className="min-h-[36px] rounded-md border border-[#ddd] px-2.5 text-xs font-bold text-charcoal hover:border-charcoal" onClick={onCount}>
              Count
            </button>
            <button
              type="button"
              className="min-h-[36px] rounded-md border border-[#ddd] px-2.5 text-xs font-bold text-charcoal hover:border-charcoal disabled:opacity-50"
              onClick={onWaste}
              disabled={w.onHand <= 0}
            >
              Write off
            </button>
            <button type="button" className="min-h-[36px] rounded-md border border-[#ddd] px-2.5 text-xs font-bold text-charcoal hover:border-charcoal" onClick={onLevel}>
              Low level
            </button>
          </div>
        </td>
      </tr>
      {open ? (
        <tr className="bg-[#fcfaf8]">
          <td colSpan={8} className="px-3 pb-3 pt-1">
            {w.batches.length === 0 ? (
              <p className="text-xs text-muted">Nothing in the warehouse.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {w.batches.map((b) => {
                  const state = expiryState(b.expiryDate, today);
                  return (
                    <li key={b.id} className="flex flex-wrap gap-x-3">
                      <span className="font-semibold text-charcoal">{formatQty(b.qtyRemaining, r.unit)}</span>
                      <span className={state === 'expired' ? 'font-semibold text-red-700' : state === 'soon' ? 'font-semibold text-amber-800' : 'text-muted'}>
                        {b.expiryDate ? `expires ${shortDate(b.expiryDate)}` : 'no expiry date'}
                      </span>
                      <span className="text-muted">
                        {b.source === 'purchase' ? `bought${b.supplier ? ` from ${b.supplier}` : ''}` : b.source === 'return' ? 'returned by the store' : b.source === 'count' ? 'found in a count' : 'came back from a delivery'}{' '}
                        {when(b.receivedAt)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {w.lastCountedAt ? <p className="mt-1 text-xs text-muted">Last counted {when(w.lastCountedAt)}</p> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

type DoneFn = (message: string) => Promise<void>;

interface PurchaseLine {
  key: number;
  itemId: string;
  qty: string;
  expiry: string;
}

function PurchaseModal({ data, onClose, onDone }: { data: WarehousePayload; onClose: () => void; onDone: DoneFn }) {
  const items = data.items.filter((i) => i.isActive);
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<PurchaseLine[]>([{ key: 1, itemId: '', qty: '', expiry: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const byId = new Map(items.map((i) => [i.id, i]));

  const update = (key: number, patch: Partial<PurchaseLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function submit() {
    setError('');
    const filled = lines.filter((l) => l.itemId);
    if (filled.length === 0) return setError('Add at least one item.');
    for (const l of filled) {
      const item = byId.get(l.itemId);
      if (!(Number(l.qty) > 0)) return setError(`Enter how much ${item?.name ?? 'of each item'} came in.`);
      if (item?.tracksExpiry && !l.expiry) return setError(`Enter the expiry date for ${item.name}.`);
    }
    setBusy(true);
    const res = await api(`/api/owner/warehouse/purchases`, 'POST', {
      supplier,
      note,
      lines: filled.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), expiryDate: l.expiry || null })),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone(`Purchase recorded: ${filled.length} line${filled.length === 1 ? '' : 's'} added to the warehouse.`);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Record a purchase"
      subtitle="What came into the warehouse. Each line is one batch — add the same item twice for two expiry dates. Use this for the opening count too."
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Add to the warehouse'}
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-charcoal">Supplier (optional)</span>
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className={`${inputClass} mt-1`} maxLength={120} />
        </label>
        <label className="block text-sm">
          <span className="text-charcoal">Note (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputClass} mt-1`} maxLength={120} placeholder="e.g. bill no. 4411" />
        </label>
      </div>
      <ul className="mt-4 space-y-3">
        {lines.map((l) => {
          const item = byId.get(l.itemId);
          return (
            <li key={l.key} className="rounded-md border border-line p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
                <label className="block text-sm">
                  <span className="text-muted">Item</span>
                  <select value={l.itemId} onChange={(e) => update(l.key, { itemId: e.target.value })} className={`${inputClass} mt-1`}>
                    <option value="">Choose…</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} ({UNIT_LABELS[i.unit]})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-muted">Quantity{item ? ` (${UNIT_LABELS[item.unit]})` : ''}</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={l.qty}
                    onChange={(e) => update(l.key, { qty: e.target.value })}
                    className={`${inputClass} mt-1 text-right tabular-nums`}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-muted">Expiry{item && !item.tracksExpiry ? ' (optional)' : ''}</span>
                  <input
                    type="date"
                    min={data.today}
                    value={l.expiry}
                    onChange={(e) => update(l.key, { expiry: e.target.value })}
                    className={`${inputClass} mt-1`}
                  />
                </label>
                <button
                  type="button"
                  className="min-h-[44px] text-sm font-semibold text-muted underline disabled:opacity-40"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  disabled={lines.length === 1}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={`${secondaryButton} mt-3`}
        onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, itemId: '', qty: '', expiry: '' }])}
        disabled={lines.length >= 60}
      >
        Add a line
      </button>
    </Modal>
  );
}

function AdjustModal({ row, kind, onClose, onDone }: { row: WarehouseSheetRow; kind: 'count' | 'waste'; onClose: () => void; onDone: DoneFn }) {
  const [qty, setQty] = useState('');
  const [batchId, setBatchId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (qty === '' || !Number.isFinite(Number(qty))) return setError(kind === 'count' ? 'Enter what you counted.' : 'Enter how much was thrown away.');
    setBusy(true);
    const res = await api(`/api/owner/warehouse/items/${row.id}/adjust`, 'POST', {
      kind,
      qty: Number(qty),
      reason,
      batchId: kind === 'waste' && batchId ? batchId : null,
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone(kind === 'count' ? `${row.name}: count saved.` : `${row.name}: written off.`);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={kind === 'count' ? `Count ${row.name}` : `Write off ${row.name}`}
      subtitle={
        kind === 'count'
          ? `The sheet says ${formatQty(row.warehouse.onHand, row.unit)}. Enter what is physically in the warehouse.`
          : `The warehouse holds ${formatQty(row.warehouse.onHand, row.unit)}.`
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy || (kind === 'waste' && reason.trim().length < 3)}>
            {busy ? 'Saving…' : kind === 'count' ? 'Save count' : 'Write off'}
          </button>
        </div>
      }
    >
      <label className="block text-sm">
        <span className="text-charcoal">{kind === 'count' ? 'Counted' : 'Thrown away'} ({UNIT_LABELS[row.unit]})</span>
        <input
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className={`${inputClass} mt-1 text-right tabular-nums`}
        />
      </label>
      {kind === 'waste' && row.warehouse.batches.length > 1 ? (
        <label className="mt-3 block text-sm">
          <span className="text-charcoal">From</span>
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)} className={`${inputClass} mt-1`}>
            <option value="">Earliest expiry first</option>
            {row.warehouse.batches.map((b) => (
              <option key={b.id} value={b.id}>
                {formatQty(b.qtyRemaining, row.unit)} — {b.expiryDate ? `expires ${shortDate(b.expiryDate)}` : 'no expiry date'}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="mt-3 block text-sm">
        <span className="text-charcoal">Reason{kind === 'count' ? ' (optional)' : ''}</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} mt-1`} placeholder={kind === 'count' ? 'e.g. monthly count' : 'e.g. expired, rats got into it'} />
      </label>
    </Modal>
  );
}

function LevelModal({ row, onClose, onDone }: { row: WarehouseSheetRow; onClose: () => void; onDone: DoneFn }) {
  const [level, setLevel] = useState(row.warehouse.parLevel > 0 ? String(row.warehouse.parLevel) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    setBusy(true);
    const res = await api(`/api/owner/warehouse/items/${row.id}`, 'PATCH', { parLevel: level === '' ? 0 : Number(level) });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone(`${row.name}: low level saved.`);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`${row.name}: warehouse low level`}
      subtitle="At or below this, the item shows as “Low — buy”. Leave empty for never. The store has its own low level on the Stock screen."
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <label className="block text-sm">
        <span className="text-charcoal">Low at ({UNIT_LABELS[row.unit]})</span>
        <input
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className={`${inputClass} mt-1 text-right tabular-nums`}
        />
      </label>
    </Modal>
  );
}
