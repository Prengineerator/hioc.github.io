'use client';

// POS → Menu → On/off — switch whole categories, sizes (e.g. Extra Large) and
// single add-on options (e.g. oat milk) off for now, and back on, without
// deleting anything (lib/menu/menuSwitches.ts, 2026-09-menu-switches.sql).
//
// Each switch saves at once. Categories and sizes are store settings a manager
// or the owner changes; add-ons follow the same permission as marking an item
// sold out. The server enforces both — a refused switch flips back and says why.

import { useEffect, useMemo, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { MENU_CATEGORIES } from '@/lib/constants';
import { isHiddenSize, sizeLabels } from '@/lib/menu/menuSwitches';
import type { AddonGroup, MenuItem, StoreSettings } from '@/lib/types';

const CARD = 'rounded-md border border-[#e5e5e5] bg-white p-4';

export function MenuSwitchesPanel({ items, canEdit }: { items: MenuItem[]; canEdit: boolean }) {
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [groups, setGroups] = useState<AddonGroup[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/store-settings', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch('/api/addon-groups', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject())),
    ])
      .then(([s, g]: [{ settings: StoreSettings }, { addonGroups: AddonGroup[] }]) => {
        if (cancelled) return;
        setSettings(s.settings);
        setGroups(g.addonGroups);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.category, (m.get(i.category) ?? 0) + 1);
    return m;
  }, [items]);
  const sizes = useMemo(() => sizeLabels(items), [items]);
  // Add-on groups some item actually uses, most-used first.
  const usedGroups = useMemo(() => {
    const uses = new Map<string, number>();
    for (const i of items) for (const g of i.addon_groups) uses.set(g.id, (uses.get(g.id) ?? 0) + 1);
    return (groups ?? [])
      .filter((g) => (uses.get(g.id) ?? 0) > 0)
      .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0));
  }, [groups, items]);

  const hiddenCategories = settings?.hidden_categories ?? [];
  const hiddenSizes = settings?.hidden_variant_labels ?? [];

  async function patchSettings(key: string, patch: Partial<StoreSettings>, done: string) {
    setBusyKey(key);
    setMessage(null);
    try {
      const res = await fetch('/api/store-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => null)) as { settings?: StoreSettings; error?: string } | null;
      if (!res.ok || !data?.settings) {
        setMessage({ kind: 'error', text: data?.error ?? 'Could not save. Try again.' });
        return;
      }
      setSettings(data.settings);
      setMessage({ kind: 'ok', text: done });
    } catch {
      setMessage({ kind: 'error', text: 'Could not save. Check the connection and try again.' });
    } finally {
      setBusyKey(null);
    }
  }

  function toggleCategory(slug: string, label: string, on: boolean) {
    if (busyKey) return; // one save at a time — each builds on the last
    const next = on ? hiddenCategories.filter((c) => c !== slug) : [...hiddenCategories, slug];
    void patchSettings(`cat:${slug}`, { hidden_categories: next }, `${label} is ${on ? 'on' : 'off'}.`);
  }

  function toggleSize(label: string, on: boolean) {
    if (busyKey) return;
    const next = on
      ? hiddenSizes.filter((s) => !isHiddenSize(s, [label]))
      : [...hiddenSizes.filter((s) => !isHiddenSize(s, [label])), label];
    void patchSettings(`size:${label}`, { hidden_variant_labels: next }, `${label} is ${on ? 'on' : 'off'}.`);
  }

  async function toggleOption(groupId: string, optionId: string, name: string, on: boolean) {
    if (busyKey) return;
    const key = `opt:${optionId}`;
    setBusyKey(key);
    setMessage(null);
    const apply = (value: boolean) =>
      setGroups((prev) =>
        (prev ?? []).map((g) =>
          g.id !== groupId
            ? g
            : { ...g, options: g.options.map((o) => (o.id === optionId ? { ...o, is_available: value } : o)) },
        ),
      );
    apply(on);
    try {
      const res = await fetch(`/api/addon-options/${optionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: on }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        apply(!on);
        setMessage({ kind: 'error', text: data?.error ?? 'Could not save. Try again.' });
        return;
      }
      setMessage({ kind: 'ok', text: `${name} is ${on ? 'on' : 'off'}.` });
    } catch {
      apply(!on);
      setMessage({ kind: 'error', text: 'Could not save. Check the connection and try again.' });
    } finally {
      setBusyKey(null);
    }
  }

  if (loadError) {
    return <p className={`${CARD} text-sm text-red-700`}>Could not load the menu switches. Reload to try again.</p>;
  }
  if (!settings || !groups) return <Spinner label="Loading switches…" />;

  const offCount =
    hiddenCategories.length +
    hiddenSizes.length +
    usedGroups.reduce((n, g) => n + g.options.filter((o) => o.is_available === false).length, 0);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Switch parts of the menu off for now — they disappear from the customer menu, table QR and POS, and
        can&apos;t be ordered. Switch them back on any time; nothing is deleted.
        {offCount > 0 ? <span className="font-bold text-charcoal"> {offCount} switched off.</span> : null}
      </p>
      {message ? (
        <p role="status" className={`text-sm ${message.kind === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
          {message.text}
        </p>
      ) : null}

      <section className={CARD} aria-labelledby="switch-categories">
        <h2 id="switch-categories" className="font-bold text-charcoal">
          Categories
        </h2>
        <p className="text-xs text-muted">Manager or owner.</p>
        <ul className="mt-2 divide-y divide-line">
          {MENU_CATEGORIES.filter((c) => (categoryCounts.get(c.slug) ?? 0) > 0).map((c) => {
            const on = !hiddenCategories.includes(c.slug);
            return (
              <SwitchRow
                key={c.slug}
                label={c.label}
                detail={`${categoryCounts.get(c.slug)} items`}
                on={on}
                disabled={!canEdit}
                onChange={(next) => toggleCategory(c.slug, c.label, next)}
              />
            );
          })}
        </ul>
      </section>

      <section className={CARD} aria-labelledby="switch-sizes">
        <h2 id="switch-sizes" className="font-bold text-charcoal">
          Sizes
        </h2>
        <p className="text-xs text-muted">
          Manager or owner. A size that is an item&apos;s only size stays available on that item.
        </p>
        <ul className="mt-2 divide-y divide-line">
          {sizes.map((s) => (
            <SwitchRow
              key={s.label}
              label={s.label}
              detail={`${s.count} items`}
              on={!isHiddenSize(s.label, hiddenSizes)}
              disabled={!canEdit}
              onChange={(next) => toggleSize(s.label, next)}
            />
          ))}
        </ul>
      </section>

      <section className={CARD} aria-labelledby="switch-addons">
        <h2 id="switch-addons" className="font-bold text-charcoal">
          Add-ons
        </h2>
        <p className="text-xs text-muted">
          E.g. out of oat milk. If every option in a group is off, the group isn&apos;t shown.
        </p>
        <div className="mt-2 flex flex-col gap-4">
          {usedGroups.map((g) => (
            <div key={g.id}>
              <p className="text-sm font-bold text-charcoal">
                {g.display_name}
                {g.display_name !== g.name ? <span className="font-normal text-muted"> · {g.name}</span> : null}
              </p>
              <ul className="divide-y divide-line">
                {g.options.map((o) => (
                  <SwitchRow
                    key={o.id}
                    label={o.name}
                    detail={o.price_inr > 0 ? `₹${o.price_inr}` : 'Free'}
                    on={o.is_available !== false}
                    disabled={!canEdit}
                    onChange={(next) => void toggleOption(g.id, o.id, o.name, next)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SwitchRow({
  label,
  detail,
  on,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <span className="min-w-0">
        <span className={`text-sm font-bold ${on ? 'text-charcoal' : 'text-muted line-through'}`}>{label}</span>
        <span className="ml-2 text-xs text-muted">{detail}</span>
      </span>
      {disabled ? (
        <span className={`text-xs font-bold ${on ? 'text-green-700' : 'text-red-700'}`}>{on ? 'On' : 'Off'}</span>
      ) : (
        <ToggleSwitch checked={on} onChange={onChange} label={`${label} ${on ? 'on' : 'off'}`} />
      )}
    </li>
  );
}
