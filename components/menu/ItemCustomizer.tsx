'use client';

import { useId, useState } from 'react';
import {
  compactHint,
  isRequired,
  MAX_INSTRUCTIONS_LEN,
  selectionLabel,
} from '@/lib/menu/customization';
import type { AddonGroup, MenuItem } from '@/lib/types';

/**
 * Shared modal body for the customer MenuItemCustomizeModal and the staff
 * PosCustomizeModal — size picker, addon groups (split into a "Required"
 * section and an "Add-ons (optional)" section) and the special-instructions
 * field. Pure presentation: all selection state and rules live in the caller
 * (backed by lib/menu/customization.ts) so both modals stay byte-for-byte
 * aligned on what's required and what a tap does.
 */
export function ItemCustomizer({
  item,
  variantId,
  onVariantChange,
  selection,
  onToggle,
  instructions,
  onInstructionsChange,
  size = 'default',
}: {
  item: MenuItem;
  variantId: string;
  onVariantChange: (id: string) => void;
  selection: Record<string, string[]>;
  onToggle: (group: AddonGroup, optionId: string) => void;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  /** 'touch' gives POS tablets slightly larger tap targets. */
  size?: 'default' | 'touch';
}) {
  const requiredGroups = item.addon_groups.filter(isRequired);
  const optionalGroups = item.addon_groups.filter((g) => !isRequired(g));
  const showSize = item.variants.length > 1;

  const hasRequiredSection = showSize || requiredGroups.length > 0;
  const hasOptionalSection = optionalGroups.length > 0;

  return (
    <div className="divide-y divide-line">
      {hasRequiredSection ? (
        <section className="py-2 first:pt-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Required</h3>
          <div className="space-y-3">
            {showSize ? (
              <SizePicker item={item} variantId={variantId} onVariantChange={onVariantChange} size={size} />
            ) : null}
            {requiredGroups.map((group) => (
              <AddonGroupBlock
                key={group.id}
                group={group}
                selectedIds={selection[group.id] ?? []}
                onToggle={onToggle}
                size={size}
              />
            ))}
          </div>
        </section>
      ) : null}

      {hasOptionalSection ? (
        <section className="py-2 first:pt-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Add-ons (optional)</h3>
          <div className="space-y-3">
            {optionalGroups.map((group) => (
              <AddonGroupBlock
                key={group.id}
                group={group}
                selectedIds={selection[group.id] ?? []}
                onToggle={onToggle}
                size={size}
              />
            ))}
          </div>
        </section>
      ) : null}

      <div className="py-2 first:pt-0">
        <InstructionsField value={instructions} onChange={onInstructionsChange} />
      </div>
    </div>
  );
}

function SizePicker({
  item,
  variantId,
  onVariantChange,
  size,
}: {
  item: MenuItem;
  variantId: string;
  onVariantChange: (id: string) => void;
  size: 'default' | 'touch';
}) {
  const labelId = useId();
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span id={labelId} className="truncate text-sm font-semibold text-charcoal">
          Size
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={labelId}>
        {item.variants.map((v) => {
          const selected = v.id === variantId;
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onVariantChange(v.id)}
              className={chipClasses(selected, size)}
            >
              {v.label} · <span className="font-mono tabular-nums">₹{v.price_inr}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AddonGroupBlock({
  group,
  selectedIds,
  onToggle,
  size,
}: {
  group: AddonGroup;
  selectedIds: string[];
  onToggle: (group: AddonGroup, optionId: string) => void;
  size: 'default' | 'touch';
}) {
  const labelId = useId();
  const required = isRequired(group);
  const count = selectedIds.length;

  let badge: string;
  let badgeClass: string;
  if (group.selection_type === 'multi' && count > 0) {
    badge = `${count}/${group.max_select}`;
    badgeClass = 'bg-surface text-tan';
  } else if (required) {
    badge = 'Required';
    badgeClass = 'bg-surface text-tan';
  } else {
    badge = compactHint(group);
    badgeClass = 'text-muted';
  }

  return (
    <div role="group" aria-labelledby={labelId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span id={labelId} className="truncate text-sm font-semibold text-charcoal" title={group.display_name}>
          {group.display_name}
        </span>
        <span
          className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${badgeClass}`}
          aria-label={selectionLabel(group)}
        >
          {badge}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {group.options.map((option) => {
          const selected = selectedIds.includes(option.id);
          const atMax = group.selection_type === 'multi' && !selected && count >= group.max_select;
          return (
            <button
              key={option.id}
              type="button"
              disabled={atMax}
              aria-pressed={selected}
              onClick={() => onToggle(group, option.id)}
              className={chipClasses(selected, size, atMax)}
            >
              {group.selection_type === 'multi' && selected ? <span aria-hidden="true">✓ </span> : null}
              {option.name}
              {option.price_inr > 0 ? (
                <span className={'ml-1 font-mono tabular-nums ' + (selected ? 'text-cream/80' : 'text-muted')}>
                  +₹{option.price_inr}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function chipClasses(selected: boolean, size: 'default' | 'touch', disabled = false): string {
  const sizeClasses = size === 'touch' ? 'min-h-[40px] px-3.5 py-2' : 'min-h-[36px] px-3 py-1.5';
  return [
    'inline-flex items-center rounded-full text-sm font-medium transition-colors',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan',
    disabled ? 'cursor-not-allowed opacity-40' : '',
    sizeClasses,
    selected ? 'border border-tan bg-tan text-cream' : 'border border-line text-charcoal hover:border-tan hover:text-tan',
  ]
    .filter(Boolean)
    .join(' ');
}

function InstructionsField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [revealed, setRevealed] = useState(value.trim().length > 0);
  const inputId = useId();

  if (!revealed) {
    return (
      <button
        type="button"
        onClick={() => setRevealed(true)}
        className="text-sm font-semibold text-tan hover:text-tan-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
      >
        + Add note
      </button>
    );
  }

  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
        Note
      </label>
      <input
        id={inputId}
        type="text"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, MAX_INSTRUCTIONS_LEN))}
        maxLength={MAX_INSTRUCTIONS_LEN}
        placeholder="e.g. less sugar, no ice"
        aria-label="Special instructions for this item"
        className="w-full rounded-md border border-line px-3 py-2 text-sm text-charcoal outline-none focus:border-tan"
      />
    </div>
  );
}
