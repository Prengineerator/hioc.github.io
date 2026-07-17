'use client';

import { useMemo, useState } from 'react';
import { useCart, type CartAddonSelection } from '@/lib/cart/CartContext';
import type { AddonGroup, MenuItem } from '@/lib/types';

function selectionLabel(group: AddonGroup): string {
  if (group.min_select === group.max_select) {
    return `Choose exactly ${group.min_select}`;
  }
  if (group.min_select === 0) {
    return `Choose up to ${group.max_select}`;
  }
  return `Choose ${group.min_select}–${group.max_select}`;
}

export function MenuItemCustomizeModal({
  item,
  onClose,
}: {
  item: MenuItem;
  onClose: () => void;
}) {
  const { addItem } = useCart();
  const [variantId, setVariantId] = useState(item.variants[0]?.id ?? '');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);

  const variant = item.variants.find((v) => v.id === variantId) ?? item.variants[0];

  function toggleOption(group: AddonGroup, optionId: string) {
    setSelected((prev) => {
      const current = prev[group.id] ?? [];
      if (group.selection_type === 'single') {
        const next = current[0] === optionId && group.min_select === 0 ? [] : [optionId];
        return { ...prev, [group.id]: next };
      }
      const isSelected = current.includes(optionId);
      if (isSelected) {
        return { ...prev, [group.id]: current.filter((id) => id !== optionId) };
      }
      if (current.length >= group.max_select) {
        return prev;
      }
      return { ...prev, [group.id]: [...current, optionId] };
    });
  }

  const addonsFlat: CartAddonSelection[] = useMemo(() => {
    const flat: CartAddonSelection[] = [];
    for (const group of item.addon_groups) {
      const ids = selected[group.id] ?? [];
      for (const id of ids) {
        const option = group.options.find((o) => o.id === id);
        if (option) {
          flat.push({
            optionId: option.id,
            groupName: group.display_name,
            optionName: option.name,
            priceInr: option.price_inr,
          });
        }
      }
    }
    return flat;
  }, [selected, item.addon_groups]);

  const invalidGroups = item.addon_groups.filter((group) => {
    const count = (selected[group.id] ?? []).length;
    return count < group.min_select || count > group.max_select;
  });

  const unitPrice = (variant?.price_inr ?? 0) + addonsFlat.reduce((s, a) => s + a.priceInr, 0);
  const canSubmit = !!variant && invalidGroups.length === 0;

  function handleAdd() {
    if (!variant || !canSubmit) return;
    addItem(
      {
        menuItemId: item.id,
        variantId: variant.id,
        name: item.name,
        variantLabel: variant.label,
        unitPriceInr: unitPrice,
        addons: addonsFlat,
      },
      qty,
    );
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-4 py-8">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 bg-charcoal/50"
      />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-md bg-cream shadow-sm">
        <div className="flex items-start justify-between gap-3 border-b border-[#e5e5e5] px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-charcoal">{item.name}</h2>
            {item.description ? (
              <p className="mt-1 text-sm text-muted">{item.description}</p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 text-2xl leading-none text-charcoal hover:text-tan"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {item.variants.length > 1 ? (
            <div className="mb-6">
              <h3 className="mb-2 text-sm font-bold text-charcoal">Size</h3>
              <div className="flex flex-wrap gap-2">
                {item.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setVariantId(v.id)}
                    className={
                      'rounded-full px-4 py-2 text-sm font-bold transition-colors ' +
                      (v.id === variantId
                        ? 'bg-tan text-cream'
                        : 'border border-[#e5e5e5] text-charcoal hover:border-tan hover:text-tan')
                    }
                  >
                    {v.label} · ₹{v.price_inr}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {item.addon_groups.map((group) => (
            <div key={group.id} className="mb-6">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-sm font-bold text-charcoal">{group.display_name}</h3>
                <span className="text-xs text-muted">{selectionLabel(group)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {group.options.map((option) => {
                  const isSelected = (selected[group.id] ?? []).includes(option.id);
                  const atMax =
                    group.selection_type === 'multi' &&
                    !isSelected &&
                    (selected[group.id]?.length ?? 0) >= group.max_select;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={atMax}
                      onClick={() => toggleOption(group, option.id)}
                      className={
                        'rounded-full px-4 py-2 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' +
                        (isSelected
                          ? 'bg-tan text-cream'
                          : 'border border-[#e5e5e5] text-charcoal hover:border-tan hover:text-tan')
                      }
                    >
                      {option.name}
                      {option.price_inr > 0 ? ` · +₹${option.price_inr}` : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-[#e5e5e5] px-6 py-4">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-4 rounded-md border border-[#e5e5e5] px-3 py-1">
              <button
                type="button"
                aria-label="Decrease quantity"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-charcoal text-cream"
              >
                &minus;
              </button>
              <span className="min-w-[1.5rem] text-center font-bold text-charcoal">{qty}</span>
              <button
                type="button"
                aria-label="Increase quantity"
                onClick={() => setQty((q) => q + 1)}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-tan text-cream"
              >
                +
              </button>
            </div>
            <span className="text-lg font-bold text-tan">₹{unitPrice * qty}</span>
          </div>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleAdd}
            className="w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {canSubmit ? 'Add to Cart' : 'Select required options'}
          </button>
        </div>
      </div>
    </div>
  );
}
