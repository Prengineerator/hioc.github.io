'use client';

// Coffey add-ons (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2.3) — the "Add-ons"
// section at the end of Owner → Suggestions → Traits. Every add-on option has a
// small taste profile (what it does, which flavour families it brings, how much
// it adds); it is worked out from the menu's names, and the owner corrects
// whatever is wrong here. GET the groups, PATCH one option inline, DELETE to
// reset it to what the names give — all through /api/owner/suggest/addon-traits.
//
// Before supabase/2026-10-coffey-addons-pairings.sql is applied the section
// still shows the derived traits (so the owner can look), says what to apply,
// and turns editing off.
//
// The rules (the two-chip cap, the "+n" read-outs, the PATCH body) are pure
// helpers in lib/suggest/addonTraitsUi.ts. Each group is a table of its own that
// scrolls sideways inside its wrapper on a phone, so the page itself never does.

import { useCallback, useEffect, useState } from 'react';
import {
  ADDON_TRAITS_ENDPOINT,
  CHIP_LIMIT_HINTS,
  CHIP_LIMITS,
  deltaOptionLabel,
  deltaPills,
  familyLabel,
  formatAddonPrice,
  groupTitle,
  replaceOption,
  resetOverride,
  roleLabel,
  saveOverride,
  toAddonEditState,
  toggleFamily,
  toggleTexture,
  type AddonEditState,
  type AddonTraitsOption,
  type AddonTraitsOverview,
  type ChipField,
} from '@/lib/suggest/addonTraitsUi';
import { ADDON_INDULGENCE_DELTA_MAX, ADDON_INTENSITY_DELTA_MAX, ADDON_SWEETNESS_DELTA_MAX } from '@/lib/suggest/addonTraitsValidate';
import { TEXTURES } from '@/lib/suggest/traitVocabulary';
import { ADDON_ROLES, FLAVOUR_FAMILIES, type AddonRole, type FlavourFamily, type Texture } from '@/lib/suggest/types';

const COLUMN_COUNT = 8;

// 44 px is the smallest tap target on a phone (selects, buttons and chips alike).
const selectClass = 'min-h-[44px] rounded-md border border-line bg-cream px-2 text-sm text-charcoal';
// One colour and one weight per button (never two competing utilities).
const actionClass = (tone: 'strong' | 'normal' | 'muted') =>
  'inline-flex min-h-[44px] items-center rounded-md px-3 text-sm hover:underline disabled:opacity-40 disabled:hover:no-underline ' +
  (tone === 'strong' ? 'font-bold text-charcoal' : tone === 'normal' ? 'font-medium text-charcoal' : 'font-medium text-muted');
const chipClass = (on: boolean, atLimit: boolean) =>
  'inline-flex min-h-[44px] items-center rounded-full border px-3 text-xs font-bold ' +
  (on ? 'border-charcoal bg-charcoal text-cream' : 'border-line bg-surface text-charcoal') +
  (atLimit ? ' opacity-50' : '');
const pillClass = 'inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-xs font-bold text-charcoal';
const thClass = 'whitespace-nowrap py-2 pr-3 text-xs font-bold uppercase text-muted';
const tdClass = 'py-2 pr-3 align-top text-charcoal';
const stickyClass = 'sticky left-0 z-[1] bg-cream pl-3';

const range = (max: number): number[] => Array.from({ length: max + 1 }, (_, i) => i);

export interface AddonTraitsSectionProps {
  /** Starting state, for server rendering and tests (effects don't run there):
   * the data to show and a row to open in the inline editor. The section still
   * fetches on mount and replaces `data`. */
  initial?: { data?: AddonTraitsOverview; editingId?: string };
}

interface RowError {
  id: string;
  message: string;
}

function findOption(data: AddonTraitsOverview | undefined, id: string | undefined): AddonTraitsOption | null {
  if (!data || !id) return null;
  for (const group of data.groups) {
    const option = group.options.find((o) => o.id === id);
    if (option) return option;
  }
  return null;
}

function DeltaSelect({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (n: number) => void }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} className={selectClass}>
      {range(max).map((n) => (
        <option key={n} value={n}>
          {deltaOptionLabel(n)}
        </option>
      ))}
    </select>
  );
}

function Dash() {
  return <span className="text-muted">—</span>;
}

export function AddonTraitsSection({ initial }: AddonTraitsSectionProps) {
  const [data, setData] = useState<AddonTraitsOverview | null>(initial?.data ?? null);
  const [loading, setLoading] = useState(!initial?.data);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [editingId, setEditingId] = useState(initial?.editingId ?? '');
  const [edit, setEdit] = useState<AddonEditState | null>(() => {
    const option = findOption(initial?.data, initial?.editingId);
    return option ? toAddonEditState(option.traits) : null;
  });
  // Which chip group just refused a third tap — its hint is on screen.
  const [limitHit, setLimitHit] = useState<ChipField | null>(null);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(ADDON_TRAITS_ENDPOINT, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to load add-ons');
      setData(json as AddonTraitsOverview);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load add-ons');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const menuMissing = data?.menuMissing === true;

  function startEdit(option: AddonTraitsOption) {
    if (menuMissing) return;
    setEditingId(option.id);
    setEdit(toAddonEditState(option.traits));
    setLimitHit(null);
    setRowError(null);
    setNotice('');
  }

  function cancelEdit() {
    setEditingId('');
    setEdit(null);
    setLimitHit(null);
    setRowError(null);
  }

  function tapFamily(family: FlavourFamily) {
    if (!edit) return;
    const result = toggleFamily(edit, family);
    setEdit(result.edit);
    setLimitHit(result.refused ? 'flavour_families' : null);
  }

  function tapTexture(texture: Texture) {
    if (!edit) return;
    const result = toggleTexture(edit, texture);
    setEdit(result.edit);
    setLimitHit(result.refused ? 'textures' : null);
  }

  async function save(option: AddonTraitsOption) {
    if (!edit) return;
    setBusyId(option.id);
    setRowError(null);
    setNotice('');
    const result = await saveOverride(fetch, option.id, edit);
    if (result.ok) {
      // The server's own copy of the row, so what is shown is what is stored.
      const fresh = result.value;
      if (fresh) setData((d) => (d ? replaceOption(d, fresh) : d));
      else await load();
      setNotice(`Saved “${option.label}”.`);
      cancelEdit();
    } else {
      setRowError({ id: option.id, message: result.message });
    }
    setBusyId('');
  }

  async function reset(option: AddonTraitsOption) {
    setBusyId(option.id);
    setRowError(null);
    setNotice('');
    const result = await resetOverride(fetch, option.id);
    if (result.ok) {
      await load();
      setNotice(`“${option.label}” is back to what its name gives it.`);
      if (editingId === option.id) cancelEdit();
    } else {
      setRowError({ id: option.id, message: result.message });
    }
    setBusyId('');
  }

  function renderRow(option: AddonTraitsOption) {
    const editing = editingId === option.id ? edit : null;
    const busy = busyId === option.id;
    const view = option.traits;
    const pills = deltaPills(view);
    const pill = (key: 'sweetness' | 'strength' | 'treat') => pills.find((p) => p.key === key);

    return (
      <tr key={option.id} className="border-t border-line">
        <th scope="row" className={`${tdClass} ${stickyClass} text-left font-normal`}>
          <span className="font-medium">{option.name}</span>
          <span className="mt-0.5 block text-xs text-muted tabular-nums">
            {formatAddonPrice(option.price_inr)}
            {option.is_available ? '' : ' · switched off'}
          </span>
          {option.overridden ? <span className="mt-1 inline-flex rounded-full bg-tan-dark px-2 py-0.5 text-xs font-bold text-cream">Edited</span> : null}
        </th>

        <td className={tdClass}>
          {editing ? (
            <select
              aria-label={`Role for ${option.name}`}
              value={editing.role}
              onChange={(e) => setEdit((s) => (s ? { ...s, role: e.target.value as AddonRole } : s))}
              className={selectClass}
            >
              {ADDON_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          ) : (
            roleLabel(view.role)
          )}
        </td>

        <td className={tdClass}>
          {editing ? (
            <div className="min-w-[12rem]">
              <div role="group" aria-label={`Flavours for ${option.name}`} className="flex flex-wrap gap-1.5">
                {FLAVOUR_FAMILIES.map((f) => {
                  const on = editing.flavour_families.includes(f);
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => tapFamily(f)}
                      aria-pressed={on}
                      className={chipClass(on, !on && editing.flavour_families.length >= CHIP_LIMITS.flavour_families)}
                    >
                      {familyLabel(f)}
                    </button>
                  );
                })}
              </div>
              {limitHit === 'flavour_families' ? (
                <p role="status" className="mt-1 text-xs text-muted">
                  {CHIP_LIMIT_HINTS.flavour_families}
                </p>
              ) : null}
            </div>
          ) : view.flavour_families.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {view.flavour_families.map((f) => (
                <span key={f} className={pillClass}>
                  {familyLabel(f)}
                </span>
              ))}
            </div>
          ) : (
            <Dash />
          )}
        </td>

        <td className={`${tdClass} tabular-nums`}>
          {editing ? (
            <DeltaSelect
              label={`Sweetness added by ${option.name}`}
              value={editing.sweetness_delta}
              max={ADDON_SWEETNESS_DELTA_MAX}
              onChange={(n) => setEdit((s) => (s ? { ...s, sweetness_delta: n } : s))}
            />
          ) : (
            (pill('sweetness')?.text ?? <Dash />)
          )}
        </td>

        <td className={`${tdClass} tabular-nums`}>
          {editing ? (
            <DeltaSelect
              label={`Strength added by ${option.name}`}
              value={editing.intensity_delta}
              max={ADDON_INTENSITY_DELTA_MAX}
              onChange={(n) => setEdit((s) => (s ? { ...s, intensity_delta: n } : s))}
            />
          ) : (
            (pill('strength')?.text ?? <Dash />)
          )}
        </td>

        <td className={`${tdClass} tabular-nums`}>
          {editing ? (
            <DeltaSelect
              label={`Treat added by ${option.name}`}
              value={editing.indulgence_delta}
              max={ADDON_INDULGENCE_DELTA_MAX}
              onChange={(n) => setEdit((s) => (s ? { ...s, indulgence_delta: n } : s))}
            />
          ) : (
            (pill('treat')?.text ?? <Dash />)
          )}
        </td>

        <td className={tdClass}>
          {editing ? (
            <div className="min-w-[12rem]">
              <div role="group" aria-label={`Textures for ${option.name}`} className="flex flex-wrap gap-1.5">
                {TEXTURES.map((t) => {
                  const on = editing.textures.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => tapTexture(t)}
                      aria-pressed={on}
                      className={chipClass(on, !on && editing.textures.length >= CHIP_LIMITS.textures)}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              {limitHit === 'textures' ? (
                <p role="status" className="mt-1 text-xs text-muted">
                  {CHIP_LIMIT_HINTS.textures}
                </p>
              ) : null}
            </div>
          ) : view.textures.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {view.textures.map((t) => (
                <span key={t} className={pillClass}>
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <Dash />
          )}
        </td>

        <td className={`${tdClass} text-right`}>
          <div className="flex flex-wrap justify-end gap-1">
            {editing ? (
              <>
                <button type="button" onClick={() => save(option)} disabled={busy} className={actionClass('strong')}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={cancelEdit} disabled={busy} className={actionClass('muted')}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => startEdit(option)}
                disabled={menuMissing || busy}
                title={menuMissing ? 'Apply the SQL file first' : undefined}
                className={actionClass('normal')}
              >
                Edit
              </button>
            )}
            {option.overridden ? (
              <button type="button" onClick={() => reset(option)} disabled={busy} className={actionClass('muted')}>
                Reset to derived
              </button>
            ) : null}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <section aria-labelledby="addon-traits-heading" className="mt-8 min-w-0 border-t border-line pt-6">
      <h2 id="addon-traits-heading" className="text-sm font-bold uppercase tracking-wide text-muted">
        Add-ons
      </h2>
      <p className="mt-1 text-sm text-muted">
        Coffey reads these to point customers to an add-on for a flavour they asked for. They&apos;re worked out from the names; correct anything that&apos;s wrong.
      </p>

      {menuMissing ? (
        <div className="mt-3 rounded-md border border-line bg-surface p-3">
          <p className="text-sm font-bold text-charcoal">Apply supabase/2026-10-coffey-addons-pairings.sql in Supabase to save changes here</p>
          <p className="mt-0.5 text-xs text-muted">Until then these are the traits worked out from the names, and editing is turned off.</p>
        </div>
      ) : null}

      <div aria-live="polite">
        {loadError ? (
          <p role="alert" className="mt-3 text-sm font-medium text-red-700">
            {loadError}
          </p>
        ) : null}
        {notice ? <p className="mt-3 text-sm font-medium text-charcoal">{notice}</p> : null}
      </div>

      {loading ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : !data ? (
        <div className="py-6 text-center">
          <button type="button" onClick={() => void load()} className={actionClass('normal') + ' border border-line'}>
            Try again
          </button>
        </div>
      ) : data.groups.every((g) => g.options.length === 0) ? (
        <p className="py-6 text-center text-sm text-muted">No add-ons on the menu yet.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-6">
          {data.groups
            .filter((group) => group.options.length > 0)
            .map((group) => (
              <div key={group.id}>
                <h3 className="mb-2 text-sm font-bold text-charcoal">{groupTitle(group)}</h3>
                <div className="overflow-x-auto rounded-md border border-line">
                  <table className="w-full border-collapse text-left text-sm" style={{ minWidth: 960 }}>
                    <thead>
                      <tr>
                        <th scope="col" className={`${thClass} ${stickyClass}`}>
                          Option
                        </th>
                        <th scope="col" className={thClass}>
                          Role
                        </th>
                        <th scope="col" className={thClass}>
                          Flavours
                        </th>
                        <th scope="col" className={thClass}>
                          Sweet
                        </th>
                        <th scope="col" className={thClass}>
                          Strength
                        </th>
                        <th scope="col" className={thClass}>
                          Treat
                        </th>
                        <th scope="col" className={thClass}>
                          Textures
                        </th>
                        <th scope="col" className={`${thClass} text-right`}>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.options.flatMap((option) => [
                        renderRow(option),
                        rowError?.id === option.id ? (
                          <tr key={`${option.id}-error`}>
                            <td colSpan={COLUMN_COUNT} className="pb-3">
                              <p role="alert" className="text-sm font-semibold text-red-700">
                                {rowError.message}
                              </p>
                            </td>
                          </tr>
                        ) : null,
                      ])}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
