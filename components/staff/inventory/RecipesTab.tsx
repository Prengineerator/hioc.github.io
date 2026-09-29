'use client';

// Recipes tab (docs/INVENTORY-SPEC.md, INV-5). What ONE of each menu item —
// and each add-on — uses from stock; taken off automatically when an order
// completes. A size can have its own recipe, which replaces the base one for
// that size (sizes go by label: saving a menu item re-creates its size rows).
// Everyone can read recipes; editing follows the menu's own rule: the
// 'menu_edit' permission, on the POS.

import { useMemo, useState } from 'react';
import { formatQty, UNIT_LABELS, isInventoryUnit } from '@/lib/inventory/rules';
import { MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import { api, inputBase, inputClass, primaryButton, secondaryButton, type RecipesPayload } from '@/components/staff/inventory/client';

type Line = { key: string; itemId: string; qty: string };
type Mode = 'menu' | 'addons';
const BASE = '';

let keySeq = 0;
const nextKey = () => `l${++keySeq}`;

function unitLabel(unit: string): string {
  return isInventoryUnit(unit) ? UNIT_LABELS[unit] : unit;
}

export function RecipesTab({ data, reload }: { data: RecipesPayload; reload: () => Promise<void> }) {
  const [mode, setMode] = useState<Mode>('menu');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of data.lines) m.set(l.menuItemId, (m.get(l.menuItemId) ?? 0) + 1);
    for (const l of data.addonLines) m.set(l.optionId, (m.get(l.optionId) ?? 0) + 1);
    return m;
  }, [data.lines, data.addonLines]);

  const entries =
    mode === 'menu'
      ? data.menu.map((m) => ({ id: m.id, name: m.name, sub: m.category }))
      : data.addons.map((a) => ({ id: a.id, name: a.name, sub: a.group }));
  const missing = entries.filter((e) => !counts.has(e.id)).length;
  const q = query.trim().toLowerCase();
  const visible = entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.sub.toLowerCase().includes(q));

  const menuItem = mode === 'menu' ? data.menu.find((m) => m.id === selectedId) ?? null : null;
  const addon = mode === 'addons' ? data.addons.find((a) => a.id === selectedId) ?? null : null;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div>
        {!data.canEdit ? <p className="mb-2 text-xs text-muted">{MENU_POS_ONLY_MESSAGE} Recipes are read-only here.</p> : null}
        <div className="mb-2 flex gap-2">
          {(['menu', 'addons'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setSelectedId(null);
              }}
              className={`min-h-[44px] rounded-full border px-4 text-sm font-semibold ${
                mode === m ? 'border-charcoal bg-charcoal text-cream' : 'border-[#ddd] bg-white text-charcoal'
              }`}
            >
              {m === 'menu' ? 'Menu items' : 'Add-ons'}
            </button>
          ))}
        </div>
        <p className="mb-2 text-sm text-muted">
          {missing === 0
            ? `Every ${mode === 'menu' ? 'menu item' : 'add-on'} has a recipe.`
            : `${missing} of ${entries.length} ${mode === 'menu' ? 'menu items' : 'add-ons'} have no recipe yet — they use no stock.`}
        </p>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className={inputClass} aria-label="Search recipes" />
        <ul className="mt-2 max-h-[60vh] divide-y divide-[#eee] overflow-y-auto rounded-md border border-[#e5e5e5] bg-white">
          {visible.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => setSelectedId(e.id)}
                className={`flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                  selectedId === e.id ? 'bg-[#f6efe9]' : ''
                }`}
              >
                <span>
                  <span className="font-semibold text-charcoal">{e.name}</span>
                  <span className="block text-xs text-muted">{e.sub}</span>
                </span>
                {counts.has(e.id) ? (
                  <span className="text-xs text-green-800">{counts.get(e.id)} line(s)</span>
                ) : (
                  <span className="text-xs text-amber-800">No recipe</span>
                )}
              </button>
            </li>
          ))}
          {visible.length === 0 ? <li className="px-3 py-4 text-center text-sm text-muted">Nothing matches.</li> : null}
        </ul>
      </div>

      <div>
        {menuItem ? (
          <RecipeEditor
            key={menuItem.id}
            title={menuItem.name}
            sizes={menuItem.variants.map((v) => v.label).filter((l) => l !== '')}
            initial={data.lines.filter((l) => l.menuItemId === menuItem.id).map((l) => ({ section: l.sizeLabel, itemId: l.itemId, qty: l.qty }))}
            url={`/api/inventory/recipes/${menuItem.id}`}
            toBody={(sections) =>
              Object.entries(sections).flatMap(([size, ls]) =>
                ls.filter((l) => l.itemId).map((l) => ({ sizeLabel: size, itemId: l.itemId, qty: Number(l.qty) })),
              )
            }
            data={data}
            onSaved={reload}
          />
        ) : addon ? (
          <RecipeEditor
            key={addon.id}
            title={`${addon.name} (${addon.group})`}
            sizes={[]}
            hint="Per serving it is added to — ordered twice, it is used twice."
            initial={data.addonLines.filter((l) => l.optionId === addon.id).map((l) => ({ section: BASE, itemId: l.itemId, qty: l.qty }))}
            url={`/api/inventory/addon-recipes/${addon.id}`}
            toBody={(sections) => (sections[BASE] ?? []).filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: Number(l.qty) }))}
            data={data}
            onSaved={reload}
          />
        ) : (
          <p className="rounded-md border border-dashed border-[#ddd] bg-white p-6 text-center text-sm text-muted">
            Pick {mode === 'menu' ? 'a menu item' : 'an add-on'} to see or set what one of it uses.
          </p>
        )}
      </div>
    </div>
  );
}

function RecipeEditor({
  title,
  sizes,
  hint,
  initial,
  url,
  toBody,
  data,
  onSaved,
}: {
  title: string;
  /** Size labels this item has; empty for an add-on or a one-size item. */
  sizes: string[];
  hint?: string;
  initial: { section: string; itemId: string; qty: number }[];
  url: string;
  toBody: (sections: Record<string, Line[]>) => unknown[];
  data: RecipesPayload;
  onSaved: () => Promise<void>;
}) {
  const itemsById = useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data.items]);
  // A single size gets no "own recipe" option: the base recipe already is it.
  const splitSizes = sizes.length > 1 ? sizes : [];
  const [sections, setSections] = useState<Record<string, Line[]>>(() => {
    const init: Record<string, Line[]> = { [BASE]: [] };
    for (const l of initial) {
      // A size renamed or removed on the menu since: its old recipe no longer
      // applies (orders fall back to the base), and saving drops it.
      if (l.section !== BASE && !splitSizes.includes(l.section)) continue;
      init[l.section] = [...(init[l.section] ?? []), { key: nextKey(), itemId: l.itemId, qty: String(l.qty) }];
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
    setBusy(true);
    const res = await api(url, 'PUT', { lines: toBody(sections) });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setNotice('Recipe saved.');
    await onSaved();
  }

  function section(key: string, heading: string, sub: string) {
    const lines = sections[key];
    if (!lines) return null;
    return (
      <div key={key || 'base'} className="mt-4 rounded-md border border-[#e5e5e5] bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-bold text-charcoal">{heading}</p>
            <p className="text-xs text-muted">{sub}</p>
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

  const sizesWithout = splitSizes.filter((s) => !sections[s]);

  return (
    <div>
      <h3 className="text-lg font-bold text-charcoal">{title}</h3>
      <p className="text-sm text-muted">{hint ?? 'Quantities are for ONE serving, in each ingredient’s own unit.'}</p>
      {section(BASE, splitSizes.length ? 'Every size' : 'Recipe', splitSizes.length ? 'Used by any size without its own recipe.' : 'What one serving uses.')}
      {splitSizes.map((s) => section(s, `${s} only`, `Replaces the base recipe for ${s}.`))}
      {editable && sizesWithout.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {sizesWithout.map((s) => (
            <button
              key={s}
              type="button"
              className={secondaryButton}
              onClick={() => setSections((prev) => ({ ...prev, [s]: (prev[BASE] ?? []).map((l) => ({ ...l, key: nextKey() })) }))}
            >
              Own recipe for {s}
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
