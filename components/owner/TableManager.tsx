'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

interface TableRow {
  id: string;
  label: string;
  zone: string;
  capacity: number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Owner CRUD for the dine-in tables registry (FND3-1). Mirrors the TeamManager
// pattern: an add form + a list with per-row actions, all talking to
// /api/owner/tables (owner-gated, service-role writes).
export function TableManager() {
  const [tables, setTables] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [zone, setZone] = useState('');
  const [capacity, setCapacity] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState('');
  const [edit, setEdit] = useState<{ label: string; zone: string; capacity: string }>({
    label: '',
    zone: '',
    capacity: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/owner/tables', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load tables');
      setTables(data.tables ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tables');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/owner/tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          zone: zone.trim(),
          capacity: capacity ? Number(capacity) : 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to add table');
      setNotice(`Table "${label.trim()}" added.`);
      setLabel('');
      setZone('');
      setCapacity('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add table');
    } finally {
      setSubmitting(false);
    }
  }

  async function patch(id: string, patchBody: Record<string, unknown>, okMsg: string) {
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/owner/tables', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patchBody }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Update failed');
      setNotice(okMsg);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
      return false;
    }
  }

  function startEdit(t: TableRow) {
    setEditingId(t.id);
    setEdit({ label: t.label, zone: t.zone, capacity: String(t.capacity || '') });
  }

  async function saveEdit(id: string) {
    const ok = await patch(
      id,
      { label: edit.label.trim(), zone: edit.zone.trim(), capacity: edit.capacity ? Number(edit.capacity) : 0 },
      'Table updated.',
    );
    if (ok) setEditingId('');
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Add form */}
      <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-muted">Add a table</h2>
        <p className="mb-4 text-sm text-muted">
          Give each table a short label (e.g. <span className="font-medium">T1</span>). Zone and seats are
          optional.
        </p>
        <form onSubmit={handleAdd} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-charcoal">Label</span>
            <input
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="T1"
              className="w-28 rounded-md border border-[#d8d2c7] bg-white px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-charcoal">Zone (optional)</span>
            <input
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="Terrace"
              className="rounded-md border border-[#d8d2c7] bg-white px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-charcoal">Seats (optional)</span>
            <input
              type="number"
              min={0}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="4"
              className="w-24 rounded-md border border-[#d8d2c7] bg-white px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-charcoal px-5 py-2 text-sm font-bold text-cream transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add table'}
          </button>
        </form>
        {error ? <p className="mt-3 text-sm font-medium text-red-700">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm font-medium text-[#2f6b38]">{notice}</p> : null}
      </div>

      {/* Tables list */}
      <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-muted">Your tables</h2>
        {loading ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : tables.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No tables yet. Add your first above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-[#e5e5e5] text-left text-xs uppercase text-muted">
                  <th className="py-1 font-bold">Label</th>
                  <th className="py-1 font-bold">Zone</th>
                  <th className="py-1 font-bold">Seats</th>
                  <th className="py-1 font-bold">Status</th>
                  <th className="py-1 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => {
                  const editing = editingId === t.id;
                  return (
                    <tr key={t.id} className="border-b border-[#f2efe9] align-middle">
                      <td className="py-2 text-charcoal">
                        {editing ? (
                          <input
                            value={edit.label}
                            onChange={(e) => setEdit((s) => ({ ...s, label: e.target.value }))}
                            className="w-24 rounded border border-[#d8d2c7] bg-white px-2 py-1"
                          />
                        ) : (
                          <span className={t.is_active ? 'font-medium' : 'font-medium text-muted line-through'}>
                            {t.label}
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-charcoal">
                        {editing ? (
                          <input
                            value={edit.zone}
                            onChange={(e) => setEdit((s) => ({ ...s, zone: e.target.value }))}
                            className="w-28 rounded border border-[#d8d2c7] bg-white px-2 py-1"
                          />
                        ) : (
                          t.zone || <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="py-2 text-charcoal">
                        {editing ? (
                          <input
                            type="number"
                            min={0}
                            value={edit.capacity}
                            onChange={(e) => setEdit((s) => ({ ...s, capacity: e.target.value }))}
                            className="w-16 rounded border border-[#d8d2c7] bg-white px-2 py-1"
                          />
                        ) : (
                          t.capacity || <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="py-2">
                        <span
                          className={
                            'rounded-full px-2 py-0.5 text-xs font-bold ' +
                            (t.is_active ? 'bg-[#e3efe4] text-[#2f6b38]' : 'bg-[#f2efe9] text-muted')
                          }
                        >
                          {t.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        {editing ? (
                          <div className="flex justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => saveEdit(t.id)}
                              className="text-sm font-bold text-charcoal hover:underline"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId('')}
                              className="text-sm font-medium text-muted hover:underline"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => startEdit(t)}
                              className="text-sm font-medium text-charcoal hover:underline"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                patch(t.id, { regenerate_token: true }, `New QR code generated for ${t.label}.`)
                              }
                              className="text-sm font-medium text-charcoal hover:underline"
                            >
                              New QR
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                patch(
                                  t.id,
                                  { is_active: !t.is_active },
                                  `${t.label} ${t.is_active ? 'deactivated' : 'reactivated'}.`,
                                )
                              }
                              className={
                                'text-sm font-medium hover:underline ' +
                                (t.is_active ? 'text-red-700' : 'text-[#2f6b38]')
                              }
                            >
                              {t.is_active ? 'Deactivate' : 'Reactivate'}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
