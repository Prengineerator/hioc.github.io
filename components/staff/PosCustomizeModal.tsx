'use client';

import { useMemo, useState } from 'react';
import {
  flattenAddons,
  initialSelection,
  invalidGroups,
  toggleOption,
} from '@/lib/menu/customization';
import { ItemCustomizer } from '@/components/menu/ItemCustomizer';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { CartItem } from '@/lib/cart/CartContext';
import type { MenuItem } from '@/lib/types';

// POS variant/addon picker. Deliberately a sibling of the customer
// MenuItemCustomizeModal so the two can't drift on the ONE thing that must stay
// identical — the variant + addon min/max selection rules (POS-1 AC: "same
// rules as web") — while adding to the POS-local cart via `onAdd` instead of the
// shared localStorage CartContext (a staff tablet must not collide with a
// customer's web cart). Both modals share lib/menu/customization.ts (the
// selection/prefill rules) and <ItemCustomizer> (the body markup), so this file
// only wires that shared body up to the POS cart and a slightly larger,
// tablet-friendly tap target (`size="touch"`). Line-price display mirrors the
// web modal; the authoritative bill still comes from POST /api/orders/quote.

export function PosCustomizeModal({
  item,
  onAdd,
  onClose,
  initialQty = 1,
}: {
  item: MenuItem;
  onAdd: (line: Omit<CartItem, 'qty' | 'key'>, qty: number) => void;
  onClose: () => void;
  // Seeds the qty stepper — lets the quick-add bar's "3*latte" carry its qty
  // into the customize modal for variant/addon items.
  initialQty?: number;
}) {
  const [variantId, setVariantId] = useState(item.variants[0]?.id ?? '');
  const [selected, setSelected] = useState<Record<string, string[]>>(() => initialSelection(item));
  const [qty, setQty] = useState(Math.max(1, initialQty));
  const [instructions, setInstructions] = useState('');

  const variant = item.variants.find((v) => v.id === variantId) ?? item.variants[0];

  const addonsFlat = useMemo(() => flattenAddons(item, selected), [item, selected]);
  const invalid = useMemo(() => invalidGroups(item, selected), [item, selected]);

  const unitPrice = (variant?.price_inr ?? 0) + addonsFlat.reduce((s, a) => s + a.priceInr, 0);
  const canSubmit = !!variant && invalid.length === 0;

  function handleAdd() {
    if (!variant || !canSubmit) return;
    onAdd(
      {
        menuItemId: item.id,
        variantId: variant.id,
        name: item.name,
        variantLabel: variant.label,
        unitPriceInr: unitPrice,
        gstExempt: item.gst_exempt === true,
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
          className="flex h-8 w-8 items-center justify-center rounded-full bg-charcoal text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
        >
          &minus;
        </button>
        <span className="min-w-[1.5rem] text-center font-bold text-charcoal">{qty}</span>
        <button
          type="button"
          aria-label="Increase quantity"
          onClick={() => setQty((q) => q + 1)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-tan text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
        >
          +
        </button>
      </div>
      <Button disabled={!canSubmit} onClick={handleAdd} className="flex-1">
        {canSubmit ? `Add to order · ₹${unitPrice * qty}` : 'Select required options'}
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
        size="touch"
      />
    </Modal>
  );
}
