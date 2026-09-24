'use client';

// Phase 7 · SUG-2 — the owner's review table for AI-tagged menu traits
// (Opus, or Gemini Flash on the free tier — lib/suggest/models.ts's
// llmProvider()). Mirrors components/owner/TableManager.tsx's fetch/edit/save
// pattern: GET the list, PATCH one row inline, PATCH { confirmIds } in bulk,
// POST the generator. Every write ends by refetching rather than trusting the
// client's optimistic guess.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DAYPARTS, MOODS, type Daypart, type Mood, type MenuItemTraits } from '@/lib/suggest/types';

interface TraitsOverviewRow {
  menuItemId: string;
  name: string;
  category: string;
  parentCategory: string;
  isVeg: boolean;
  isAvailable: boolean;
  traits: MenuItemTraits | null;
}

interface TraitsOverview {
  rows: TraitsOverviewRow[];
  unconfirmedCount: number;
  missingCount: number;
  missingTables: boolean;
}

interface EditState {
  temperature: MenuItemTraits['temperature'];
  caffeine: MenuItemTraits['caffeine'];
  is_coffee: boolean;
  sweetness: MenuItemTraits['sweetness'];
  body: MenuItemTraits['body'];
  kind: MenuItemTraits['kind'];
  moods: Mood[];
  dayparts: Daypart[];
  flavor_notes: string; // comma-joined while editing
}

function toEditState(t: MenuItemTraits): EditState {
  return {
    temperature: t.temperature,
    caffeine: t.caffeine,
    is_coffee: t.is_coffee,
    sweetness: t.sweetness,
    body: t.body,
    kind: t.kind,
    moods: t.moods,
    dayparts: t.dayparts,
    flavor_notes: t.flavor_notes.join(', '),
  };
}

const TEMPERATURES: MenuItemTraits['temperature'][] = ['hot', 'iced', 'either', 'ambient'];
const CAFFEINES: MenuItemTraits['caffeine'][] = ['none', 'low', 'medium', 'high'];
const BODIES: MenuItemTraits['body'][] = ['light', 'medium', 'rich'];
const KINDS: MenuItemTraits['kind'][] = ['drink', 'food', 'dessert'];
const SWEETNESS_LEVELS: MenuItemTraits['sweetness'][] = [0, 1, 2, 3];

type Filter = 'unconfirmed' | 'missing' | 'all';

const selectClass = 'rounded border border-[#d8d2c7] bg-white px-1 py-1 text-xs text-charcoal';
const chipClass = (active: boolean) =>
  'rounded-full px-2 py-0.5 text-[10px] font-bold ' + (active ? 'bg-charcoal text-cream' : 'bg-[#f2efe9] text-charcoal');

export function TraitsTab() {
  const [data, setData] = useState<TraitsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsReview, setNeedsReview] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>('unconfirmed');
  const [editingId, setEditingId] = useState('');
  const [edit, setEdit] = useState<EditState | null>(null);
  const [savingId, setSavingId] = useState('');
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/owner/suggest/traits', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to load traits');
      setData(json as TraitsOverview);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load traits');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleRows = useMemo(() => {
    if (!data) return [];
    if (filter === 'unconfirmed') return data.rows.filter((r) => r.traits && !r.traits.confirmed);
    if (filter === 'missing') return data.rows.filter((r) => !r.traits);
    return data.rows;
  }, [data, filter]);

  function startEdit(row: TraitsOverviewRow) {
    if (!row.traits) return;
    setEditingId(row.menuItemId);
    setEdit(toEditState(row.traits));
    setError('');
    setNotice('');
  }

  function cancelEdit() {
    setEditingId('');
    setEdit(null);
  }

  function toggleMood(mood: Mood) {
    setEdit((s) => (s ? { ...s, moods: s.moods.includes(mood) ? s.moods.filter((m) => m !== mood) : [...s.moods, mood] } : s));
  }

  function toggleDaypart(dp: Daypart) {
    setEdit((s) =>
      s ? { ...s, dayparts: s.dayparts.includes(dp) ? s.dayparts.filter((d) => d !== dp) : [...s.dayparts, dp] } : s,
    );
  }

  async function saveEdit(id: string) {
    if (!edit) return;
    setSavingId(id);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/owner/suggest/traits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          temperature: edit.temperature,
          caffeine: edit.caffeine,
          is_coffee: edit.is_coffee,
          sweetness: edit.sweetness,
          body: edit.body,
          kind: edit.kind,
          moods: edit.moods,
          dayparts: edit.dayparts,
          flavor_notes: edit.flavor_notes
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 5),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Save failed');
      setNotice('Saved and confirmed.');
      cancelEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingId('');
    }
  }

  async function confirmRow(id: string) {
    setSavingId(id);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/owner/suggest/traits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, confirm: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Confirm failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed');
    } finally {
      setSavingId('');
    }
  }

  async function confirmAllVisible() {
    const ids = visibleRows.filter((r) => r.traits && !r.traits.confirmed).map((r) => r.menuItemId);
    if (ids.length === 0) return;
    setConfirmingAll(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/owner/suggest/traits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmIds: ids }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Bulk confirm failed');
      setNotice(`Confirmed ${json.confirmed ?? ids.length} item(s).`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk confirm failed');
    } finally {
      setConfirmingAll(false);
    }
  }

  async function generateMissing() {
    setGenerating(true);
    setError('');
    setNotice('');
    setNeedsReview([]);
    try {
      const res = await fetch('/api/owner/suggest/traits/generate', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Generation failed');
      // Surface WHY something went wrong (e.g. a wrong Gemini model id, a 429
      // quota error, a Jev item that never started) whenever it's present —
      // even alongside a partial-success notice below, not only when nothing
      // got tagged at all.
      if (json.error) setError(json.error);
      if ((json.tagged ?? 0) > 0) {
        setNotice(
          `Tagged ${json.tagged ?? 0} of ${json.requested ?? 0} item(s) with AI (~$${(json.costUsd ?? 0).toFixed(4)}). Review them below before confirming.`,
        );
      }
      if (Array.isArray(json.needsReview) && json.needsReview.length > 0) setNeedsReview(json.needsReview);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  const noVisibleToConfirm = visibleRows.every((r) => !r.traits || r.traits.confirmed);

  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Menu traits</h2>
          {data && (
            <p className="mt-1 text-sm font-medium text-charcoal">
              {data.unconfirmedCount} unconfirmed / {data.missingCount} missing
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className={selectClass}>
            <option value="unconfirmed">Unconfirmed</option>
            <option value="missing">Missing</option>
            <option value="all">All items</option>
          </select>
          <button
            type="button"
            onClick={confirmAllVisible}
            disabled={confirmingAll || noVisibleToConfirm}
            className="rounded-md border border-charcoal px-3 py-1.5 text-sm font-bold text-charcoal hover:bg-[#f2efe9] disabled:opacity-40"
          >
            {confirmingAll ? 'Confirming…' : 'Confirm all visible'}
          </button>
          <button
            type="button"
            onClick={generateMissing}
            disabled={generating}
            className="rounded-md bg-charcoal px-3 py-1.5 text-sm font-bold text-cream hover:opacity-90 disabled:opacity-50"
          >
            {generating ? 'Tagging with AI…' : 'Generate missing traits with AI'}
          </button>
        </div>
      </div>

      {error ? <p className="mb-2 text-sm font-medium text-red-700">{error}</p> : null}
      {notice ? <p className="mb-2 text-sm font-medium text-[#2f6b38]">{notice}</p> : null}
      {needsReview.length > 0 ? (
        <p className="mb-2 text-sm font-medium text-[#8a6412]">
          Jev was unsure about these — please check them first: {needsReview.join(', ')}
        </p>
      ) : null}

      {loading ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : data?.missingTables ? (
        <p className="py-6 text-center text-sm text-muted">
          The traits table isn&apos;t migrated on this database yet — run supabase/2026-09-suggestion-engine.sql.
        </p>
      ) : visibleRows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Nothing here.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className="border-b border-[#e5e5e5] text-left text-xs uppercase text-muted">
                <th className="py-1 pr-2 font-bold">Item</th>
                <th className="py-1 pr-2 font-bold">Temp</th>
                <th className="py-1 pr-2 font-bold">Caffeine</th>
                <th className="py-1 pr-2 font-bold">Coffee</th>
                <th className="py-1 pr-2 font-bold">Sweet</th>
                <th className="py-1 pr-2 font-bold">Body</th>
                <th className="py-1 pr-2 font-bold">Kind</th>
                <th className="py-1 pr-2 font-bold">Moods</th>
                <th className="py-1 pr-2 font-bold">Dayparts</th>
                <th className="py-1 pr-2 font-bold">Flavor notes</th>
                <th className="py-1 pr-2 font-bold">Status</th>
                <th className="py-1 text-right font-bold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const editing = editingId === row.menuItemId;
                const t = row.traits;
                const busy = savingId === row.menuItemId;
                return (
                  <tr key={row.menuItemId} className="border-b border-[#f2efe9] align-top">
                    <td className="py-2 pr-2 text-charcoal">
                      <span className="font-medium">{row.name}</span>
                      <br />
                      <span className="text-xs text-muted">{row.category}</span>
                    </td>

                    {!t ? (
                      <td colSpan={9} className="py-2 text-xs text-muted">
                        No traits yet — use “Generate missing traits with AI” above.
                      </td>
                    ) : editing && edit ? (
                      <>
                        <td className="py-2 pr-2">
                          <select
                            value={edit.temperature}
                            onChange={(e) => setEdit((s) => (s ? { ...s, temperature: e.target.value as EditState['temperature'] } : s))}
                            className={selectClass}
                          >
                            {TEMPERATURES.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 pr-2">
                          <select
                            value={edit.caffeine}
                            onChange={(e) => setEdit((s) => (s ? { ...s, caffeine: e.target.value as EditState['caffeine'] } : s))}
                            className={selectClass}
                          >
                            {CAFFEINES.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 pr-2">
                          <input
                            type="checkbox"
                            checked={edit.is_coffee}
                            onChange={(e) => setEdit((s) => (s ? { ...s, is_coffee: e.target.checked } : s))}
                          />
                        </td>
                        <td className="py-2 pr-2">
                          <select
                            value={edit.sweetness}
                            onChange={(e) =>
                              setEdit((s) => (s ? { ...s, sweetness: Number(e.target.value) as EditState['sweetness'] } : s))
                            }
                            className={selectClass}
                          >
                            {SWEETNESS_LEVELS.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 pr-2">
                          <select
                            value={edit.body}
                            onChange={(e) => setEdit((s) => (s ? { ...s, body: e.target.value as EditState['body'] } : s))}
                            className={selectClass}
                          >
                            {BODIES.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 pr-2">
                          <select
                            value={edit.kind}
                            onChange={(e) => setEdit((s) => (s ? { ...s, kind: e.target.value as EditState['kind'] } : s))}
                            className={selectClass}
                          >
                            {KINDS.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 pr-2">
                          <div className="flex flex-wrap gap-1">
                            {MOODS.map((m) => (
                              <button
                                key={m}
                                type="button"
                                onClick={() => toggleMood(m)}
                                aria-pressed={edit.moods.includes(m)}
                                className={chipClass(edit.moods.includes(m))}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className="py-2 pr-2">
                          <div className="flex flex-wrap gap-1">
                            {DAYPARTS.map((d) => (
                              <button
                                key={d}
                                type="button"
                                onClick={() => toggleDaypart(d)}
                                aria-pressed={edit.dayparts.includes(d)}
                                className={chipClass(edit.dayparts.includes(d))}
                              >
                                {d}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className="py-2 pr-2">
                          <input
                            value={edit.flavor_notes}
                            onChange={(e) => setEdit((s) => (s ? { ...s, flavor_notes: e.target.value } : s))}
                            placeholder="chocolate, nutty"
                            className="w-36 rounded border border-[#d8d2c7] bg-white px-1 py-1 text-xs"
                          />
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-2 pr-2 text-charcoal">{t.temperature}</td>
                        <td className="py-2 pr-2 text-charcoal">{t.caffeine}</td>
                        <td className="py-2 pr-2 text-charcoal">{t.is_coffee ? 'Yes' : 'No'}</td>
                        <td className="py-2 pr-2 text-charcoal">{t.sweetness}</td>
                        <td className="py-2 pr-2 text-charcoal">{t.body}</td>
                        <td className="py-2 pr-2 text-charcoal">{t.kind}</td>
                        <td className="py-2 pr-2 text-charcoal">{t.moods.join(', ') || '—'}</td>
                        <td className="py-2 pr-2 text-charcoal">{t.dayparts.join(', ') || '—'}</td>
                        <td className="py-2 pr-2 text-charcoal">{t.flavor_notes.join(', ') || '—'}</td>
                      </>
                    )}

                    <td className="py-2 pr-2">
                      {t ? (
                        <span
                          className={
                            'rounded-full px-2 py-0.5 text-xs font-bold ' +
                            (t.confirmed ? 'bg-[#e3efe4] text-[#2f6b38]' : 'bg-[#f6e9c9] text-[#8a6412]')
                          }
                        >
                          {t.confirmed ? 'Confirmed' : `${t.source === 'opus' ? 'AI' : 'Owner'} · unconfirmed`}
                        </span>
                      ) : (
                        <span className="rounded-full bg-[#f6d9d9] px-2 py-0.5 text-xs font-bold text-red-800">Missing</span>
                      )}
                    </td>

                    <td className="py-2 text-right">
                      {!t ? null : editing ? (
                        <div className="flex justify-end gap-3">
                          <button
                            type="button"
                            onClick={() => saveEdit(row.menuItemId)}
                            disabled={busy}
                            className="text-sm font-bold text-charcoal hover:underline disabled:opacity-50"
                          >
                            {busy ? 'Saving…' : 'Save'}
                          </button>
                          <button type="button" onClick={cancelEdit} className="text-sm font-medium text-muted hover:underline">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-3">
                          <button type="button" onClick={() => startEdit(row)} className="text-sm font-medium text-charcoal hover:underline">
                            Edit
                          </button>
                          {!t.confirmed && (
                            <button
                              type="button"
                              onClick={() => confirmRow(row.menuItemId)}
                              disabled={busy}
                              className="text-sm font-medium text-[#2f6b38] hover:underline disabled:opacity-50"
                            >
                              {busy ? '…' : 'Confirm'}
                            </button>
                          )}
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
  );
}
