'use client';

// Recipes tab (docs/INVENTORY-SPEC.md, INV-5). What ONE of each menu item
// uses from stock — taken off automatically when an order completes. A size
// (variant) can have its own recipe, which replaces the base one for that
// size. Everyone can read recipes; editing follows the menu's own rule: the
// 'menu_edit' permission, on the POS.

import { useMemo, useState } from 'react';
import { formatQty, UNIT_LABELS, isInventoryUnit } from '@/lib/inventory/rules';
import { MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import { api, inputBase, inputClass, primaryButton, secondaryButton, type RecipesPayload } from '@/components/staff/inventory/client';

type Line = { key: string; itemId: string; qty: string };
const BASE = '*';

let keySeq = 0;
const nextKey = () => `l${++keySeq}`;

function unitLabel(unit: string): string {
  return isInventoryUnit(unit) ? UNIT_LABELS[unit] : unit;
}

export function RecipesTab({ data, reload }: { data: RecipesPayload; reload: () => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of data.lines) m.set(l.menuItemId, (m.get(l.menuItemId) ?? 0) + 1);
    return m;
  }, [data.lines]);
  const missing = data.menu.filter((m) => !counts.has(m.id)).length;

  const visible = data.menu.filter((m) => {
    const q = query.trim().toLowerCase();
    return !q || m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q);
  });
  const selected = data.menu.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div>
        {!data.canEdit ? <p className="mb-2 text-xs text-muted">{MENU_POS_ONLY_MESSAGE} Recipes are read-only here.</p> : null}
        <p className="mb-2 text-sm text-muted">
          {missing === 0 ? 'Every menu item has a recipe.' : `${missing} of ${data.menu.length} menu items have no recipe yet — they use no stock.`}
        </p>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search menu" className={inputClass} aria-label="Search menu" />
        <ul className="mt-2 max-h-[60vh] divide-y divide-[#eee] overflow-y-auto rounded-md border border-[#e5e5e5] bg-white">
          {visible.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setSelectedId(m.id)}
                className={`flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                  selectedId === m.id ? 'bg-[#f6efe9]' : ''
                }`}
              >
                <span>
                  <span className="font-semibold text-charcoal">{m.name}</span>
                  <span className="block text-xs text-muted">{m.category}</span>
                </span>
                {counts.has(m.id) ? (
                  <span className="text-xs text-green-800">{counts.get(m.id)} line(s)</span>
                ) : (
                  <span className="text-xs text-amber-800">No recipe</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div>
        {selected ? (
          <RecipeEditor key={selected.id} menuItem={selected} data={data} onSaved={reload} />
        ) : (
          <p className="rounded-md border border-dashed border-[#ddd] bg-white p-6 text-center text-sm text-muted">
            Pick a menu item to see or set what one of it uses.
          </p>
        )}
      </div>
    </div>
  );
}

function RecipeEditor({
  menuItem,
  data,
  onSaved,
}: {
  menuItem: RecipesPayload['menu'][number];
  data: RecipesPayload;
  onSaved: () => Promise<void>;
}) {
  const itemsById = useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data.items]);
  const [sections, setSections] = useState<Record<string, Line[]>>(() => {
    const init: Record<string, Line[]> = { [BASE]: [] };
    for (const l of data.lines.filter((x) => x.menuItemId === menuItem.id)) {
      const k = l.variantId ?? BASE;
      init[k] = [...(init[k] ?? []), { key: nextKey(), itemId: l.itemId, qty: String(l.qty) }];
    }
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const editable = data.canEdit;

  const update = (section: string, fn: (lines: Line[]) => Line[]) => {
    setNotice('');
    setSections((prev) => ({ ...prev, [section]: fn(prev[section] ?? []) }));
  };

  async function save() {
    setError('');
    setNotice('');
    const lines = Object.entries(sections).flatMap(([k, ls]) =>
      ls.filter((l) => l.itemId).map((l) => ({ variantId: k === BASE ? null : k, itemId: l.itemId, qty: Number(l.qty) })),
    );
    setBusy(true);
    const res = await api(`/api/inventory/recipes/${menuItem.id}`, 'PUT', { lines });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setNotice('Recipe saved.');
    await onSaved();
  }

  function section(key: string, title: string, hint: string) {
    const lines = sections[key];
    if (!lines) return null;
    return (
      <div className="mt-4 rounded-md border border-[#e5e5e5] bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-bold text-charcoal">{title}</p>
            <p className="text-xs text-muted">{hint}</p>
          </div>
          {editable && key !== BASE ? (
            <button
              type="button"
              className="text-xs font-semibold text-red-700 underline"
              onClick={() =>
                setSections((prev) => {
                  const next = { ...prev };
                  delete next[key];
                  return next;
                })
              }
            >
              Use the base recipe
            </button>
          ) : null}
        </div>
        <ul className="mt-2 space-y-2">
          {lines.map((l) => {
            const item = itemsById.get(l.itemId);
            return (
              <li key={l.key} className="flex items-center gap-2">
                {editable ? (
                  <>
                    <select
                      value={l.itemId}
                      onChange={(e) => update(key, (ls) => ls.map((x) => (x.key === l.key ? { ...x, itemId: e.target.value } : x)))}
                      className={`${inputBase} min-w-0 flex-1`}
                      aria-label="Ingredient"
                    >
                      <option value="">Choose ingredient…</option>
                      {data.items
                        .filter((i) => i.isActive || i.id === l.itemId)
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                    </select>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) => update(key, (ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))}
                      className={`${inputBase} w-24 text-right tabular-nums`}
                      aria-label="Quantity per serving"
                    />
                    <span className="w-10 text-sm text-muted">{item ? unitLabel(item.unit) : ''}</span>
                    <button
                      type="button"
                      aria-label="Remove ingredient"
                      className="min-h-[44px] px-2 text-lg text-muted hover:text-red-700"
                      onClick={() => update(key, (ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <span className="text-sm">
                    {item?.name ?? 'Unknown item'} — {item && isInventoryUnit(item.unit) ? formatQty(Number(l.qty), item.unit) : l.qty}
                  </span>
                )}
              </li>
            );
          })}
          {lines.length === 0 ? <li className="text-sm text-muted">No ingredients.</li> : null}
        </ul>
        {editable ? (
          <button
            type="button"
            className="mt-2 text-sm font-semibold text-charcoal underline"
            onClick={() => update(key, (ls) => [...ls, { key: nextKey(), itemId: '', qty: '' }])}
          >
            + Add ingredient
          </button>
        ) : null}
      </div>
    );
  }

  const sizesWithout = menuItem.variants.filter((v) => !sections[v.id]);

  return (
    <div>
      <h3 className="text-lg font-bold text-charcoal">{menuItem.name}</h3>
      <p className="text-sm text-muted">Quantities are for ONE serving, in each ingredient’s own unit.</p>
      {section(BASE, menuItem.variants.length ? 'Every size' : 'Recipe', menuItem.variants.length ? 'Used by any size without its own recipe.' : 'What one serving uses.')}
      {menuItem.variants.map((v) => section(v.id, `${v.label} only`, `Replaces the base recipe for ${v.label}.`))}
      {editable && sizesWithout.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {sizesWithout.map((v) => (
            <button
              key={v.id}
              type="button"
              className={secondaryButton}
              onClick={() => setSections((prev) => ({ ...prev, [v.id]: (prev[BASE] ?? []).map((l) => ({ ...l, key: nextKey() })) }))}
            >
              Own recipe for {v.label}
            </button>
          ))}
        </div>
      ) : null}
      {editable ? (
        <div className="mt-4 flex items-center gap-3">
          <button type="button" className={primaryButton} onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save recipe'}
          </button>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
          {notice ? <p className="text-sm text-green-700">{notice}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
