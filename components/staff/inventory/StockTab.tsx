'use client';

// Stock tab (docs/INVENTORY-SPEC.md, INV-2/3/6). Every stock item with what is
// on the shelf, flagged when low, expiring, expired, or when sales ran past
// the records ("count needed"). Anyone can tap "Request stock"; a manager or
// the owner also adds/edits items, counts, writes off, and — at the POS —
// receives a delivery that had no request behind it.

import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import {
  expiryState,
  formatQty,
  INVENTORY_UNITS,
  UNIT_LABELS,
  suggestedRequestQty,
  type InventoryUnit,
} from '@/lib/inventory/rules';
import {
  api,
  inputBase,
  inputClass,
  primaryButton,
  secondaryButton,
  shortDate,
  type InventoryItemView,
  type ItemsPayload,
} from '@/components/staff/inventory/client';
import type { StaffSurface } from '@/lib/staff/surfaceRules';

type Filter = 'all' | 'attention';

function needsAttention(i: InventoryItemView): boolean {
  return i.isActive && (i.low || i.countNeeded || i.expiredQty > 0 || i.soonQty > 0);
}

function Chip({ tone, children }: { tone: 'red' | 'amber' | 'grey' | 'green'; children: React.ReactNode }) {
  const cls = {
    red: 'bg-red-50 text-red-800 border-red-200',
    amber: 'bg-amber-50 text-amber-900 border-amber-200',
    grey: 'bg-[#f4f4f4] text-muted border-[#e5e5e5]',
    green: 'bg-green-50 text-green-800 border-green-200',
  }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

export function StockTab({
  data,
  surface,
  reload,
  onRequested,
}: {
  data: ItemsPayload;
  surface: StaffSurface;
  reload: () => Promise<void>;
  onRequested: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [requestOpen, setRequestOpen] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryItemView | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<{ item: InventoryItemView; kind: 'waste' | 'count' } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.items
      .filter((i) => (data.canManage ? true : i.isActive))
      .filter((i) => (filter === 'attention' ? needsAttention(i) : true))
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
  }, [data, filter, query]);

  const attentionCount = data.items.filter(needsAttention).length;
  const groups = useMemo(() => {
    const map = new Map<string, InventoryItemView[]>();
    for (const i of visible) {
      const key = i.category || 'Other';
      map.set(key, [...(map.get(key) ?? []), i]);
    }
    return [...map].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} onClick={() => setRequestOpen(true)}>
          Request stock
        </button>
        {data.canManage && surface === 'pos' ? (
          <button type="button" className={secondaryButton} onClick={() => setDeliveryOpen(true)}>
            Receive delivery
          </button>
        ) : null}
        {data.canManage ? (
          <button type="button" className={secondaryButton} onClick={() => setEditing('new')}>
            Add item
          </button>
        ) : null}
      </div>

      <AutoHidePanel data={data} reload={reload} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stock"
          className={`${inputBase} w-full max-w-xs`}
          aria-label="Search stock"
        />
        {(['all', 'attention'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`min-h-[44px] rounded-full border px-4 text-sm font-semibold ${
              filter === f ? 'border-charcoal bg-charcoal text-cream' : 'border-[#ddd] bg-white text-charcoal'
            }`}
          >
            {f === 'all' ? 'All' : `Needs attention (${attentionCount})`}
          </button>
        ))}
      </div>

      {data.items.length === 0 ? (
        <p className="mt-8 rounded-md border border-dashed border-[#ddd] bg-white p-6 text-center text-sm text-muted">
          No stock items yet.{' '}
          {data.canManage ? 'Add the ingredients and packaging you want to track.' : 'A manager or the owner adds them.'}
        </p>
      ) : visible.length === 0 ? (
        <p className="mt-8 text-center text-sm text-muted">Nothing matches.</p>
      ) : (
        groups.map(([category, items]) => (
          <section key={category} className="mt-6">
            <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-muted">{category}</h3>
            <ul className="mt-2 divide-y divide-[#eee] rounded-md border border-[#e5e5e5] bg-white">
              {items.map((i) => (
                <li key={i.id} className={`px-4 py-3 ${i.isActive ? '' : 'opacity-60'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      className="min-h-[44px] text-left"
                      onClick={() => setExpanded(expanded === i.id ? null : i.id)}
                      aria-expanded={expanded === i.id}
                    >
                      <span className="block font-semibold text-charcoal">{i.name}</span>
                      <span className="block text-sm tabular-nums text-muted">
                        {formatQty(i.onHand, i.unit)} on hand
                        {i.parLevel > 0 ? ` · low at ${formatQty(i.parLevel, i.unit)}` : ''}
                        {i.nextExpiry ? ` · next expiry ${shortDate(i.nextExpiry)}` : ''}
                      </span>
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {!i.isActive ? <Chip tone="grey">Retired</Chip> : null}
                      {i.expiredQty > 0 ? <Chip tone="red">{formatQty(i.expiredQty, i.unit)} expired</Chip> : null}
                      {i.soonQty > 0 ? <Chip tone="amber">{formatQty(i.soonQty, i.unit)} expiring soon</Chip> : null}
                      {i.low ? <Chip tone="amber">Low</Chip> : null}
                      {i.countNeeded ? <Chip tone="red">Count needed</Chip> : null}
                      {i.openRequestNumbers.length > 0 ? (
                        <Chip tone="green">Requested #{i.openRequestNumbers.join(', #')}</Chip>
                      ) : null}
                    </div>
                  </div>

                  {expanded === i.id ? (
                    <div className="mt-2 rounded-md bg-[#faf7f4] p-3 text-sm">
                      {i.batches.length === 0 ? (
                        <p className="text-muted">No stock on the shelf.</p>
                      ) : (
                        <ul className="space-y-1">
                          {i.batches.map((b) => (
                            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 tabular-nums">
                              <span>
                                {formatQty(b.qtyRemaining, i.unit)}
                                <span className="ml-2 text-xs text-muted">
                                  {b.source === 'count' ? 'from a count' : `received ${shortDate(b.receivedAt)}`}
                                </span>
                              </span>
                              <span
                                className={
                                  b.state === 'expired'
                                    ? 'font-semibold text-red-700'
                                    : b.state === 'soon'
                                      ? 'font-semibold text-amber-800'
                                      : 'text-muted'
                                }
                              >
                                {b.expiryDate ? `${b.state === 'expired' ? 'Expired' : 'Expires'} ${shortDate(b.expiryDate)}` : 'No expiry'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {i.countNeeded ? (
                        <p className="mt-2 text-red-800">
                          Orders used {formatQty(i.shortfall, i.unit)} more than the records held. Count what is on the shelf.
                        </p>
                      ) : null}
                      {data.canManage ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" className={secondaryButton} onClick={() => setAdjusting({ item: i, kind: 'count' })}>
                            Count
                          </button>
                          <button type="button" className={secondaryButton} onClick={() => setAdjusting({ item: i, kind: 'waste' })}>
                            Write off
                          </button>
                          <button type="button" className={secondaryButton} onClick={() => setEditing(i)}>
                            Edit
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {requestOpen ? (
        <RequestStockModal
          items={data.items.filter((i) => i.isActive)}
          onClose={() => setRequestOpen(false)}
          onDone={async () => {
            setRequestOpen(false);
            await reload();
            onRequested();
          }}
        />
      ) : null}
      {deliveryOpen ? (
        <DeliveryModal
          items={data.items.filter((i) => i.isActive)}
          today={data.today}
          onClose={() => setDeliveryOpen(false)}
          onDone={async () => {
            setDeliveryOpen(false);
            await reload();
          }}
        />
      ) : null}
      {editing ? (
        <ItemFormModal
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={async () => {
            setEditing(null);
            await reload();
          }}
        />
      ) : null}
      {adjusting ? (
        <AdjustModal
          item={adjusting.item}
          kind={adjusting.kind}
          today={data.today}
          onClose={() => setAdjusting(null)}
          onDone={async () => {
            setAdjusting(null);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

// ── Auto-hide ───────────────────────────────────────────────────────────────

/** What auto-hide has taken off the menu, and (for a manager) its switch. */
function AutoHidePanel({ data, reload }: { data: ItemsPayload; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { enabled, hidden } = data.autoHide;
  if (!data.canManage && hidden.length === 0) return null;

  async function toggle(next: boolean) {
    setError('');
    setBusy(true);
    const res = await api('/api/inventory/settings', 'PATCH', { autoHide: next });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await reload();
  }

  return (
    <div className={`mt-4 rounded-md border p-3 text-sm ${hidden.length ? 'border-amber-200 bg-amber-50' : 'border-[#e5e5e5] bg-white'}`}>
      {hidden.length ? (
        <p className="text-amber-900">
          <span className="font-semibold">Hidden from the menu — out of an ingredient:</span> {hidden.map((h) => h.name).join(', ')}.
          They come back by themselves when the stock is received.
        </p>
      ) : null}
      {data.canManage ? (
        <label className={`flex items-center gap-2 ${hidden.length ? 'mt-2' : ''}`}>
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span className="text-charcoal">Hide a menu item when an ingredient in its recipe runs out</span>
        </label>
      ) : null}
      {error ? <p className="mt-2 text-red-700">{error}</p> : null}
    </div>
  );
}

// ── Request stock ───────────────────────────────────────────────────────────

function RequestStockModal({
  items,
  onClose,
  onDone,
}: {
  items: InventoryItemView[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  // Low items not already on an open request start ticked, at the suggested qty.
  const [qty, setQty] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const i of items) {
      if (i.low && i.openRequestNumbers.length === 0) {
        const s = suggestedRequestQty({ par_level: i.parLevel, reorder_qty: i.reorderQty }, i.onHand);
        init[i.id] = s > 0 ? String(s) : '';
      }
    }
    return init;
  });
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = Object.keys(qty);
  const shown = items.filter((i) => chosen.includes(i.id) || (query.trim() && i.name.toLowerCase().includes(query.trim().toLowerCase())));

  async function submit() {
    setError('');
    const lines = chosen.map((id) => ({ itemId: id, qty: Number(qty[id]) }));
    if (lines.length === 0) return setError('Pick at least one item.');
    const bad = lines.find((l) => !Number.isFinite(l.qty) || l.qty <= 0);
    if (bad) return setError(`Enter a quantity for ${items.find((i) => i.id === bad.itemId)?.name ?? 'every item'}.`);
    setBusy(true);
    const res = await api('/api/inventory/requests', 'POST', { lines, note });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Request stock"
      subtitle="Low items are already added. A manager assigns someone to pick it."
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span className="text-sm text-muted">{chosen.length} item(s)</span>}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy}>
            {busy ? 'Sending…' : 'Send request'}
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
      <ul className="mt-3 divide-y divide-[#eee]">
        {shown.map((i) => {
          const on = i.id in qty;
          return (
            <li key={i.id} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                checked={on}
                className="h-5 w-5"
                aria-label={`Request ${i.name}`}
                onChange={(e) =>
                  setQty((prev) => {
                    const next = { ...prev };
                    if (e.target.checked) {
                      const s = suggestedRequestQty({ par_level: i.parLevel, reorder_qty: i.reorderQty }, i.onHand);
                      next[i.id] = s > 0 ? String(s) : '';
                    } else delete next[i.id];
                    return next;
                  })
                }
              />
              <span className="flex-1 text-sm">
                <span className="font-semibold text-charcoal">{i.name}</span>
                <span className="block text-xs text-muted">
                  {formatQty(i.onHand, i.unit)} on hand
                  {i.openRequestNumbers.length ? ` · already on #${i.openRequestNumbers.join(', #')}` : ''}
                </span>
              </span>
              {on ? (
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={qty[i.id]}
                    onChange={(e) => setQty((prev) => ({ ...prev, [i.id]: e.target.value }))}
                    className={`${inputBase} w-24 text-right tabular-nums`}
                    aria-label={`Quantity of ${i.name}`}
                  />
                  <span className="w-10 text-muted">{UNIT_LABELS[i.unit]}</span>
                </label>
              ) : null}
            </li>
          );
        })}
        {shown.length === 0 ? <li className="py-4 text-center text-sm text-muted">Search to add an item.</li> : null}
      </ul>
      <label className="mt-3 block text-sm">
        <span className="text-charcoal">Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputClass} mt-1`} placeholder="e.g. needed before the evening rush" />
      </label>
    </Modal>
  );
}

// ── Receive a delivery (no request) ─────────────────────────────────────────

function DeliveryModal({
  items,
  today,
  onClose,
  onDone,
}: {
  items: InventoryItemView[];
  today: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Record<string, { qty: string; expiry: string }>>({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chosen = Object.keys(rows);
  const shown = items.filter((i) => chosen.includes(i.id) || (query.trim() && i.name.toLowerCase().includes(query.trim().toLowerCase())));

  async function submit() {
    setError('');
    const lines = chosen.map((id) => ({ itemId: id, qty: Number(rows[id].qty), expiryDate: rows[id].expiry || null }));
    if (lines.length === 0) return setError('Add what arrived.');
    setBusy(true);
    const res = await api('/api/inventory/receipts', 'POST', { lines });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Receive delivery"
      subtitle="For stock that arrived without a request. Count each item and enter its expiry date."
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Add to stock'}
          </button>
        </div>
      }
    >
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an item" className={inputClass} aria-label="Find an item" />
      <ul className="mt-3 divide-y divide-[#eee]">
        {shown.map((i) => {
          const row = rows[i.id];
          return (
            <li key={i.id} className="py-2">
              <label className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={Boolean(row)}
                  onChange={(e) =>
                    setRows((prev) => {
                      const next = { ...prev };
                      if (e.target.checked) next[i.id] = { qty: '', expiry: '' };
                      else delete next[i.id];
                      return next;
                    })
                  }
                />
                <span className="font-semibold text-charcoal">{i.name}</span>
              </label>
              {row ? (
                <QtyExpiryInputs
                  unit={i.unit}
                  tracksExpiry={i.tracksExpiry}
                  today={today}
                  qty={row.qty}
                  expiry={row.expiry}
                  onChange={(v) => setRows((prev) => ({ ...prev, [i.id]: { ...prev[i.id], ...v } }))}
                  name={i.name}
                />
              ) : null}
            </li>
          );
        })}
        {shown.length === 0 ? <li className="py-4 text-center text-sm text-muted">Search to add an item.</li> : null}
      </ul>
    </Modal>
  );
}

/** Quantity + expiry date inputs, shared by delivery and request receiving. */
export function QtyExpiryInputs({
  unit,
  tracksExpiry,
  today,
  qty,
  expiry,
  onChange,
  name,
  expected,
}: {
  unit: InventoryUnit;
  tracksExpiry: boolean;
  today: string;
  qty: string;
  expiry: string;
  onChange: (v: { qty?: string; expiry?: string }) => void;
  name: string;
  /** What was picked — a different count is highlighted as a discrepancy. */
  expected?: number | null;
}) {
  const n = Number(qty);
  const mismatch = expected !== undefined && expected !== null && qty !== '' && Number.isFinite(n) && n !== expected;
  const expired = expiry && expiryState(expiry, today) === 'expired';
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label className="block text-sm">
        <span className="text-muted">Arrived ({UNIT_LABELS[unit]})</span>
        <input
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={qty}
          onChange={(e) => onChange({ qty: e.target.value })}
          className={`${inputClass} mt-1 text-right tabular-nums ${mismatch ? 'border-amber-500' : ''}`}
          aria-label={`Quantity of ${name} that arrived`}
        />
        {mismatch ? <span className="mt-1 block text-xs font-semibold text-amber-800">Picked {expected} — this will be flagged</span> : null}
      </label>
      <label className="block text-sm">
        <span className="text-muted">Expiry date{tracksExpiry ? '' : ' (optional)'}</span>
        <input
          type="date"
          min={today}
          value={expiry}
          onChange={(e) => onChange({ expiry: e.target.value })}
          className={`${inputClass} mt-1 ${expired ? 'border-red-500' : ''}`}
          aria-label={`Expiry date of ${name}`}
        />
        {expired ? <span className="mt-1 block text-xs font-semibold text-red-700">Already expired — don’t accept it</span> : null}
      </label>
    </div>
  );
}

// ── Add / edit an item ──────────────────────────────────────────────────────

function ItemFormModal({
  item,
  onClose,
  onDone,
}: {
  item: InventoryItemView | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [unit, setUnit] = useState<InventoryUnit>(item?.unit ?? 'g');
  const [category, setCategory] = useState(item?.category ?? '');
  const [par, setPar] = useState(item ? String(item.parLevel) : '');
  const [reorder, setReorder] = useState(item ? String(item.reorderQty) : '');
  const [tracksExpiry, setTracksExpiry] = useState(item?.tracksExpiry ?? true);
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    const body = {
      name,
      unit,
      category,
      parLevel: par === '' ? 0 : Number(par),
      reorderQty: reorder === '' ? 0 : Number(reorder),
      tracksExpiry,
      ...(item ? { isActive } : {}),
    };
    setBusy(true);
    const res = item ? await api(`/api/inventory/items/${item.id}`, 'PATCH', body) : await api('/api/inventory/items', 'POST', body);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? `Edit ${item.name}` : 'Add stock item'}
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="text-charcoal">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} placeholder="e.g. Full-cream milk" />
        </label>
        <label className="block text-sm">
          <span className="text-charcoal">Unit</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value as InventoryUnit)} className={`${inputClass} mt-1`}>
            {INVENTORY_UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABELS[u]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted">Stock, requests and recipes all use this unit.</span>
        </label>
        <label className="block text-sm">
          <span className="text-charcoal">Category</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputClass} mt-1`} placeholder="e.g. Dairy" />
        </label>
        <label className="block text-sm">
          <span className="text-charcoal">Low at ({UNIT_LABELS[unit]})</span>
          <input type="number" min={0} step="any" value={par} onChange={(e) => setPar(e.target.value)} className={`${inputClass} mt-1 text-right`} placeholder="0 = never" />
        </label>
        <label className="block text-sm">
          <span className="text-charcoal">Usually request ({UNIT_LABELS[unit]})</span>
          <input type="number" min={0} step="any" value={reorder} onChange={(e) => setReorder(e.target.value)} className={`${inputClass} mt-1 text-right`} placeholder="0 = top up to low level" />
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="h-5 w-5" checked={tracksExpiry} onChange={(e) => setTracksExpiry(e.target.checked)} />
          Perishable — an expiry date is required when it is received
        </label>
        {item ? (
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="h-5 w-5" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Still stocked (untick to retire it)
          </label>
        ) : null}
      </div>
    </Modal>
  );
}

// ── Count / write off ───────────────────────────────────────────────────────

function AdjustModal({
  item,
  kind,
  today,
  onClose,
  onDone,
}: {
  item: InventoryItemView;
  kind: 'waste' | 'count';
  today: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const firstExpired = item.batches.find((b) => expiryState(b.expiryDate, today) === 'expired');
  const [qty, setQty] = useState(kind === 'waste' && firstExpired ? String(firstExpired.qtyRemaining) : '');
  const [batchId, setBatchId] = useState<string>(kind === 'waste' && firstExpired ? firstExpired.id : '');
  const [reason, setReason] = useState(kind === 'waste' && firstExpired ? 'Expired' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    setBusy(true);
    const res = await api(`/api/inventory/items/${item.id}/adjust`, 'POST', {
      kind,
      qty: Number(qty),
      batchId: batchId || null,
      reason,
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={kind === 'count' ? `Count ${item.name}` : `Write off ${item.name}`}
      subtitle={`Records say ${formatQty(item.onHand, item.unit)} on hand.`}
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy || qty === ''}>
            {busy ? 'Saving…' : kind === 'count' ? 'Save count' : 'Write off'}
          </button>
        </div>
      }
    >
      {kind === 'waste' && item.batches.length > 0 ? (
        <label className="block text-sm">
          <span className="text-charcoal">From</span>
          <select
            value={batchId}
            onChange={(e) => {
              setBatchId(e.target.value);
              const b = item.batches.find((x) => x.id === e.target.value);
              if (b) setQty(String(b.qtyRemaining));
            }}
            className={`${inputClass} mt-1`}
          >
            <option value="">Oldest stock first</option>
            {item.batches.map((b) => (
              <option key={b.id} value={b.id}>
                {formatQty(b.qtyRemaining, item.unit)} — {b.expiryDate ? `expires ${shortDate(b.expiryDate)}` : 'no expiry'}
                {b.state === 'expired' ? ' (expired)' : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="mt-3 block text-sm">
        <span className="text-charcoal">{kind === 'count' ? `Counted on the shelf (${UNIT_LABELS[item.unit]})` : `Quantity (${UNIT_LABELS[item.unit]})`}</span>
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
      <label className="mt-3 block text-sm">
        <span className="text-charcoal">Reason{kind === 'count' ? ' (optional)' : ''}</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${inputClass} mt-1`}
          placeholder={kind === 'count' ? 'Stock count' : 'e.g. expired, spilt'}
        />
      </label>
    </Modal>
  );
}
