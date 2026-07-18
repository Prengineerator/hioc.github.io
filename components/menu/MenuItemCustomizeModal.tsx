'use client';

import { useMemo, useState } from 'react';
import { useCart, type CartAddonSelection } from '@/lib/cart/CartContext';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { AddonGroup, MenuItem } from '@/lib/types';

const MAX_INSTRUCTIONS_LEN = 200; // mirrors app/api/orders/route.ts MAX_INSTRUCTION_LENGTH

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
  const [instructions, setInstructions] = useState('');

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
        specialInstructions: instructions.trim(),
      },
      qty,
    );
    onClose();
  }

  const footer = (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-4 rounded-md border border-line px-3 py-1">
          <button
            type="button"
            aria-label="Decrease quantity"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-charcoal text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
          >
            &minus;
          </button>
          <span className="min-w-[1.5rem] text-center font-bold text-charcoal">{qty}</span>
          <button
            type="button"
            aria-label="Increase quantity"
            onClick={() => setQty((q) => q + 1)}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-tan text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
          >
            +
          </button>
        </div>
        <span className="text-lg font-bold text-tan">₹{unitPrice * qty}</span>
      </div>
      <Button disabled={!canSubmit} onClick={handleAdd} fullWidth>
        {canSubmit ? 'Add to Cart' : 'Select required options'}
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title={item.name} footer={footer}>
      {item.description ? <p className="mb-4 text-sm text-muted">{item.description}</p> : null}
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
                    : 'border border-line text-charcoal hover:border-tan hover:text-tan')
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
                      : 'border border-line text-charcoal hover:border-tan hover:text-tan')
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

      <div className="mb-2">
        <h3 className="mb-2 text-sm font-bold text-charcoal">Special instructions (optional)</h3>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value.slice(0, MAX_INSTRUCTIONS_LEN))}
          maxLength={MAX_INSTRUCTIONS_LEN}
          rows={2}
          placeholder="e.g. less sugar, no ice"
          aria-label="Special instructions for this item"
          className="w-full rounded-md border border-line px-3 py-2 text-sm text-charcoal outline-none focus:border-tan"
        />
      </div>
    </Modal>
  );
}
