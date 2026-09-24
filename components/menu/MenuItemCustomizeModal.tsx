'use client';

import { useMemo, useState } from 'react';
import { useCart } from '@/lib/cart/CartContext';
import {
  flattenAddons,
  initialSelection,
  invalidGroups,
  toggleOption,
} from '@/lib/menu/customization';
import { ItemCustomizer } from '@/components/menu/ItemCustomizer';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { MenuItem } from '@/lib/types';

export function MenuItemCustomizeModal({
  item,
  onClose,
}: {
  item: MenuItem;
  onClose: () => void;
}) {
  const { addItem } = useCart();
  const [variantId, setVariantId] = useState(item.variants[0]?.id ?? '');
  const [selected, setSelected] = useState<Record<string, string[]>>(() => initialSelection(item));
  const [qty, setQty] = useState(1);
  const [instructions, setInstructions] = useState('');

  const variant = item.variants.find((v) => v.id === variantId) ?? item.variants[0];

  const addonsFlat = useMemo(() => flattenAddons(item, selected), [item, selected]);
  const invalid = useMemo(() => invalidGroups(item, selected), [item, selected]);

  const unitPrice = (variant?.price_inr ?? 0) + addonsFlat.reduce((s, a) => s + a.priceInr, 0);
  const canSubmit = !!variant && invalid.length === 0;

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
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-3 rounded-md border border-line px-3 py-1">
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
      <Button disabled={!canSubmit} onClick={handleAdd} className="flex-1">
        {canSubmit ? `Add to Cart · ₹${unitPrice * qty}` : 'Select required options'}
      </Button>
    </div>
  );

  return (
    <Modal open onClose={onClose} title={item.name} subtitle={item.description || undefined} footer={footer} dense>
      <ItemCustomizer
        item={item}
        variantId={variantId}
        onVariantChange={setVariantId}
        selection={selected}
        onToggle={(group, optionId) => setSelected((prev) => toggleOption(prev, group, optionId))}
        instructions={instructions}
        onInstructionsChange={setInstructions}
      />
    </Modal>
  );
}
