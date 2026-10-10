'use client';

// Phase 7 · SUG-2 + Coffey v2 (docs/COFFEY-SPEC.md §3.4) — the owner's review
// table for AI-tagged menu traits (Jev — lib/suggest/traitsPrompt.ts). Mirrors
// components/owner/TableManager.tsx's fetch/edit/save pattern: GET the list,
// PATCH one row inline, PATCH { confirmIds } in bulk, POST the generator. Every
// write ends by refetching rather than trusting the client's optimistic guess.
//
// Coffey v2 adds, on top of the v1 columns:
//   * a banner — "N items need Coffey's new taste profile" — with the
//     "Regenerate with Jev" button (POST /api/owner/suggest/traits/generate).
//     Before supabase/2026-10-coffey-traits-v2.sql is applied the banner says so
//     and the button is disabled. Regenerate asks first: owner-edited rows keep
//     their edits, every other row comes back unconfirmed.
//   * per-row read-outs — a 0–10 sweetness bar, strength / refresh / treat /
//     novelty as 0–3 numbers, up to three textures and the top moods from
//     `mood_fit` — and inline editing of them, in the same style as the v1
//     fields. The table scrolls sideways on a phone (DataTable's own wrapper).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AddonTraitsSection } from '@/components/owner/suggestions/AddonTraitsSection';
import { ConfirmDialog } from '@/components/staff/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import type { TraitsOverview, TraitsOverviewRow } from '@/lib/suggest/queries';
import { sweetnessLevel } from '@/lib/suggest/sweetness';
import { TEXTURES } from '@/lib/suggest/traitVocabulary';
import { MAX_TEXTURES, MOOD_FIT_MAX, SWEETNESS_LEVEL_MAX, TRAIT_SCORE_MAX, V2_ONLY_MOODS, moodsFromFit, roundFit } from '@/lib/suggest/traitsValidate';
import { CURRENT_TRAITS_VERSION, DAYPARTS, MOODS, type Daypart, type MenuItemTraits, type Mood, type Texture } from '@/lib/suggest/types';

type ScoreField = 'intensity' | 'refreshment' | 'indulgence' | 'novelty';
const SCORE_FIELDS: ScoreField[] = ['intensity', 'refreshment', 'indulgence', 'novelty'];

export interface EditState {
  temperature: MenuItemTraits['temperature'];
  caffeine: MenuItemTraits['caffeine'];
  is_coffee: boolean;
  sweetness: MenuItemTraits['sweetness']; // legacy 0–3 — only edited before the v2 migration
  body: MenuItemTraits['body'];
  kind: MenuItemTraits['kind'];
  moods: Mood[];
  dayparts: Daypart[];
  flavor_notes: string; // comma-joined while editing
  // Coffey v2 — null means "not tagged at v2 yet" and is left out of the save.
  sweetness_level: number | null;
  intensity: number | null;
  refreshment: number | null;
  indulgence: number | null;
  novelty: number | null;
  textures: Texture[];
  /** The row has a graded fit per mood, so `moods` is edited THROUGH the fit
   * (moodsFromFit) — the engine reads mood_fit first, so toggling a v1 chip
   * alone would silently do nothing. */
  hasMoodFit: boolean;
  mood_fit: Record<Mood, string>; // number inputs, as typed
}

export function toEditState(t: MenuItemTraits): EditState {
  const fit = t.mood_fit ?? {};
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
    sweetness_level: t.sweetness_level ?? null,
    intensity: t.intensity ?? null,
    refreshment: t.refreshment ?? null,
    indulgence: t.indulgence ?? null,
    novelty: t.novelty ?? null,
    textures: t.textures ?? [],
    hasMoodFit: Object.keys(fit).length > 0,
    mood_fit: Object.fromEntries(MOODS.map((m) => [m, fit[m] === undefined ? '' : String(fit[m])])) as Record<Mood, string>,
  };
}

/** The mood-fit inputs as a graded fit, or a message naming the bad one. An
 * empty box means "not graded" (left out, i.e. 0). */
function parseMoodFit(raw: Record<Mood, string>): Partial<Record<Mood, number>> | string {
  const fit: Partial<Record<Mood, number>> = {};
  for (const mood of MOODS) {
    const text = raw[mood].trim();
    if (text === '') continue;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0 || n > MOOD_FIT_MAX) return `Mood fit for “${mood}” must be a number from 0 to ${MOOD_FIT_MAX}.`;
    fit[mood] = roundFit(n);
  }
  return fit;
}

/**
 * The PATCH body for one row's inline edit — or a message when an input is
 * invalid. Before the migration only the v1 fields (and the legacy 0–3
 * sweetness) are sent; after it, sweetness is edited on the 0–10 scale (the
 * route derives the legacy value from it) and the v2 fields go too. A v2 field
 * that is still null on the row is left out rather than sent as null.
 */
export function buildSavePayload(id: string, edit: EditState, migrationApplied: boolean): Record<string, unknown> | string {
  const body: Record<string, unknown> = {
    id,
    temperature: edit.temperature,
    caffeine: edit.caffeine,
    is_coffee: edit.is_coffee,
    body: edit.body,
    kind: edit.kind,
    dayparts: edit.dayparts,
    flavor_notes: edit.flavor_notes
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5),
  };
  if (!migrationApplied) {
    body.sweetness = edit.sweetness;
    body.moods = edit.moods;
    return body;
  }

  if (edit.sweetness_level !== null) body.sweetness_level = edit.sweetness_level;
  else body.sweetness = edit.sweetness;
  for (const field of SCORE_FIELDS) if (edit[field] !== null) body[field] = edit[field];
  body.textures = edit.textures;

  if (edit.hasMoodFit) {
    const fit = parseMoodFit(edit.mood_fit);
    if (typeof fit === 'string') return fit;
    body.mood_fit = fit;
    // An emptied grid means "not graded": keep the row's moods as they were.
    body.moods = Object.keys(fit).length > 0 ? moodsFromFit(fit) : edit.moods;
  } else {
    body.moods = edit.moods;
  }
  return body;
}

/** The moods worth showing from a graded fit: those that fit at least "could
 * work" (1), best first, at most three — or the single best. */
export function topMoodFits(fit: Partial<Record<Mood, number>>): { mood: Mood; fit: number }[] {
  const ranked = MOODS.map((mood) => ({ mood, fit: fit[mood] ?? 0 })).sort((a, b) => b.fit - a.fit);
  const shown = ranked.filter((r) => r.fit >= 1).slice(0, 3);
  return shown.length > 0 ? shown : ranked.slice(0, 1);
}

const TEMPERATURES: MenuItemTraits['temperature'][] = ['hot', 'iced', 'either', 'ambient'];
const CAFFEINES: MenuItemTraits['caffeine'][] = ['none', 'low', 'medium', 'high'];
const BODIES: MenuItemTraits['body'][] = ['light', 'medium', 'rich'];
const KINDS: MenuItemTraits['kind'][] = ['drink', 'food', 'dessert'];
const SWEETNESS_LEVELS: MenuItemTraits['sweetness'][] = [0, 1, 2, 3];

/** How many trait columns sit between the item name and the status — the span
 * of the "No traits yet" message. */
const TRAIT_COLUMN_COUNT = 14;

export type Filter = 'unconfirmed' | 'missing' | 'upgrade' | 'all';

const selectClass = 'rounded border border-line bg-white px-1 py-1 text-xs text-charcoal';
const chipClass = (active: boolean) =>
  'rounded-full px-2 py-0.5 text-[10px] font-bold ' + (active ? 'bg-charcoal text-cream' : 'bg-surface text-charcoal');

const needsProfile = (t: MenuItemTraits | null): boolean => !t || (t.traits_version ?? 1) < CURRENT_TRAITS_VERSION;

/** A 0–10 sweetness bar. Tan is decoration only (never text), so the number
 * beside it carries the value; a dimmed bar means the level is still an
 * estimate from the old 0–3 value, not yet tagged by Jev. */
function SweetnessBar({ level, estimated }: { level: number; estimated: boolean }) {
  return (
    <div className="flex items-center gap-1.5" title={estimated ? `${level}/10 — estimated from the old 0–3 value` : `${level}/10`}>
      <div
        role="img"
        aria-label={`Sweetness ${level} out of ${SWEETNESS_LEVEL_MAX}`}
        className="h-2 w-14 shrink-0 overflow-hidden rounded-full bg-surface ring-1 ring-inset ring-line"
      >
        <div className={'h-full rounded-full ' + (estimated ? 'bg-tan/50' : 'bg-tan')} style={{ width: `${(level / SWEETNESS_LEVEL_MAX) * 100}%` }} />
      </div>
      <span className="text-xs tabular-nums text-charcoal">{level}</span>
    </div>
  );
}

function ScoreSelect({ label, value, max, onChange }: { label: string; value: number | null; max: number; onChange: (v: number | null) => void }) {
  return (
    <select
      aria-label={label}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      className={selectClass}
    >
      {value === null ? <option value="">—</option> : null}
      {Array.from({ length: max + 1 }, (_, i) => (
        <option key={i} value={i}>
          {i}
        </option>
      ))}
    </select>
  );
}

interface RegenResult {
  tagged: number;
  remaining: number;
  costUsd: number;
}

export interface TraitsTabProps {
  /** Starting state, for server rendering and tests (effects don't run there):
   * the rows to show, which filter to open on (the owner's review queue,
   * "unconfirmed", by default) and a row to open in the inline editor. The tab
   * still fetches on mount and replaces `data`. */
  initial?: { data?: TraitsOverview; filter?: Filter; editingId?: string };
}

export function TraitsTab({ initial }: TraitsTabProps) {
  const [data, setData] = useState<TraitsOverview | null>(initial?.data ?? null);
  const [loading, setLoading] = useState(!initial?.data);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsReview, setNeedsReview] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>(initial?.filter ?? 'unconfirmed');
  const [editingId, setEditingId] = useState(initial?.editingId ?? '');
  const [edit, setEdit] = useState<EditState | null>(() => {
    const traits = initial?.data?.rows.find((r) => r.menuItemId === initial.editingId)?.traits;
    return traits ? toEditState(traits) : null;
  });
  const [savingId, setSavingId] = useState('');
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [askRegenerate, setAskRegenerate] = useState(false);
  const [regenResult, setRegenResult] = useState<RegenResult | null>(null);

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
    if (filter === 'upgrade') return data.rows.filter((r) => needsProfile(r.traits));
    return data.rows;
  }, [data, filter]);

  const migrated = data?.migrationApplied === true;

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

  function toggleTexture(texture: Texture) {
    setEdit((s) => {
      if (!s) return s;
      if (s.textures.includes(texture)) return { ...s, textures: s.textures.filter((t) => t !== texture) };
      return s.textures.length >= MAX_TEXTURES ? s : { ...s, textures: [...s.textures, texture] };
    });
  }

  async function saveEdit(id: string) {
    if (!edit) return;
    const payload = buildSavePayload(id, edit, migrated);
    if (typeof payload === 'string') {
      setError(payload);
      return;
    }
    setSavingId(id);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/owner/suggest/traits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

  // "Regenerate with Jev" — COFFEY-SPEC §3.3. Works in ~50s slices: the route
  // answers with how many items are still below the current version, and
  // pressing again continues from there.
  async function regenerate() {
    setRegenerating(true);
    setError('');
    setNotice('');
    setNeedsReview([]);
    setRegenResult(null);
    try {
      const res = await fetch('/api/owner/suggest/traits/generate', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Regenerate failed');
      // Surface WHY something went wrong (e.g. a bad key, a 429 rate limit,
      // a Jev item that never started) whenever it's present — even alongside
      // a partial-success result below, not only when nothing got tagged.
      if (json.error) setError(json.error);
      setRegenResult({ tagged: json.tagged ?? 0, remaining: json.remaining ?? 0, costUsd: json.costUsd ?? 0 });
      if (Array.isArray(json.needsReview) && json.needsReview.length > 0) setNeedsReview(json.needsReview);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Regenerate failed');
    } finally {
      setRegenerating(false);
    }
  }

  const noVisibleToConfirm = visibleRows.every((r) => !r.traits || r.traits.confirmed);
  const editing = (row: TraitsOverviewRow): EditState | null => (editingId === row.menuItemId ? edit : null);

  const scoreColumn = (key: string, header: string, field: ScoreField): DataTableColumn<TraitsOverviewRow> => ({
    key,
    header,
    filter: 'select',
    align: 'center',
    padding: 'py-2 pr-2',
    value: (row) => row.traits?.[field] ?? null,
    cellClassName: 'tabular-nums text-charcoal',
    render: (row) => {
      const e = editing(row);
      if (e && migrated) {
        return (
          <ScoreSelect
            label={header}
            value={e[field]}
            max={TRAIT_SCORE_MAX}
            onChange={(v) => setEdit((s) => (s ? { ...s, [field]: v } : s))}
          />
        );
      }
      const v = row.traits?.[field];
      return v === null || v === undefined ? <span className="text-muted">—</span> : v;
    },
  });

  const columns: DataTableColumn<TraitsOverviewRow>[] = [
    {
      key: 'item',
      header: 'Item',
      filter: 'text',
      sticky: true,
      value: (row) => `${row.name} ${row.category}`,
      cellClassName: 'text-charcoal',
      render: (row) => (
        <>
          <span className="font-medium">{row.name}</span>
          <br />
          <span className="text-xs text-muted">{row.category}</span>
        </>
      ),
    },
    {
      key: 'temperature',
      header: 'Temp',
      filter: 'select',
      value: (row) => row.traits?.temperature ?? null,
      // An item with no traits shows one message across all the trait columns.
      cellSpan: (row) => (row.traits ? 1 : TRAIT_COLUMN_COUNT),
      cellClassName: (row) => (row.traits ? 'text-charcoal' : 'text-xs text-muted'),
      render: (row) => {
        const t = row.traits;
        if (!t) return 'No traits yet — press “Regenerate with Jev” above.';
        const e = editing(row);
        if (e) {
          return (
            <select
              value={e.temperature}
              onChange={(ev) => setEdit((s) => (s ? { ...s, temperature: ev.target.value as EditState['temperature'] } : s))}
              className={selectClass}
            >
              {TEMPERATURES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          );
        }
        return t.temperature;
      },
    },
    {
      key: 'caffeine',
      header: 'Caffeine',
      filter: 'select',
      value: (row) => row.traits?.caffeine ?? null,
      cellClassName: 'text-charcoal',
      render: (row) => {
        const e = editing(row);
        if (e) {
          return (
            <select
              value={e.caffeine}
              onChange={(ev) => setEdit((s) => (s ? { ...s, caffeine: ev.target.value as EditState['caffeine'] } : s))}
              className={selectClass}
            >
              {CAFFEINES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          );
        }
        return row.traits?.caffeine;
      },
    },
    {
      key: 'coffee',
      header: 'Coffee',
      filter: 'select',
      value: (row) => (row.traits ? (row.traits.is_coffee ? 'Yes' : 'No') : null),
      cellClassName: 'text-charcoal',
      render: (row) => {
        const e = editing(row);
        return e ? (
          <input
            type="checkbox"
            aria-label="Coffee-based"
            checked={e.is_coffee}
            onChange={(ev) => setEdit((s) => (s ? { ...s, is_coffee: ev.target.checked } : s))}
          />
        ) : row.traits?.is_coffee ? (
          'Yes'
        ) : (
          'No'
        );
      },
    },
    {
      // The 0–10 scale once the migration is applied (a legacy row reads as
      // 0→0, 1→3, 2→6, 3→9 through sweetnessLevel); the old 0–3 label before.
      key: 'sweetness',
      header: 'Sweetness',
      filter: 'select',
      value: (row) => (row.traits ? (migrated ? sweetnessLevel(row.traits) : row.traits.sweetness) : null),
      cellClassName: 'text-charcoal',
      render: (row) => {
        const t = row.traits;
        if (!t) return null;
        const e = editing(row);
        if (e && migrated && e.sweetness_level !== null) {
          return (
            <ScoreSelect
              label="Sweetness, 0 to 10"
              value={e.sweetness_level}
              max={SWEETNESS_LEVEL_MAX}
              onChange={(v) => setEdit((s) => (s ? { ...s, sweetness_level: v } : s))}
            />
          );
        }
        if (e) {
          return (
            <select
              aria-label="Sweetness, 0 to 3"
              value={e.sweetness}
              onChange={(ev) => setEdit((s) => (s ? { ...s, sweetness: Number(ev.target.value) as EditState['sweetness'] } : s))}
              className={selectClass}
            >
              {SWEETNESS_LEVELS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          );
        }
        if (!migrated) return t.sweetness;
        return <SweetnessBar level={sweetnessLevel(t)} estimated={needsProfile(t)} />;
      },
    },
    {
      key: 'body',
      header: 'Body',
      filter: 'select',
      value: (row) => row.traits?.body ?? null,
      cellClassName: 'text-charcoal',
      render: (row) => {
        const e = editing(row);
        if (e) {
          return (
            <select
              value={e.body}
              onChange={(ev) => setEdit((s) => (s ? { ...s, body: ev.target.value as EditState['body'] } : s))}
              className={selectClass}
            >
              {BODIES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          );
        }
        return row.traits?.body;
      },
    },
    {
      key: 'kind',
      header: 'Kind',
      filter: 'select',
      value: (row) => row.traits?.kind ?? null,
      cellClassName: 'text-charcoal',
      render: (row) => {
        const e = editing(row);
        if (e) {
          return (
            <select
              value={e.kind}
              onChange={(ev) => setEdit((s) => (s ? { ...s, kind: ev.target.value as EditState['kind'] } : s))}
              className={selectClass}
            >
              {KINDS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          );
        }
        return row.traits?.kind;
      },
    },
    scoreColumn('intensity', 'Strength', 'intensity'),
    scoreColumn('refreshment', 'Refresh', 'refreshment'),
    scoreColumn('indulgence', 'Treat', 'indulgence'),
    scoreColumn('novelty', 'Novelty', 'novelty'),
    {
      key: 'textures',
      header: 'Textures',
      filter: 'text',
      value: (row) => row.traits?.textures?.join(', ') ?? null,
      cellClassName: 'text-charcoal',
      render: (row) => {
        const e = editing(row);
        if (e && migrated) {
          return (
            <div className="flex min-w-[9rem] flex-wrap gap-1">
              {TEXTURES.map((t) => {
                const on = e.textures.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTexture(t)}
                    aria-pressed={on}
                    disabled={!on && e.textures.length >= MAX_TEXTURES}
                    className={chipClass(on) + ' disabled:opacity-40'}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          );
        }
        const textures = (row.traits?.textures ?? []).slice(0, MAX_TEXTURES);
        return textures.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {textures.map((t) => (
              <span key={t} className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-bold text-charcoal">
                {t}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-muted">—</span>
        );
      },
    },
    {
      key: 'moods',
      header: 'Moods',
      filter: 'text',
      value: (row) => row.traits?.moods.join(', ') ?? null,
      cellClassName: 'text-charcoal',
      render: (row) => {
        const t = row.traits;
        const e = editing(row);
        if (e && e.hasMoodFit) {
          // A graded row: edit the fit; `moods` follows from it on save.
          return (
            <div className="grid min-w-[10rem] grid-cols-2 gap-x-2 gap-y-1">
              {MOODS.map((m) => (
                <label key={m} className="flex items-center justify-between gap-1 text-[10px] text-muted">
                  {m}
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={MOOD_FIT_MAX}
                    step={0.1}
                    value={e.mood_fit[m]}
                    onChange={(ev) => setEdit((s) => (s ? { ...s, mood_fit: { ...s.mood_fit, [m]: ev.target.value } } : s))}
                    className="w-12 rounded border border-line bg-white px-1 py-0.5 text-xs text-charcoal"
                  />
                </label>
              ))}
            </div>
          );
        }
        if (e) {
          // Before the migration the database's moods CHECK only knows the six v1 moods.
          const offered = migrated ? MOODS : MOODS.filter((m) => !V2_ONLY_MOODS.includes(m));
          return (
            <div className="flex flex-wrap gap-1">
              {offered.map((m) => (
                <button key={m} type="button" onClick={() => toggleMood(m)} aria-pressed={e.moods.includes(m)} className={chipClass(e.moods.includes(m))}>
                  {m}
                </button>
              ))}
            </div>
          );
        }
        if (!t) return null;
        if (t.mood_fit && Object.keys(t.mood_fit).length > 0) {
          return (
            <div className="flex flex-wrap gap-1">
              {topMoodFits(t.mood_fit).map(({ mood, fit }) => (
                <span key={mood} className={chipClass(fit >= 2)}>
                  {mood} {fit.toFixed(1)}
                </span>
              ))}
            </div>
          );
        }
        return t.moods.join(', ') || '—';
      },
    },
    {
      key: 'dayparts',
      header: 'Dayparts',
      filter: 'text',
      value: (row) => row.traits?.dayparts.join(', ') ?? null,
      cellClassName: 'text-charcoal',
      render: (row) => {
        const e = editing(row);
        return e ? (
          <div className="flex flex-wrap gap-1">
            {DAYPARTS.map((d) => (
              <button key={d} type="button" onClick={() => toggleDaypart(d)} aria-pressed={e.dayparts.includes(d)} className={chipClass(e.dayparts.includes(d))}>
                {d}
              </button>
            ))}
          </div>
        ) : (
          row.traits?.dayparts.join(', ') || '—'
        );
      },
    },
    {
      key: 'flavor',
      header: 'Flavor notes',
      filter: 'text',
      value: (row) => row.traits?.flavor_notes.join(', ') ?? null,
      cellClassName: 'text-charcoal',
      render: (row) => {
        const e = editing(row);
        return e ? (
          <input
            value={e.flavor_notes}
            onChange={(ev) => setEdit((s) => (s ? { ...s, flavor_notes: ev.target.value } : s))}
            placeholder="chocolate, nutty"
            aria-label="Flavor notes"
            className="w-36 rounded border border-line bg-white px-1 py-1 text-xs"
          />
        ) : (
          row.traits?.flavor_notes.join(', ') || '—'
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      filter: 'select',
      value: (row) => {
        const t = row.traits;
        if (!t) return 'Missing';
        return t.confirmed ? 'Confirmed' : `${t.source === 'opus' ? 'AI' : 'Owner'} · unconfirmed`;
      },
      render: (row) => {
        const t = row.traits;
        return t ? (
          <>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-bold ' +
                (t.confirmed ? 'bg-[#e3efe4] text-[#2f6b38]' : 'bg-[#f6e9c9] text-[#8a6412]')
              }
            >
              {t.confirmed ? 'Confirmed' : `${t.source === 'opus' ? 'AI' : 'Owner'} · unconfirmed`}
            </span>
            {migrated && needsProfile(t) ? <span className="mt-1 block text-[10px] text-muted">needs Coffey profile</span> : null}
          </>
        ) : (
          <span className="rounded-full bg-[#f6d9d9] px-2 py-0.5 text-xs font-bold text-red-800">Missing</span>
        );
      },
    },
    {
      key: 'actions',
      header: 'Actions',
      filter: 'none',
      align: 'right',
      value: () => null,
      render: (row) => {
        const t = row.traits;
        const busy = savingId === row.menuItemId;
        if (!t) return null;
        if (editingId === row.menuItemId) {
          return (
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
          );
        }
        return (
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
        );
      },
    },
  ];

  const needsUpgrade = data?.needsUpgrade ?? 0;

  return (
    <div className="rounded-md border border-line bg-cream p-5 shadow-sm">
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
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Show" className={selectClass}>
            <option value="unconfirmed">Unconfirmed</option>
            <option value="missing">Missing</option>
            {migrated ? <option value="upgrade">Needs Coffey profile</option> : null}
            <option value="all">All items</option>
          </select>
          <button
            type="button"
            onClick={confirmAllVisible}
            disabled={confirmingAll || noVisibleToConfirm}
            className="rounded-md border border-charcoal px-3 py-1.5 text-sm font-bold text-charcoal hover:bg-surface disabled:opacity-40"
          >
            {confirmingAll ? 'Confirming…' : 'Confirm all visible'}
          </button>
        </div>
      </div>

      {data && !data.missingTables ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface p-3">
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-sm font-bold text-charcoal">
              {!migrated
                ? "Apply supabase/2026-10-coffey-traits-v2.sql in Supabase to unlock Coffey's new taste profile"
                : needsUpgrade === 0
                  ? "Every item has Coffey's new taste profile"
                  : `${needsUpgrade} ${needsUpgrade === 1 ? 'item needs' : 'items need'} Coffey's new taste profile`}
            </p>
            {migrated ? (
              <p className="mt-0.5 text-xs text-muted">
                Jev re-tags each item on the new dimensions. Items you edited keep your edits; the rest come back unconfirmed for a quick review.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setAskRegenerate(true)}
            disabled={!migrated || regenerating}
            aria-busy={regenerating}
            className="rounded-md bg-charcoal px-3 py-1.5 text-sm font-bold text-cream hover:opacity-90 disabled:opacity-50"
          >
            {regenerating ? 'Regenerating… (up to a minute)' : 'Regenerate with Jev'}
          </button>
        </div>
      ) : null}

      <div aria-live="polite">
        {error ? <p className="mb-2 text-sm font-medium text-red-700">{error}</p> : null}
        {regenResult ? (
          <p className="mb-2 text-sm font-medium text-[#2f6b38]">
            Tagged {regenResult.tagged} — {regenResult.remaining} remaining
            {regenResult.remaining > 0 ? ' (press again to continue)' : ''} · ~${regenResult.costUsd.toFixed(4)}
            {regenResult.tagged > 0 ? '. Review the unconfirmed items below before confirming.' : ''}
          </p>
        ) : null}
        {notice ? <p className="mb-2 text-sm font-medium text-[#2f6b38]">{notice}</p> : null}
        {needsReview.length > 0 ? (
          <p className="mb-2 text-sm font-medium text-[#8a6412]">
            Jev was unsure about these — please check them first: {needsReview.join(', ')}
          </p>
        ) : null}
      </div>

      {loading ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : data?.missingTables ? (
        <p className="py-6 text-center text-sm text-muted">
          The traits table isn&apos;t migrated on this database yet — run supabase/2026-09-suggestion-engine.sql.
        </p>
      ) : visibleRows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Nothing here.</p>
      ) : (
        <DataTable
          rows={visibleRows}
          rowKey={(row) => row.menuItemId}
          minWidth={migrated ? 1640 : 1000}
          cellPadding="py-2 pr-2"
          headerTextClassName="text-xs font-bold uppercase text-muted"
          rowClassName={() => 'align-top'}
          columns={columns}
        />
      )}

      {askRegenerate ? (
        <ConfirmDialog
          heading="Regenerate with Jev?"
          body="Jev re-tags every item that needs Coffey's new taste profile. Items you have edited yourself keep every edit you made — only the new taste fields are filled in. All the other items come back unconfirmed, so give them a quick review afterwards. If it can't finish in one go, press it again to continue."
          confirmLabel="Regenerate"
          onConfirm={() => {
            setAskRegenerate(false);
            void regenerate();
          }}
          onCancel={() => setAskRegenerate(false)}
        />
      ) : null}

      <AddonTraitsSection />
    </div>
  );
}
