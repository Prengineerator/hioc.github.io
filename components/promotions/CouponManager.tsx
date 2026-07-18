'use client';

// Owner coupon CRUD (LOY-2/LOY-5/OWN-035). Talks to app/api/coupons +
// app/api/coupons/[id]. List + create/edit form; toggling `active` reuses the
// same PATCH the edit form uses.

import { useEffect, useState } from 'react';
import type { Coupon, CouponDiscountType } from '@/lib/types';
import { Spinner } from '@/components/ui/Spinner';

type FormState = {
  code: string;
  description: string;
  discount_type: CouponDiscountType;
  discount_value: string;
  min_order_inr: string;
  max_discount_inr: string;
  item_ids: string; // comma-separated
  category: string; // comma-separated
  valid_from: string; // datetime-local
  valid_to: string;
  usage_limit: string;
  per_user_limit: string;
  is_auto: boolean;
  active: boolean;
};

const EMPTY_FORM: FormState = {
  code: '',
  description: '',
  discount_type: 'percent',
  discount_value: '10',
  min_order_inr: '0',
  max_discount_inr: '0',
  item_ids: '',
  category: '',
  valid_from: '',
  valid_to: '',
  usage_limit: '0',
  per_user_limit: '0',
  is_auto: false,
  active: true,
};

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function couponToForm(c: Coupon): FormState {
  return {
    code: c.code,
    description: c.description,
    discount_type: c.discount_type,
    discount_value: String(c.discount_value),
    min_order_inr: String(c.min_order_inr),
    max_discount_inr: String(c.max_discount_inr),
    item_ids: (c.scope.item_ids ?? []).join(', '),
    category: (c.scope.category ?? []).join(', '),
    valid_from: toDatetimeLocal(c.valid_from),
    valid_to: toDatetimeLocal(c.valid_to),
    usage_limit: String(c.usage_limit),
    per_user_limit: String(c.per_user_limit),
    is_auto: c.is_auto,
    active: c.active,
  };
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function CouponManager() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/coupons', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setCoupons(data.coupons as Coupon[]);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function startCreate() {
    setEditingId('new');
    setForm(EMPTY_FORM);
    setError('');
  }

  function startEdit(c: Coupon) {
    setEditingId(c.id);
    setForm(couponToForm(c));
    setError('');
  }

  async function toggleActive(c: Coupon) {
    await fetch(`/api/coupons/${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !c.active }),
    });
    await load();
  }

  async function handleSubmit() {
    setSaving(true);
    setError('');

    const discountValue = Number(form.discount_value);
    if (!Number.isInteger(discountValue) || discountValue < 0) {
      setError('Discount value must be a non-negative integer');
      setSaving(false);
      return;
    }

    const payload = {
      code: form.code,
      description: form.description,
      discount_type: form.discount_type,
      discount_value: discountValue,
      min_order_inr: Number(form.min_order_inr) || 0,
      max_discount_inr: Number(form.max_discount_inr) || 0,
      scope: { item_ids: splitList(form.item_ids), category: splitList(form.category) },
      valid_from: form.valid_from ? new Date(form.valid_from).toISOString() : null,
      valid_to: form.valid_to ? new Date(form.valid_to).toISOString() : null,
      usage_limit: Number(form.usage_limit) || 0,
      per_user_limit: Number(form.per_user_limit) || 0,
      is_auto: form.is_auto,
      active: form.active,
    };

    try {
      const isCreate = editingId === 'new';
      const res = await fetch(isCreate ? '/api/coupons' : `/api/coupons/${editingId}`, {
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

  if (loading) return <Spinner label="Loading coupons…" />;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted">{coupons.length} coupon(s)</p>
        {editingId === null ? (
          <button
            type="button"
            onClick={startCreate}
            className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream hover:bg-tan-dark"
          >
            New coupon
          </button>
        ) : null}
      </div>

      {editingId !== null ? (
        <CouponForm
          form={form}
          setForm={setForm}
          onCancel={() => setEditingId(null)}
          onSubmit={handleSubmit}
          saving={saving}
          error={error}
          isCreate={editingId === 'new'}
        />
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#e5e5e5] text-xs uppercase text-muted">
              <th className="py-2 pr-3">Code</th>
              <th className="py-2 pr-3">Discount</th>
              <th className="py-2 pr-3">Min order</th>
              <th className="py-2 pr-3">Window</th>
              <th className="py-2 pr-3">Active</th>
              <th className="py-2 pr-3" />
            </tr>
          </thead>
          <tbody>
            {coupons.map((c) => (
              <tr key={c.id} className="border-b border-[#f2efe9]">
                <td className="py-2 pr-3 font-bold text-charcoal">{c.code}</td>
                <td className="py-2 pr-3 text-charcoal">
                  {c.discount_type === 'percent' ? `${c.discount_value}%` : `₹${c.discount_value}`}
                  {c.max_discount_inr > 0 ? ` (cap ₹${c.max_discount_inr})` : ''}
                </td>
                <td className="py-2 pr-3 text-muted">{c.min_order_inr > 0 ? `₹${c.min_order_inr}` : '—'}</td>
                <td className="py-2 pr-3 text-muted">
                  {c.valid_from ? new Date(c.valid_from).toLocaleDateString('en-IN') : '—'}
                  {' → '}
                  {c.valid_to ? new Date(c.valid_to).toLocaleDateString('en-IN') : '—'}
                </td>
                <td className="py-2 pr-3">
                  <button
                    type="button"
                    onClick={() => toggleActive(c)}
                    className={'rounded-md px-2 py-1 text-xs font-bold ' + (c.active ? 'bg-green-100 text-green-700' : 'bg-[#e5e5e5] text-muted')}
                  >
                    {c.active ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="py-2 pr-3">
                  <button type="button" onClick={() => startEdit(c)} className="text-tan hover:underline">
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {coupons.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-muted">
                  No coupons yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CouponForm({
  form,
  setForm,
  onCancel,
  onSubmit,
  saving,
  error,
  isCreate,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  onCancel: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: string;
  isCreate: boolean;
}) {
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  return (
    <div className="mb-4 rounded-md border border-[#e5e5e5] bg-[#faf7f4] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-charcoal">Code</span>
          <input value={form.code} onChange={(e) => set({ code: e.target.value })} disabled={!isCreate} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2 disabled:bg-[#f2efe9]" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Description</span>
          <input value={form.description} onChange={(e) => set({ description: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Type</span>
          <select value={form.discount_type} onChange={(e) => set({ discount_type: e.target.value as CouponDiscountType })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2">
            <option value="percent">Percent</option>
            <option value="flat">Flat ₹</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Value</span>
          <input type="number" value={form.discount_value} onChange={(e) => set({ discount_value: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Min order (₹)</span>
          <input type="number" value={form.min_order_inr} onChange={(e) => set({ min_order_inr: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Max discount (₹, 0 = no cap)</span>
          <input type="number" value={form.max_discount_inr} onChange={(e) => set({ max_discount_inr: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Usage limit (0 = unlimited)</span>
          <input type="number" value={form.usage_limit} onChange={(e) => set({ usage_limit: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Per-user limit (0 = unlimited)</span>
          <input type="number" value={form.per_user_limit} onChange={(e) => set({ per_user_limit: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Valid from</span>
          <input type="datetime-local" value={form.valid_from} onChange={(e) => set({ valid_from: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
        <label className="text-sm">
          <span className="text-charcoal">Valid to</span>
          <input type="datetime-local" value={form.valid_to} onChange={(e) => set({ valid_to: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="text-charcoal">Scope: item ids (comma-separated, blank = whole menu)</span>
          <input value={form.item_ids} onChange={(e) => set({ item_ids: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="text-charcoal">Scope: categories (comma-separated, blank = whole menu)</span>
          <input value={form.category} onChange={(e) => set({ category: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-charcoal">
          <input type="checkbox" checked={form.is_auto} onChange={(e) => set({ is_auto: e.target.checked })} />
          Auto-applied (no code needed)
        </label>
        <label className="flex items-center gap-2 text-sm text-charcoal">
          <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
          Active
        </label>
      </div>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={onSubmit} disabled={saving} className="rounded-md bg-tan px-5 py-2 text-sm font-bold text-cream hover:bg-tan-dark disabled:opacity-50">
          {saving ? 'Saving…' : isCreate ? 'Create coupon' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-bold text-muted hover:text-charcoal">
          Cancel
        </button>
      </div>
    </div>
  );
}
