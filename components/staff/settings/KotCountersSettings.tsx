'use client';

// KOT counters — POS → Settings → KOT counters. Which counter prepares which
// menu categories, so a KOT prints as one slip per counter (lib/print/
// kotRouting.ts). Everyone at the counter can see the setup; only a manager or
// the owner can change it (enforced by PUT /api/pos/kot-routing — `canEdit`
// here only decides whether the controls render).
//
// Edits are staged and saved with one button rather than on every change:
// renaming a counter and moving three categories is one decision, and saving
// it half-done would print half-routed tickets in between.

import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { KOT_COUNTER_LIMITS, OTHER_ITEMS_TITLE, type KotRouting } from '@/lib/print/kotRouting';
import { formToRouting, nextCounterKey, routingToForm, type KotCountersForm } from '@/lib/staff/kotCountersForm';

interface LoadResponse {
  routing: KotRouting;
  categories: string[];
  canEdit: boolean;
}

const CARD = 'rounded-md border border-[#e5e5e5] bg-white p-4';
const INPUT =
  'min-h-[44px] rounded-md border border-[#e5e5e5] px-3 text-sm text-charcoal focus:border-tan focus:outline-none disabled:bg-surface';

export function KotCountersSettings() {
  const [form, setForm] = useState<KotCountersForm | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoadError('');
    const res = await fetch('/api/pos/kot-routing', { cache: 'no-store' }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as (LoadResponse & { error?: string }) | null;
    if (!res?.ok || !data) {
      setLoadError(data?.error ?? 'Could not load the KOT counters.');
      return;
    }
    setForm(routingToForm(data.routing, data.categories));
    setCanEdit(data.canEdit);
    setDirty(false);
  }

  function update(next: (prev: KotCountersForm) => KotCountersForm) {
    setForm((prev) => (prev ? next(prev) : prev));
    setDirty(true);
    setMessage(null);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/pos/kot-routing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formToRouting(form)),
      });
      const data = (await res.json().catch(() => null)) as { routing?: KotRouting; error?: string } | null;
      if (!res.ok || !data?.routing) {
        setMessage({ kind: 'error', text: data?.error ?? 'Could not save. Try again.' });
        return;
      }
      setForm((prev) => (prev ? routingToForm(data.routing!, prev.categories) : prev));
      setDirty(false);
      setMessage({ kind: 'ok', text: 'Saved. The next KOT prints with these counters.' });
    } catch {
      setMessage({ kind: 'error', text: 'Could not save. Check the connection and try again.' });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className={CARD}>
        <p className="text-sm text-red-700">{loadError}</p>
        <button type="button" onClick={() => void load()} className="mt-3 min-h-[44px] rounded-md border border-[#e5e5e5] px-4 text-sm font-bold text-charcoal">
          Try again
        </button>
      </div>
    );
  }
  if (!form) return <Spinner label="Loading KOT counters…" />;

  const disabled = !canEdit || saving;
  const names = form.counters.map((c) => c.name.trim().toLowerCase());
  const hasBlankName = names.some((n) => !n);
  const hasDuplicateName = names.some((n, i) => n && names.indexOf(n) !== i);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-bold text-charcoal">KOT counters</h1>
        <p className="mt-1 text-sm text-muted">
          Split each kitchen ticket by counter. The printer prints one slip per counter with only that counter&apos;s
          items, and cuts between slips. Categories on no counter print on an &ldquo;{OTHER_ITEMS_TITLE}&rdquo; slip.
          With no counters, the KOT prints as one ticket, as before.
        </p>
        {!canEdit ? (
          <p className="mt-2 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
            Only a manager or the owner can change these settings.
          </p>
        ) : null}
      </div>

      <section className={CARD} aria-labelledby="kot-counters-heading">
        <h2 id="kot-counters-heading" className="font-bold text-charcoal">
          Counters
        </h2>
        {form.counters.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No counters yet: every KOT prints as a single ticket.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {form.counters.map((counter, i) => (
              <li key={counter.key} className="flex items-center gap-2">
                <input
                  value={counter.name}
                  maxLength={KOT_COUNTER_LIMITS.maxNameLength}
                  disabled={disabled}
                  placeholder="e.g. Coffee Bar"
                  aria-label={`Counter ${i + 1} name`}
                  onChange={(e) =>
                    update((f) => ({
                      ...f,
                      counters: f.counters.map((c) => (c.key === counter.key ? { ...c, name: e.target.value } : c)),
                    }))
                  }
                  className={`${INPUT} min-w-0 flex-1`}
                />
                {canEdit ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() =>
                      update((f) => ({
                        ...f,
                        counters: f.counters.filter((c) => c.key !== counter.key),
                        assignment: Object.fromEntries(
                          Object.entries(f.assignment).map(([cat, key]) => [cat, key === counter.key ? '' : key]),
                        ),
                      }))
                    }
                    className="min-h-[44px] rounded-md border border-[#e5e5e5] px-3 text-sm font-bold text-charcoal hover:border-red-400 disabled:opacity-50"
                    aria-label={`Remove ${counter.name || `counter ${i + 1}`}`}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit && form.counters.length < KOT_COUNTER_LIMITS.maxCounters ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => update((f) => ({ ...f, counters: [...f.counters, { key: nextCounterKey(f.counters), name: '' }] }))}
            className="mt-3 min-h-[44px] rounded-md border border-charcoal px-4 text-sm font-bold text-charcoal disabled:opacity-50"
          >
            + Add counter
          </button>
        ) : null}
      </section>

      <section className={CARD} aria-labelledby="kot-categories-heading">
        <h2 id="kot-categories-heading" className="font-bold text-charcoal">
          Menu categories
        </h2>
        {form.counters.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Add a counter first, then choose where each category is made.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {form.categories.map((category) => (
              <li key={category} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <label htmlFor={`kot-cat-${category}`} className="text-sm font-bold text-charcoal">
                  {category}
                </label>
                <select
                  id={`kot-cat-${category}`}
                  value={form.assignment[category] ?? ''}
                  disabled={disabled}
                  onChange={(e) =>
                    update((f) => ({ ...f, assignment: { ...f.assignment, [category]: e.target.value } }))
                  }
                  className={`${INPUT} w-full bg-white sm:w-56`}
                >
                  <option value="">{OTHER_ITEMS_TITLE} slip</option>
                  {form.counters.map((c, i) => (
                    <option key={c.key} value={c.key}>
                      {c.name.trim() || `Counter ${i + 1}`}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`${CARD} flex items-center justify-between gap-4`}>
        <div>
          <h2 className="font-bold text-charcoal">Also print a full KOT</h2>
          <p className="text-sm text-muted">
            An extra last slip with every item, for whoever checks that the whole order is ready.
          </p>
        </div>
        {canEdit ? (
          <ToggleSwitch
            checked={form.fullCopy}
            onChange={(next) => update((f) => ({ ...f, fullCopy: next }))}
            label="Also print a full KOT"
          />
        ) : (
          <span className="text-sm font-bold text-charcoal">{form.fullCopy ? 'On' : 'Off'}</span>
        )}
      </section>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty || hasBlankName || hasDuplicateName}
            className="min-h-[44px] rounded-md bg-charcoal px-5 text-sm font-bold text-cream disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {hasBlankName ? <p className="text-sm text-red-700">Every counter needs a name.</p> : null}
          {hasDuplicateName ? <p className="text-sm text-red-700">Two counters have the same name.</p> : null}
          {message ? (
            <p role="status" className={`text-sm ${message.kind === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
              {message.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
