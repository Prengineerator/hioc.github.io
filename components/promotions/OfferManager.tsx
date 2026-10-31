'use client';

// Owner multi-buy offers (Promotions → Offers; lib/orders/offers.ts): "Instant
// Coffee — 1 for ₹299, 2 for ₹499, 3 for ₹599". An offer is its own record on
// one menu item; the item's menu price is never changed. At the counter staff
// add the item as usual and the bill takes the offer off as its own row.
// Talks to app/api/offers + app/api/offers/[id].

import { useEffect, useMemo, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { DataTable } from '@/components/ui/DataTable';
import { describeTiers, isOfferLive, MAX_OFFER_TIERS, normalizeOfferPrices } from '@/lib/orders/offers';
import type { OwnerOffer } from '@/lib/promotions/offerRoutes';
import { isSoldByWeight } from '@/lib/menu/weight';
import type { MenuItem } from '@/lib/types';

type FormState = {
  name: string;
  menu_item_id: string;
  /** "Price for 1", "Price for 2", … as typed. */
  tiers: string[];
  valid_from: string; // datetime-local
  valid_to: string;
  active: boolean;
};

const EMPTY_FORM: FormState = { name: '', menu_item_id: '', tiers: ['', '', ''], valid_from: '', valid_to: '', active: true };

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The item's regular price for one unit: its cheapest size. */
function regularPrice(item: MenuItem | undefined): number | null {
  if (!item || item.variants.length === 0) return null;
  return Math.min(...item.variants.map((v) => v.price_inr));
}

/** "Saves ₹100 / ₹299 / ₹598" against the regular price. */
function savingsText(prices: readonly number[], regular: number | null): string {
  if (regular === null) return '—';
  return 'Saves ' + prices.map((p, i) => `₹${Math.max(0, regular * (i + 1) - p)}`).join(' / ');
}

function statusOf(offer: OwnerOffer): 'Live' | 'Scheduled' | 'Ended' | 'Off' {
  if (!offer.active) return 'Off';
  if (isOfferLive(offer)) return 'Live';
  return offer.valid_from && Date.now() < Date.parse(offer.valid_from) ? 'Scheduled' : 'Ended';
}

export function OfferManager() {
  const [offers, setOffers] = useState<OwnerOffer[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/offers', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setOffers(data.offers as OwnerOffer[]);
        setLoadError('');
      } else {
        setLoadError(data.error ?? 'Could not load offers');
      }
    } catch {
      setLoadError('Network error — please reload.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // Every item, counter-only ones included (instant coffee is sold at the counter).
    fetch('/api/menu?includeUnavailable=true&includeInStore=true&allSizes=true', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems(((d.items ?? []) as MenuItem[]).filter((i) => !isSoldByWeight(i))))
      .catch(() => setItems([]));
  }, []);

  function startCreate() {
    setEditingId('new');
    setForm(EMPTY_FORM);
    setError('');
  }

  function startEdit(o: OwnerOffer) {
    setEditingId(o.id);
    setForm({
      name: o.name,
      menu_item_id: o.menu_item_id,
      tiers: o.tier_prices.map(String),
      valid_from: toDatetimeLocal(o.valid_from),
      valid_to: toDatetimeLocal(o.valid_to),
      active: o.active,
    });
    setError('');
  }

  async function patch(o: OwnerOffer, body: Record<string, unknown>) {
    const res = await fetch(`/api/offers/${o.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setLoadError(data.error ?? 'Could not change the offer');
    } else {
      setLoadError('');
    }
    await load();
  }

  async function remove(o: OwnerOffer) {
    if (!window.confirm(`Delete "${o.name}"? Bills already made keep it.`)) return;
    const res = await fetch(`/api/offers/${o.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setLoadError(data.error ?? 'Could not delete the offer');
    }
    await load();
  }

  async function handleSubmit() {
    setError('');
    const typed = form.tiers.map((t) => t.trim()).filter((t) => t !== '');
    const prices = normalizeOfferPrices(typed.map(Number));
    if (!prices || typed.length !== form.tiers.length) {
      setError('Fill in every price with a whole rupee amount above ₹0. Buying more can never cost less.');
      return;
    }
    const isCreate = editingId === 'new';
    const payload: Record<string, unknown> = {
      name: form.name,
      tier_prices: prices,
      valid_from: form.valid_from ? new Date(form.valid_from).toISOString() : null,
      valid_to: form.valid_to ? new Date(form.valid_to).toISOString() : null,
      active: form.active,
      ...(isCreate ? { menu_item_id: form.menu_item_id } : {}),
    };
    setSaving(true);
    try {
      const res = await fetch(isCreate ? '/api/offers' : `/api/offers/${editingId}`, {
        method: isCreate ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Save failed');
        return;
      }
      setEditingId(null);
      await load();
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading && offers.length === 0 && !loadError) return <Spinner label="Loading offers…" />;

  return (
    <div>
      <p className="mb-3 text-sm text-muted">
        Buy more, pay less on one item — e.g. Instant Coffee: 1 for ₹299, 2 for ₹499, 3 for ₹599. The menu price stays
        as it is; staff add the item as usual and the bill shows the offer as its own discount. Any mix of the
        item&rsquo;s sizes or flavours counts.
      </p>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{offers.length} offer(s)</p>
        {editingId === null ? (
          <button
            type="button"
            onClick={startCreate}
            className="rounded-md bg-tan-dark px-4 py-2.5 text-sm font-bold text-cream hover:bg-tan-darker"
          >
            New offer
          </button>
        ) : null}
      </div>

      {loadError ? (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {loadError}
        </p>
      ) : null}

      {editingId !== null ? (
        <OfferForm
          form={form}
          setForm={setForm}
          items={items}
          regular={regularPrice(itemById.get(form.menu_item_id))}
          onCancel={() => setEditingId(null)}
          onSubmit={handleSubmit}
          saving={saving}
          error={error}
          isCreate={editingId === 'new'}
        />
      ) : null}

      <div className="mt-4">
        <DataTable
          rows={offers}
          rowKey={(o) => o.id}
          emptyMessage="No offers yet."
          minWidth={720}
          cellPadding="py-2 pr-3"
          headerTextClassName="text-xs uppercase text-muted"
          columns={[
            { key: 'name', header: 'Offer', filter: 'text', value: (o) => o.name, cellClassName: 'font-bold text-charcoal' },
            { key: 'item', header: 'Item', filter: 'text', value: (o) => o.item_name, cellClassName: 'text-charcoal' },
            {
              key: 'prices',
              header: 'Prices',
              filter: 'text',
              value: (o) => describeTiers(o.tier_prices),
              render: (o) => (
                <>
                  <span className="text-charcoal">{describeTiers(o.tier_prices)}</span>
                  <span className="block text-xs text-muted">
                    {savingsText(o.tier_prices, regularPrice(itemById.get(o.menu_item_id)))}
                  </span>
                </>
              ),
            },
            {
              key: 'window',
              header: 'Window',
              filter: 'date',
              value: (o) => o.valid_from,
              cellClassName: 'text-muted',
              render: (o) =>
                o.valid_from || o.valid_to ? (
                  <>
                    {o.valid_from ? new Date(o.valid_from).toLocaleDateString('en-IN') : '—'}
                    {' → '}
                    {o.valid_to ? new Date(o.valid_to).toLocaleDateString('en-IN') : '—'}
                  </>
                ) : (
                  'No end date'
                ),
            },
            {
              key: 'status',
              header: 'Status',
              filter: 'select',
              value: (o) => statusOf(o),
              render: (o) => {
                const status = statusOf(o);
                return (
                  <button
                    type="button"
                    onClick={() => patch(o, { active: !o.active })}
                    title={o.active ? 'Switch off' : 'Switch on'}
                    className={
                      'rounded-md px-2 py-1 text-xs font-bold ' +
                      (status === 'Live' ? 'bg-green-100 text-green-700' : 'bg-line text-muted')
                    }
                  >
                    {status}
                  </button>
                );
              },
            },
            {
              key: 'actions',
              header: 'Edit',
              filter: 'none',
              value: () => null,
              render: (o) => (
                <span className="flex gap-3">
                  <button type="button" onClick={() => startEdit(o)} className="text-tan-dark hover:underline">
                    Edit
                  </button>
                  <button type="button" onClick={() => remove(o)} className="text-muted hover:text-red-700 hover:underline">
                    Delete
                  </button>
                </span>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

function OfferForm({
  form,
  setForm,
  items,
  regular,
  onCancel,
  onSubmit,
  saving,
  error,
  isCreate,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  items: MenuItem[];
  regular: number | null;
  onCancel: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: string;
  isCreate: boolean;
}) {
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const setTier = (i: number, value: string) => set({ tiers: form.tiers.map((t, j) => (j === i ? value : t)) });
  const sorted = useMemo(
    () => [...items].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
    [items],
  );

  return (
    <div className="mb-4 rounded-md border border-line bg-[#faf7f4] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-charcoal">Offer name (printed on the bill)</span>
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Instant Coffee offer"
            maxLength={60}
            className="mt-1 w-full rounded-md border border-line p-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Menu item</span>
          <select
            value={form.menu_item_id}
            onChange={(e) => {
              const item = items.find((i) => i.id === e.target.value);
              set({ menu_item_id: e.target.value, ...(form.name.trim() === '' && item ? { name: `${item.name} offer` } : {}) });
            }}
            disabled={!isCreate}
            className="mt-1 w-full rounded-md border border-line p-2 disabled:bg-[#f2efe9]"
          >
            <option value="">Choose an item…</option>
            {sorted.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.category}) — ₹{regularPrice(i)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="mt-3">
        <legend className="text-sm text-charcoal">
          What they pay together{regular !== null ? ` (regular ₹${regular} each)` : ''}
        </legend>
        <div className="mt-1 flex flex-wrap items-end gap-3">
          {form.tiers.map((t, i) => {
            const price = Number(t);
            const saving = regular !== null && t.trim() !== '' && Number.isInteger(price) ? regular * (i + 1) - price : null;
            return (
              <label key={i} className="text-sm">
                <span className="text-muted">Buy {i + 1}</span>
                <span className="mt-1 flex items-center gap-1">
                  <span className="text-muted">₹</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={t}
                    onChange={(e) => setTier(i, e.target.value)}
                    className="w-24 rounded-md border border-line p-2"
                  />
                </span>
                <span className="mt-0.5 block text-xs text-muted">{saving !== null ? `Saves ₹${Math.max(0, saving)}` : ' '}</span>
              </label>
            );
          })}
          <span className="flex gap-2 pb-6">
            {form.tiers.length < MAX_OFFER_TIERS ? (
              <button type="button" onClick={() => set({ tiers: [...form.tiers, ''] })} className="text-sm font-bold text-tan-dark hover:underline">
                + Add
              </button>
            ) : null}
            {form.tiers.length > 1 ? (
              <button type="button" onClick={() => set({ tiers: form.tiers.slice(0, -1) })} className="text-sm font-bold text-muted hover:underline">
                − Remove
              </button>
            ) : null}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted">
          More than {form.tiers.length} go in groups of {form.tiers.length}, then the price for the rest.
        </p>
      </fieldset>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-charcoal">Starts (optional)</span>
          <input type="datetime-local" value={form.valid_from} onChange={(e) => set({ valid_from: e.target.value })} className="mt-1 w-full rounded-md border border-line p-2" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Ends (optional)</span>
          <input type="datetime-local" value={form.valid_to} onChange={(e) => set({ valid_to: e.target.value })} className="mt-1 w-full rounded-md border border-line p-2" />
        </label>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-charcoal">
        <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
        Switched on
      </label>

      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving || (isCreate && form.menu_item_id === '')}
          className="rounded-md bg-tan-dark px-5 py-2 text-sm font-bold text-cream hover:bg-tan-darker disabled:opacity-50"
        >
          {saving ? 'Saving…' : isCreate ? 'Create offer' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-bold text-muted hover:text-charcoal">
          Cancel
        </button>
      </div>
    </div>
  );
}
