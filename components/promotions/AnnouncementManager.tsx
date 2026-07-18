'use client';

// Owner announcement/banner CRUD (LOY-5/CUS-071). Talks to
// app/api/announcements(?all=true) + app/api/announcements/[id].

import { useEffect, useState } from 'react';
import type { Announcement } from '@/lib/types';
import { Spinner } from '@/components/ui/Spinner';

type FormState = {
  title: string;
  body: string;
  image_url: string;
  starts_at: string;
  ends_at: string;
  active: boolean;
};

const EMPTY_FORM: FormState = { title: '', body: '', image_url: '', starts_at: '', ends_at: '', active: true };

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function announcementToForm(a: Announcement): FormState {
  return {
    title: a.title,
    body: a.body,
    image_url: a.image_url,
    starts_at: toDatetimeLocal(a.starts_at),
    ends_at: toDatetimeLocal(a.ends_at),
    active: a.active,
  };
}

export function AnnouncementManager() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/announcements?all=true', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setItems(data.announcements as Announcement[]);
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

  function startEdit(a: Announcement) {
    setEditingId(a.id);
    setForm(announcementToForm(a));
    setError('');
  }

  async function toggleActive(a: Announcement) {
    await fetch(`/api/announcements/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !a.active }),
    });
    await load();
  }

  async function remove(a: Announcement) {
    if (!confirm(`Delete "${a.title}"?`)) return;
    await fetch(`/api/announcements/${a.id}`, { method: 'DELETE' });
    await load();
  }

  async function handleSubmit() {
    if (!form.title.trim()) {
      setError('Title is required');
      return;
    }
    setSaving(true);
    setError('');
    const payload = {
      title: form.title,
      body: form.body,
      image_url: form.image_url,
      starts_at: form.starts_at ? new Date(form.starts_at).toISOString() : null,
      ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : null,
      active: form.active,
    };
    try {
      const isCreate = editingId === 'new';
      const res = await fetch(isCreate ? '/api/announcements' : `/api/announcements/${editingId}`, {
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

  if (loading) return <Spinner label="Loading announcements…" />;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted">{items.length} announcement(s)</p>
        {editingId === null ? (
          <button type="button" onClick={startCreate} className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream hover:bg-tan-dark">
            New announcement
          </button>
        ) : null}
      </div>

      {editingId !== null ? (
        <div className="mb-4 rounded-md border border-[#e5e5e5] bg-[#faf7f4] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm sm:col-span-2">
              <span className="text-charcoal">Title</span>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="text-charcoal">Body</span>
              <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={3} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="text-charcoal">Image URL (optional)</span>
              <input value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
            </label>
            <label className="text-sm">
              <span className="text-charcoal">Starts at (optional)</span>
              <input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
            </label>
            <label className="text-sm">
              <span className="text-charcoal">Ends at (optional)</span>
              <input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-charcoal">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Active
          </label>
          {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
          <div className="mt-4 flex items-center gap-3">
            <button type="button" onClick={handleSubmit} disabled={saving} className="rounded-md bg-tan px-5 py-2 text-sm font-bold text-cream hover:bg-tan-dark disabled:opacity-50">
              {saving ? 'Saving…' : editingId === 'new' ? 'Create' : 'Save changes'}
            </button>
            <button type="button" onClick={() => setEditingId(null)} className="text-sm font-bold text-muted hover:text-charcoal">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <ul className="flex flex-col gap-2">
        {items.map((a) => (
          <li key={a.id} className="flex items-center justify-between rounded-md border border-[#e5e5e5] bg-cream px-4 py-3">
            <div>
              <p className="text-sm font-bold text-charcoal">{a.title}</p>
              <p className="text-xs text-muted">
                {a.starts_at ? new Date(a.starts_at).toLocaleDateString('en-IN') : 'Always'}
                {' → '}
                {a.ends_at ? new Date(a.ends_at).toLocaleDateString('en-IN') : 'No end'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => toggleActive(a)}
                className={'rounded-md px-2 py-1 text-xs font-bold ' + (a.active ? 'bg-green-100 text-green-700' : 'bg-[#e5e5e5] text-muted')}
              >
                {a.active ? 'Active' : 'Inactive'}
              </button>
              <button type="button" onClick={() => startEdit(a)} className="text-sm text-tan hover:underline">
                Edit
              </button>
              <button type="button" onClick={() => remove(a)} className="text-sm text-red-700 hover:underline">
                Delete
              </button>
            </div>
          </li>
        ))}
        {items.length === 0 ? <p className="py-6 text-center text-sm text-muted">No announcements yet.</p> : null}
      </ul>
    </div>
  );
}
