'use client';

// Which drinks a HIOC Ritual cup can pay for (docs/COFFEE-PASS-SPEC.md CP-D3, §9 B2).
// The menu, grouped by category, with a checkbox per item, "Select all" per category,
// and one-tap shortcuts for the coffee categories. Unavailable items are greyed (and
// say so in words) but still tickable: an item that is out today is back tomorrow.
//
// Saving REPLACES the eligible set (PUT /api/owner/passes/eligible), so what is ticked
// here is exactly what customers can use a cup on. The save bar sticks to the bottom
// of the screen while anything is changed, because on a phone the list is long.
//
// The menu payload carries no prices, so the "a customer would always top up" warning
// (an item dearer than every plan's cup value) is not possible here; see the report.

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { CoffeePassPlan } from '@/lib/passes/types';
import { PASS_SHORT_NAME } from '@/lib/passes/brand';
import {
  categorySelection,
  countSelected,
  eligibleSaveWarning,
  groupMenuByCategory,
  quickCategories,
  sameSelection,
  setCategorySelected,
  withSelection,
  type PickerItem,
} from '@/lib/passes/ownerUi';
import { callOwnerApi } from './api';
import { InlineError, Section } from './shared';

export function EligibleDrinks({
  menu,
  eligibleIds,
  plans,
  onSaved,
}: {
  menu: PickerItem[];
  eligibleIds: string[];
  plans: Pick<CoffeePassPlan, 'is_active'>[];
  onSaved: (ids: string[]) => void;
}) {
  const saved = useMemo(() => new Set(eligibleIds), [eligibleIds]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(eligibleIds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const groups = useMemo(() => groupMenuByCategory(menu), [menu]);
  const quick = useMemo(() => quickCategories(groups), [groups]);
  const count = countSelected(menu, selected);
  const dirty = !sameSelection(selected, saved);
  const warning = eligibleSaveWarning({ selectedCount: count, hasActivePlan: plans.some((p) => p.is_active) });

  const change = (next: Set<string>) => {
    setSelected(next);
    setError('');
    setNotice(''); // the notice belongs to the last save
    setConfirmEmpty(false);
  };

  async function save() {
    setSaving(true);
    setError('');
    const ids = menu.filter((m) => selected.has(m.id)).map((m) => m.id);
    const res = await callOwnerApi<{ eligible_ids: string[] }>('/api/owner/passes/eligible', {
      method: 'PUT',
      json: { menu_item_ids: ids },
    });
    setSaving(false);
    setConfirmEmpty(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const next = res.data.eligible_ids;
    setSelected(new Set(next));
    onSaved(next);
    setNotice(`Saved. ${next.length} ${next.length === 1 ? 'drink' : 'drinks'} can be paid with a ${PASS_SHORT_NAME} cup.`);
  }

  const onSave = () => {
    if (saving) return;
    if (warning && !confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    void save();
  };

  return (
    <Section
      id="ritual-drinks"
      title="Eligible drinks"
      description="Tick the drinks a cup can pay for. Size and add-ons count towards the cup value; the customer pays anything above it."
      actions={
        <p aria-live="polite" className="text-sm font-semibold text-charcoal">
          <span className="font-mono tabular-nums">{count}</span> of <span className="font-mono tabular-nums">{menu.length}</span> selected
        </p>
      }
    >
      {menu.length === 0 ? (
        <EmptyState heading="No menu items yet" body="Add items to the menu first, then choose which ones a cup can pay for." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {quick.length > 0 ? (
              <>
                <span className="text-sm font-semibold text-charcoal">Quick pick</span>
                {quick.map((g) => {
                  const on = categorySelection(g, selected).state === 'all';
                  return (
                    <button
                      key={g.category}
                      type="button"
                      aria-pressed={on}
                      onClick={() => change(setCategorySelected(selected, g, !on))}
                      className={`min-h-[44px] rounded-full border px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ${
                        on ? 'border-charcoal bg-charcoal text-cream' : 'border-line bg-white text-charcoal hover:border-charcoal'
                      }`}
                    >
                      {g.category}
                    </button>
                  );
                })}
              </>
            ) : null}
            {count > 0 ? (
              <button
                type="button"
                onClick={() => change(new Set())}
                className="min-h-[44px] rounded-md px-3 text-sm font-semibold text-tan-dark hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
              >
                Clear all
              </button>
            ) : null}
          </div>

          <div className="flex flex-col gap-4">
            {groups.map((g) => {
              const sel = categorySelection(g, selected);
              return (
                <div key={g.category} role="group" aria-label={g.category} className="rounded-md border border-line">
                  <div className="flex items-center justify-between gap-3 border-b border-line bg-surface/60 px-3 py-1">
                    <h3 className="min-w-0 truncate text-sm font-bold text-charcoal">
                      {g.category}{' '}
                      <span className="font-mono text-xs font-normal tabular-nums text-muted">
                        {sel.selected} of {sel.total}
                      </span>
                    </h3>
                    <button
                      type="button"
                      onClick={() => change(setCategorySelected(selected, g, sel.state !== 'all'))}
                      className="min-h-[44px] shrink-0 rounded-md px-2 text-sm font-semibold text-tan-dark hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
                    >
                      {sel.state === 'all' ? `Clear ${g.category}` : `Select all ${g.category}`}
                    </button>
                  </div>
                  <ul className="grid gap-x-3 p-1 sm:grid-cols-2 lg:grid-cols-3">
                    {g.items.map((item) => {
                      const on = selected.has(item.id);
                      return (
                        <li key={item.id}>
                          <label
                            className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-surface ${
                              item.is_available ? 'text-charcoal' : 'text-muted'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => change(withSelection(selected, [item.id], !on))}
                              className="h-5 w-5 shrink-0 accent-tan-dark"
                            />
                            <span className="min-w-0 flex-1 text-sm">
                              {item.name}
                              {!item.is_available ? <span className="ml-2 text-xs italic">(unavailable)</span> : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </>
      )}

      {notice ? (
        <p role="status" className="mt-4 text-sm font-semibold text-green-700">
          {notice}
        </p>
      ) : null}

      {dirty ? (
        <div className="sticky bottom-0 z-20 -mx-5 -mb-5 mt-4 flex flex-col gap-2 rounded-b-md border-t border-line bg-cream px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {error ? <InlineError message={error} /> : null}
          {confirmEmpty && warning ? (
            <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {warning} Save anyway?
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">You have unsaved changes.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => change(new Set(saved))} disabled={saving}>
                Discard
              </Button>
              <Button onClick={onSave} loading={saving}>
                {confirmEmpty ? 'Save anyway' : 'Save drinks'}
              </Button>
            </div>
          </div>
        </div>
      ) : error ? (
        <div className="mt-4">
          <InlineError message={error} />
        </div>
      ) : null}
    </Section>
  );
}
