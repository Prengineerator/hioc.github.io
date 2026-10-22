'use client';

// POS → Menu → Add-ons: the form for a new add-on group, or for editing one —
// its name, whether customers pick one option or several, and its options with
// their prices. Like the menu item form, the owner's save applies at once and
// anyone else's goes to the owner for approval (2026-10-addon-change-requests.sql);
// the parent does the saving and says which happened.
//
// Existing options can be renamed and repriced but not removed: past orders and
// stock recipes point at them. An option the café stops offering is switched off
// in On / off. New options (not saved yet) can be removed again.

import { useState, type FormEvent } from 'react';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useModalDismiss } from '@/lib/hooks/useModalDismiss';
import { ADDON_NAME_MAX, ADDON_OPTIONS_MAX, ADDON_PRICE_MAX } from '@/lib/menu/addonLimits';
import type { AddonOptionChange, AddonSelection } from '@/lib/menu/changeRequestTypes';
import type { AddonGroup } from '@/lib/types';

export interface AddonGroupFormValues {
  display_name: string;
  selection_type: AddonSelection;
  min_select: number;
  max_select: number;
  options: AddonOptionChange[];
}

type OptionRow = { id?: string; name: string; price: string };

const INPUT = 'w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan';

export function AddonGroupFormModal({
  mode,
  initial,
  approvalNeeded,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial?: AddonGroup;
  /** The save goes to the owner (staff and managers): the button says so. */
  approvalNeeded: boolean;
  onClose: () => void;
  onSubmit: (values: AddonGroupFormValues) => Promise<void>;
}) {
  useModalDismiss(onClose);
  const [name, setName] = useState(initial?.display_name ?? '');
  const [selection, setSelection] = useState<AddonSelection>(initial?.selection_type ?? 'single');
  const [required, setRequired] = useState((initial?.min_select ?? 0) > 0);
  const [minSelect, setMinSelect] = useState(String(initial?.min_select ?? 0));
  const [maxSelect, setMaxSelect] = useState(String(initial?.max_select ?? 1));
  const [rows, setRows] = useState<OptionRow[]>(
    initial && initial.options.length > 0
      ? [...initial.options]
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((o) => ({ id: o.id, name: o.name, price: String(o.price_inr) }))
      : [{ name: '', price: '0' }],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function chooseSelection(next: AddonSelection) {
    if (next === selection) return;
    setSelection(next);
    if (next === 'multi') {
      // Several: keep "required" as a minimum of one, and allow every option.
      setMinSelect(required ? '1' : '0');
      setMaxSelect(String(Math.max(1, rows.length)));
    } else {
      setRequired(Number(minSelect) > 0);
    }
  }

  function updateRow(index: number, field: 'name' | 'price', value: string) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }

  function addRow() {
    setRows((prev) => [...prev, { name: '', price: '0' }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  // The server checks all of this again; these say it before a round trip.
  function collect(): AddonGroupFormValues | string {
    const displayName = name.trim();
    if (!displayName) return 'Give the add-on group a name.';
    if (displayName.length > ADDON_NAME_MAX) return `The name must be ${ADDON_NAME_MAX} characters or fewer.`;
    if (rows.length === 0) return 'Add at least one option.';
    if (rows.length > ADDON_OPTIONS_MAX) return `An add-on group can have at most ${ADDON_OPTIONS_MAX} options.`;

    const options: AddonOptionChange[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const optionName = row.name.trim();
      if (!optionName) return 'Every option needs a name.';
      if (optionName.length > ADDON_NAME_MAX) return `Option names must be ${ADDON_NAME_MAX} characters or fewer.`;
      const key = optionName.toLowerCase();
      if (seen.has(key)) return `"${optionName}" is listed twice.`;
      seen.add(key);
      const price = Number(row.price);
      // Number('') is 0, so a blank price is checked separately rather than
      // silently becoming a free option.
      if (row.price.trim() === '' || !Number.isInteger(price) || price < 0 || price > ADDON_PRICE_MAX) {
        return `The price for "${optionName}" must be a whole number of rupees (0 for free).`;
      }
      options.push(row.id ? { id: row.id, name: optionName, price_inr: price } : { name: optionName, price_inr: price });
    }

    if (selection === 'single') {
      return { display_name: displayName, selection_type: 'single', min_select: required ? 1 : 0, max_select: 1, options };
    }
    const min = Number(minSelect);
    const max = Number(maxSelect);
    if (!Number.isInteger(min) || !Number.isInteger(max)) return 'Minimum and maximum must be whole numbers.';
    if (max < 1) return 'Allow at least one choice.';
    if (min < 0 || min > max) return 'The minimum must be between 0 and the maximum.';
    if (max > options.length) return `The maximum can't be more than the ${options.length} option(s) listed.`;
    return { display_name: displayName, selection_type: 'multi', min_select: min, max_select: max, options };
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const values = collect();
    if (typeof values === 'string') {
      setError(values);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the add-on group');
    } finally {
      setSubmitting(false);
    }
  }

  const saveLabel = approvalNeeded ? 'Send for approval' : mode === 'create' ? 'Save add-on group' : 'Save changes';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-4 py-8">
      <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 bg-charcoal/50" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="addon-form-title"
        className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-md bg-cream shadow-sm"
      >
        <h2 id="addon-form-title" className="border-b border-line px-6 py-4 text-lg font-bold text-charcoal">
          {mode === 'create' ? 'New add-on group' : 'Edit add-on group'}
        </h2>

        <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {error ? (
              <div role="alert" className="mb-4 rounded-md border border-tan bg-surface px-4 py-3 text-sm text-charcoal">
                {error}
              </div>
            ) : null}

            <div className="flex flex-col gap-4">
              <div>
                <label htmlFor="addon-name" className="mb-1 block text-sm font-bold text-charcoal">
                  Name customers see
                </label>
                <input
                  id="addon-name"
                  type="text"
                  required
                  maxLength={ADDON_NAME_MAX}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Choice of Milk"
                  className={INPUT}
                />
              </div>

              <div>
                <span id="addon-pick-label" className="mb-1 block text-sm font-bold text-charcoal">
                  Customers pick
                </span>
                <div className="flex gap-2" role="group" aria-labelledby="addon-pick-label">
                  {(
                    [
                      ['single', 'One option'],
                      ['multi', 'Several options'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selection === value}
                      onClick={() => chooseSelection(value)}
                      className={
                        'min-h-[40px] flex-1 rounded-md border px-3 text-sm font-bold transition-colors ' +
                        (selection === value
                          ? 'border-charcoal bg-charcoal text-cream'
                          : 'border-line text-charcoal hover:border-tan')
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {selection === 'single' ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="text-sm font-bold text-charcoal">Required</span>
                    <p className="text-xs text-muted">
                      {required
                        ? 'Customers must choose one before adding the item.'
                        : 'Customers may skip it.'}
                    </p>
                  </div>
                  <ToggleSwitch checked={required} onChange={setRequired} label="Required" />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="addon-min" className="mb-1 block text-sm font-bold text-charcoal">
                      At least
                    </label>
                    <input
                      id="addon-min"
                      type="number"
                      min={0}
                      step={1}
                      value={minSelect}
                      onChange={(e) => setMinSelect(e.target.value)}
                      className={INPUT}
                    />
                    <p className="mt-1 text-xs text-muted">0 = optional</p>
                  </div>
                  <div>
                    <label htmlFor="addon-max" className="mb-1 block text-sm font-bold text-charcoal">
                      At most
                    </label>
                    <input
                      id="addon-max"
                      type="number"
                      min={1}
                      step={1}
                      value={maxSelect}
                      onChange={(e) => setMaxSelect(e.target.value)}
                      className={INPUT}
                    />
                  </div>
                </div>
              )}

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-bold text-charcoal">Options &amp; prices</span>
                  <button
                    type="button"
                    onClick={addRow}
                    disabled={rows.length >= ADDON_OPTIONS_MAX}
                    className="text-sm font-bold text-tan-dark hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    + Add option
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {rows.map((row, i) => (
                    <div key={row.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        aria-label={`Option ${i + 1} name`}
                        placeholder="e.g. Oat milk"
                        maxLength={ADDON_NAME_MAX}
                        value={row.name}
                        onChange={(e) => updateRow(i, 'name', e.target.value)}
                        className="min-w-[8rem] flex-[2] rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
                      />
                      <div className="flex min-w-[6.5rem] flex-1 items-center rounded-md border border-line focus-within:border-tan">
                        <span className="whitespace-nowrap pl-3 text-muted">+₹</span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Option ${i + 1} price in rupees`}
                          value={row.price}
                          onChange={(e) => updateRow(i, 'price', e.target.value)}
                          className="w-full min-w-0 rounded-md px-2 py-2 text-charcoal outline-none"
                        />
                      </div>
                      {/* Saved options stay (renamed or repriced, never removed); a new
                          one can be taken out again. The slot keeps rows aligned. */}
                      {row.id ? (
                        <span aria-hidden="true" className="w-8 shrink-0" />
                      ) : (
                        <button
                          type="button"
                          aria-label={`Remove new option ${row.name || i + 1}`}
                          onClick={() => removeRow(i)}
                          disabled={rows.length === 1}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg leading-none text-charcoal hover:bg-surface hover:text-tan-dark disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">
                  Price is what the option adds to the item (0 for free).
                  {mode === 'edit'
                    ? ' Saved options can be renamed or repriced; to stop offering one, switch it off in On / off.'
                    : ''}
                </p>
              </div>

              {approvalNeeded ? (
                <p className="rounded-md bg-surface px-3 py-2 text-xs text-charcoal">
                  This goes to the owner for approval. The menu stays as it is until they approve.
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-line px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-4 py-2 text-sm font-bold text-charcoal hover:border-tan"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-tan-dark px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saveLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
