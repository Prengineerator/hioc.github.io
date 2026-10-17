'use client';

import { useMemo, useState } from 'react';
import {
  flattenAddons,
  initialSelection,
  invalidGroups,
  toggleOption,
} from '@/lib/menu/customization';
import { basePriceInr, DEFAULT_WEIGHT_GRAMS, isSoldByWeight } from '@/lib/menu/weight';
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
  // Sold by weight (lib/menu/weight.ts): grams in one bag, as read off the
  // scale; null while the typed weight isn't valid. Same rules as the web modal.
  const byWeight = isSoldByWeight(item);
  const [weightGrams, setWeightGrams] = useState<number | null>(byWeight ? DEFAULT_WEIGHT_GRAMS : null);

  const variant = item.variants.find((v) => v.id === variantId) ?? item.variants[0];

  const addonsFlat = useMemo(() => flattenAddons(item, selected), [item, selected]);
  const invalid = useMemo(() => invalidGroups(item, selected), [item, selected]);

  const needsWeight = byWeight && weightGrams === null;
  const unitPrice =
    basePriceInr(variant?.price_inr ?? 0, byWeight ? weightGrams : null) +
    addonsFlat.reduce((s, a) => s + a.priceInr, 0);
  const canSubmit = !!variant && invalid.length === 0 && !needsWeight;

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
        ...(byWeight && weightGrams !== null ? { weightGrams } : {}),
      },
      qty,
    );
    onClose();
  }

  const footer = (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-3 rounded-md border border-line p-0.5">
        <button
          type="button"
          aria-label="Decrease quantity"
          onClick={() => setQty((q) => Math.max(1, q - 1))}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-charcoal text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
        >
          &minus;
        </button>
        <span className="min-w-[1.5rem] text-center font-mono font-bold tabular-nums text-charcoal">{qty}</span>
        <button
          type="button"
          aria-label="Increase quantity"
          onClick={() => setQty((q) => q + 1)}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-tan-dark text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
        >
          +
        </button>
      </div>
      <Button disabled={!canSubmit} onClick={handleAdd} className="flex-1">
        {canSubmit
          ? `Add to order · ₹${unitPrice * qty}`
          : needsWeight
            ? 'Enter a weight'
            : 'Select required options'}
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
        weightGrams={weightGrams}
        onWeightChange={byWeight ? setWeightGrams : undefined}
      />
    </Modal>
  );
}
