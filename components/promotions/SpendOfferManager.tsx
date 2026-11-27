'use client';

// Owner spend offers (Promotions → Offers; lib/orders/offers.ts billOffers):
// "spend ₹1099, get one Instant Coffee jar at ₹49". Its own record on one menu
// item; the item's menu price is never changed. When everything else on a bill
// reaches the minimum (before GST), one unit of the item comes at the offer
// price, shown as its own discount row. It can't be combined: not with a
// coupon or Beanies, and the bill takes it or the multi-buy offer, whichever
// saves more. Once per customer, by phone number (spend_offer_redemptions).
// Talks to app/api/spend-offers + app/api/spend-offers/[id].

import { useEffect, useMemo, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { DataTable } from '@/components/ui/DataTable';
import { describeSpendOffer, isWindowLive } from '@/lib/orders/offers';
import type { OwnerSpendOffer } from '@/lib/promotions/offerRoutes';
import { isSoldByWeight } from '@/lib/menu/weight';
import { LOYALTY_UNIT } from '@/lib/loyalty/brand';
import type { MenuItem } from '@/lib/types';

type FormState = {
  name: string;
  menu_item_id: string;
  min_spend: string;
  price: string;
  valid_from: string; // datetime-local
  valid_to: string;
  active: boolean;
};

const EMPTY_FORM: FormState = { name: '', menu_item_id: '', min_spend: '', price: '', valid_from: '', valid_to: '', active: true };

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The item's regular price for one unit: its dearest size (the one the offer takes off). */
function regularPrice(item: MenuItem | undefined): number | null {
  if (!item || item.variants.length === 0) return null;
  return Math.max(...item.variants.map((v) => v.price_inr));
}

function statusOf(offer: OwnerSpendOffer): 'Live' | 'Scheduled' | 'Ended' | 'Off' {
  if (!offer.active) return 'Off';
  if (isWindowLive(offer)) return 'Live';
  return offer.valid_from && Date.now() < Date.parse(offer.valid_from) ? 'Scheduled' : 'Ended';
}

function wholeRupees(raw: string, min: number): number | null {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= min ? n : null;
}

export function SpendOfferManager() {
  const [offers, setOffers] = useState<OwnerSpendOffer[]>([]);
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
      const res = await fetch('/api/spend-offers', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setOffers(data.offers as OwnerSpendOffer[]);
        setLoadError('');
      } else {
        setLoadError(data.error ?? 'Could not load spend offers');
      }
    } catch {
      setLoadError('Network error — please reload.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
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

  function startEdit(o: OwnerSpendOffer) {
    setEditingId(o.id);
    setForm({
      name: o.name,
      menu_item_id: o.menu_item_id,
      min_spend: String(o.min_spend_inr),
      price: String(o.price_inr),
      valid_from: toDatetimeLocal(o.valid_from),
      valid_to: toDatetimeLocal(o.valid_to),
      active: o.active,
    });
    setError('');
  }

  async function patch(o: OwnerSpendOffer, body: Record<string, unknown>) {
    const res = await fetch(`/api/spend-offers/${o.id}`, {
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

  async function remove(o: OwnerSpendOffer) {
    if (!window.confirm(`Delete "${o.name}"? Bills already made keep it.`)) return;
    const res = await fetch(`/api/spend-offers/${o.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setLoadError(data.error ?? 'Could not delete the offer');
    }
    await load();
  }

  async function handleSubmit() {
    setError('');
    const minSpend = wholeRupees(form.min_spend, 1);
    const price = wholeRupees(form.price, 0);
    if (minSpend === null) return setError('Enter the minimum spend in whole rupees, above ₹0.');
    if (price === null) return setError('Enter the offer price in whole rupees (₹0 or more).');
    const isCreate = editingId === 'new';
    const payload: Record<string, unknown> = {
      name: form.name,
      min_spend_inr: minSpend,
      price_inr: price,
      valid_from: form.valid_from ? new Date(form.valid_from).toISOString() : null,
      valid_to: form.valid_to ? new Date(form.valid_to).toISOString() : null,
      active: form.active,
      ...(isCreate ? { menu_item_id: form.menu_item_id } : {}),
    };
    setSaving(true);
    try {
      const res = await fetch(isCreate ? '/api/spend-offers' : `/api/spend-offers/${editingId}`, {
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

  if (loading && offers.length === 0 && !loadError) return <Spinner label="Loading spend offers…" />;

  return (
    <div>
      <p className="mb-3 text-sm text-muted">
        Spend this much, get one item at a special price — e.g. spend ₹1099, get an Instant Coffee jar at ₹49. Everything
        else on the bill counts, before GST. Once per customer, by phone number: the counter needs the customer&rsquo;s number
        to give it. It can&rsquo;t be combined with a coupon, {LOYALTY_UNIT.many} or another offer (the bill takes whichever
        offer saves the customer more), and a bill with it earns no {LOYALTY_UNIT.many}.
      </p>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{offers.length} spend offer(s)</p>
        {editingId === null ? (
          <button
            type="button"
            onClick={startCreate}
            className="rounded-md bg-tan-dark px-4 py-2.5 text-sm font-bold text-cream hover:bg-tan-darker"
          >
            New spend offer
          </button>
        ) : null}
      </div>

      {loadError ? (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {loadError}
        </p>
      ) : null}

      {editingId !== null ? (
        <SpendOfferForm
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
          emptyMessage="No spend offers yet."
          minWidth={720}
          cellPadding="py-2 pr-3"
          headerTextClassName="text-xs uppercase text-muted"
          columns={[
            { key: 'name', header: 'Offer', filter: 'text', value: (o) => o.name, cellClassName: 'font-bold text-charcoal' },
            { key: 'item', header: 'Item', filter: 'text', value: (o) => o.item_name, cellClassName: 'text-charcoal' },
            {
              key: 'terms',
              header: 'Terms',
              filter: 'text',
              value: (o) => describeSpendOffer(o),
              render: (o) => {
                const regular = regularPrice(itemById.get(o.menu_item_id));
                return (
                  <>
                    <span className="text-charcoal">{describeSpendOffer(o)}</span>
                    <span className="block text-xs text-muted">
                      {regular !== null ? `Saves ₹${Math.max(0, regular - o.price_inr)}` : '—'}
                    </span>
                  </>
                );
              },
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

function SpendOfferForm({
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
  const sorted = useMemo(
    () => [...items].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
    [items],
  );
  const price = wholeRupees(form.price, 0);

  return (
    <div className="mb-4 rounded-md border border-line bg-[#faf7f4] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-charcoal">Offer name (printed on the bill)</span>
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Instant Coffee at ₹49"
            maxLength={60}
            className="mt-1 w-full rounded-md border border-line p-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Item that comes at the offer price</span>
          <select
            value={form.menu_item_id}
            onChange={(e) => set({ menu_item_id: e.target.value })}
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
        <label className="text-sm">
          <span className="text-charcoal">Minimum spend on everything else (₹, before GST)</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={form.min_spend}
            onChange={(e) => set({ min_spend: e.target.value })}
            placeholder="1099"
            className="mt-1 w-full rounded-md border border-line p-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Then one costs (₹){regular !== null ? ` — regular ₹${regular}` : ''}</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={form.price}
            onChange={(e) => set({ price: e.target.value })}
            placeholder="49"
            className="mt-1 w-full rounded-md border border-line p-2"
          />
          <span className="mt-0.5 block text-xs text-muted">
            {regular !== null && price !== null ? `Saves ₹${Math.max(0, regular - price)}` : ' '}
          </span>
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Starts (optional)</span>
          <input type="datetime-local" value={form.valid_from} onChange={(e) => set({ valid_from: e.target.value })} className="mt-1 w-full rounded-md border border-line p-2" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Ends (optional)</span>
          <input type="datetime-local" value={form.valid_to} onChange={(e) => set({ valid_to: e.target.value })} className="mt-1 w-full rounded-md border border-line p-2" />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted">
        One per bill, once per customer (by phone number). Not with a coupon, {LOYALTY_UNIT.many} or another offer, and
        the bill earns no {LOYALTY_UNIT.many}.
      </p>
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
