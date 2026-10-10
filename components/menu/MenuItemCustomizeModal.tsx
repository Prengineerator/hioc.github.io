'use client';

import { useMemo, useState } from 'react';
import { useCart } from '@/lib/cart/CartContext';
import {
  flattenAddons,
  initialSelection,
  invalidGroups,
  suggestedOptionIds,
  toggleOption,
} from '@/lib/menu/customization';
import { ItemCustomizer } from '@/components/menu/ItemCustomizer';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { MenuItem } from '@/lib/types';

export function MenuItemCustomizeModal({
  item,
  onClose,
  initialSelection: presets,
  suggestedOptions,
  hint,
}: {
  item: MenuItem;
  onClose: () => void;
  /** Options to open with already chosen (group id → option ids), e.g. the
   * sugar level Coffey picked on /suggest. Vetted by lib/menu/customization
   * initialSelection(): anything invalid for its group falls back to the
   * usual default. Read once, on open. */
  initialSelection?: Record<string, string[]>;
  /** Options to HIGHLIGHT with a "Coffey's pick" pill, never to preselect
   * (group id → option ids): the flavour add-on Coffey suggests on /suggest
   * (COFFEY-ADDONS-PAIRINGS-SPEC §1.1). Unlike `initialSelection` it changes
   * nothing about what is chosen, so it can't quietly add to the bill. Vetted by
   * lib/menu/customization suggestedOptionIds(): an unknown group or option, or
   * one that is switched off, is ignored. */
  suggestedOptions?: Record<string, string[]>;
  /** A short line shown above the options, e.g. "Coffey set sugar to “No
   * Sugar” for you — change it anytime." A list stacks several lines, one
   * paragraph each. */
  hint?: string | string[];
}) {
  const { addItem } = useCart();
  const [variantId, setVariantId] = useState(item.variants[0]?.id ?? '');
  const [selected, setSelected] = useState<Record<string, string[]>>(() => initialSelection(item, presets));
  const [qty, setQty] = useState(1);
  const [instructions, setInstructions] = useState('');

  const variant = item.variants.find((v) => v.id === variantId) ?? item.variants[0];

  const hints = typeof hint === 'string' ? (hint ? [hint] : []) : (hint ?? []);

  const suggestedIds = useMemo(() => suggestedOptionIds(item, suggestedOptions), [item, suggestedOptions]);

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
          className="flex h-6 w-6 items-center justify-center rounded-full bg-charcoal text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
        >
          &minus;
        </button>
        <span className="min-w-[1.5rem] text-center font-mono font-semibold tabular-nums text-charcoal">{qty}</span>
        <button
          type="button"
          aria-label="Increase quantity"
          onClick={() => setQty((q) => q + 1)}
          className="flex h-6 w-6 items-center justify-center rounded-full bg-tan-dark text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
        >
          +
        </button>
      </div>
      <Button disabled={!canSubmit} onClick={handleAdd} className="flex-1">
        {canSubmit ? (
          <>
            Add to Cart · <span className="font-mono tabular-nums">₹{unitPrice * qty}</span>
          </>
        ) : (
          'Select required options'
        )}
      </Button>
    </div>
  );

  return (
    <Modal open onClose={onClose} title={item.name} subtitle={item.description || undefined} footer={footer} dense>
      {hints.length > 0 ? (
        <div role="status" className="mb-3 space-y-1 text-sm text-muted">
          {hints.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
      <ItemCustomizer
        item={item}
        variantId={variantId}
        onVariantChange={setVariantId}
        selection={selected}
        onToggle={(group, optionId) => setSelected((prev) => toggleOption(prev, group, optionId))}
        instructions={instructions}
        onInstructionsChange={setInstructions}
        suggestedOptionIds={suggestedIds}
      />
    </Modal>
  );
}
