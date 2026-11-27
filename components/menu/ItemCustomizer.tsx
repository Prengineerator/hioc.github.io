'use client';

import { useId, useState } from 'react';
import {
  coffeyStripEntries,
  compactHint,
  isRequired,
  MAX_INSTRUCTIONS_LEN,
  selectionLabel,
} from '@/lib/menu/customization';
import {
  formatPerKg,
  formatWeight,
  isSoldByWeight,
  parseWeightInput,
  WEIGHT_MAX_GRAMS,
  WEIGHT_MIN_GRAMS,
  WEIGHT_PRESETS_GRAMS,
  weightPriceInr,
} from '@/lib/menu/weight';
import type { AddonGroup, MenuItem } from '@/lib/types';

/**
 * Shared modal body for the customer MenuItemCustomizeModal and the staff
 * PosCustomizeModal — size picker, weight picker (sold-by-weight items,
 * lib/menu/weight.ts), addon groups (split into a "Required" section and an
 * "Add-ons (optional)" section) and the special-instructions field. Pure
 * presentation: all selection state and rules live in the caller (backed by
 * lib/menu/customization.ts) so both modals stay byte-for-byte aligned on
 * what's required and what a tap does.
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
  suggestedOptionIds,
  coffeyOptions,
  weightGrams = null,
  onWeightChange,
}: {
  item: MenuItem;
  variantId: string;
  onVariantChange: (id: string) => void;
  /** Sold-by-weight items only: grams in one unit, or null while the typed
   * weight isn't valid (the caller then can't add the line). */
  weightGrams?: number | null;
  onWeightChange?: (grams: number | null) => void;
  selection: Record<string, string[]>;
  onToggle: (group: AddonGroup, optionId: string) => void;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  /** 'touch' gives POS tablets slightly larger tap targets. */
  size?: 'default' | 'touch';
  /** Option ids to mark with a "Coffey's pick" pill (already vetted by
   * lib/menu/customization suggestedOptionIds). Highlight only: nothing about
   * the selection changes. Omitted by the POS and the menu page. */
  suggestedOptionIds?: ReadonlySet<string>;
  /** What Coffey preselected (group id → option ids; the modal passes its
   * `suggestedOptions` narrowed to what was chosen on open). Draws the "Coffey
   * set this up for you" strip above the options. Omitted by the POS, the menu
   * page and the table menu: the screen is then exactly as it always was. */
  coffeyOptions?: Record<string, string[]>;
}) {
  const requiredGroups = item.addon_groups.filter(isRequired);
  const optionalGroups = item.addon_groups.filter((g) => !isRequired(g));
  const showSize = item.variants.length > 1;
  const byWeight = isSoldByWeight(item) && onWeightChange !== undefined;
  const variant = item.variants.find((v) => v.id === variantId) ?? item.variants[0];

  const hasRequiredSection = showSize || byWeight || requiredGroups.length > 0;
  const hasOptionalSection = optionalGroups.length > 0;

  const stripEntries = coffeyStripEntries(item, coffeyOptions, selection);

  const body = (
    <div className="divide-y divide-line">
      {hasRequiredSection ? (
        <section className="py-2 first:pt-0">
          <h3 className="mb-2 text-sm font-semibold text-muted">Required</h3>
          <div className="space-y-3">
            {showSize ? (
              <SizePicker item={item} variantId={variantId} onVariantChange={onVariantChange} size={size} />
            ) : null}
            {byWeight && variant ? (
              <WeightPicker
                pricePerKg={variant.price_inr}
                weightGrams={weightGrams}
                onWeightChange={onWeightChange}
                size={size}
              />
            ) : null}
            {requiredGroups.map((group) => (
              <AddonGroupBlock
                key={group.id}
                group={group}
                selectedIds={selection[group.id] ?? []}
                onToggle={onToggle}
                size={size}
                suggestedOptionIds={suggestedOptionIds}
              />
            ))}
          </div>
        </section>
      ) : null}

      {hasOptionalSection ? (
        <section className="py-2 first:pt-0">
          <h3 className="mb-2 text-sm font-semibold text-muted">Add-ons (optional)</h3>
          <div className="space-y-3">
            {optionalGroups.map((group) => (
              <AddonGroupBlock
                key={group.id}
                group={group}
                selectedIds={selection[group.id] ?? []}
                onToggle={onToggle}
                size={size}
                suggestedOptionIds={suggestedOptionIds}
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

  if (stripEntries.length === 0) return body;
  return (
    <div>
      <CoffeyStrip entries={stripEntries} selection={selection} onToggle={onToggle} />
      {body}
    </div>
  );
}

/**
 * "Coffey set this up for you": the options Coffey preselected, gathered above
 * the (long) option groups so they can be seen and changed in one place. Each
 * chip calls the SAME onToggle as the option's own chip in its group, so
 * min/max/single-select rules live in one place (toggleOption) and the two
 * always agree; `on` is read from the form's selection.
 *  - An optional add-on: ticked (✓) when on, dashed outline when off.
 *  - A required choice (sugar) can't be off: pressed while it is the chosen
 *    option, unpressed when another is chosen below, and tapping selects it.
 * State is never colour alone (tick / dashed outline) and every chip is a real
 * button with aria-pressed.
 */
function CoffeyStrip({
  entries,
  selection,
  onToggle,
}: {
  entries: ReturnType<typeof coffeyStripEntries>;
  selection: Record<string, string[]>;
  onToggle: (group: AddonGroup, optionId: string) => void;
}) {
  const headingId = useId();
  const removable = entries.some((e) => !e.required);
  // Same rule as the chip's own `atMax`: a full multi-select group can't take another.
  const isFull = (e: (typeof entries)[number]) =>
    e.group.selection_type === 'multi' && !e.on && (selection[e.group.id] ?? []).length >= e.group.max_select;
  const anyFull = entries.some(isFull);
  return (
    <div role="group" aria-labelledby={headingId} className="mb-3 rounded-lg border border-line bg-surface p-3">
      <p id={headingId} className="mb-2 text-sm font-semibold text-charcoal">
        Coffey set this up for you
      </p>
      <div className="flex flex-wrap gap-1.5">
        {entries.map((e) => (
          <StripChip
            key={e.option.id}
            entry={e}
            atMax={isFull(e)}
            onToggle={onToggle}
          />
        ))}
      </div>
      {anyFull ? (
        <p className="mt-2 text-xs text-muted">That group is full. Remove one of its choices below to add this back.</p>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        {removable ? 'Tap to remove or put back. Everything else is below, as usual.' : 'You can change it below.'}
      </p>
    </div>
  );
}

/** A required group's name as a chip prefix: "Choice of Sugar" reads "Sugar".
 * Only a leading "Choice of " is stripped; an empty name gives no prefix. */
function shortGroupName(displayName: string | null | undefined): string {
  return (displayName ?? '').replace(/^\s*choice of\s+/i, '').trim();
}

function StripChip({
  entry,
  atMax,
  onToggle,
}: {
  entry: ReturnType<typeof coffeyStripEntries>[number];
  atMax: boolean;
  onToggle: (group: AddonGroup, optionId: string) => void;
}) {
  const { group, option, label, priceInr, required, on } = entry;
  return (
    <button
      type="button"
      disabled={atMax}
      aria-pressed={on}
      onClick={() => onToggle(group, option.id)}
      className={[
        atMax ? 'cursor-not-allowed opacity-40' : '',
        'inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan',
        on
          ? 'border border-tan bg-tan-dark text-cream'
          : 'border border-dashed border-muted text-charcoal hover:border-tan hover:text-tan-dark',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {on ? <span aria-hidden="true">✓</span> : null}
      <span>{required && shortGroupName(group.display_name) ? `${shortGroupName(group.display_name)}: ${label}` : label}</span>
      {priceInr > 0 ? (
        <span className={'font-mono tabular-nums ' + (on ? 'text-cream/80' : 'text-muted')}>+₹{priceInr}</span>
      ) : null}
    </button>
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
  // A sold-by-weight item's "sizes" are its grinds/roasts, priced per kg.
  const byWeight = isSoldByWeight(item);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span id={labelId} className="truncate text-sm font-semibold text-charcoal">
          {byWeight ? 'Type' : 'Size'}
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
              {v.label}{' '}
              <span className="ml-1 font-mono tabular-nums">{byWeight ? formatPerKg(v.price_inr) : `₹${v.price_inr}`}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * How many grams in one unit: preset bags as chips (each with its price at the
 * chosen type's per-kg rate), or any whole number of grams typed into "Other".
 * Reports null while "Other" holds something out of range, so the caller can't
 * add a line the server would refuse.
 */
function WeightPicker({
  pricePerKg,
  weightGrams,
  onWeightChange,
  size,
}: {
  pricePerKg: number;
  weightGrams: number | null;
  onWeightChange: (grams: number | null) => void;
  size: 'default' | 'touch';
}) {
  const labelId = useId();
  const inputId = useId();
  const hintId = useId();
  // What's typed in "Other". Empty while a preset chip is the choice.
  const [custom, setCustom] = useState(() =>
    weightGrams !== null && !WEIGHT_PRESETS_GRAMS.includes(weightGrams) ? String(weightGrams) : '',
  );
  const customInvalid = custom !== '' && parseWeightInput(custom) === null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span id={labelId} className="truncate text-sm font-semibold text-charcoal">
          Weight
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-xs font-semibold tabular-nums text-muted">
          {formatPerKg(pricePerKg)}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={labelId}>
        {WEIGHT_PRESETS_GRAMS.map((grams) => {
          const selected = custom === '' && weightGrams === grams;
          return (
            <button
              key={grams}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setCustom('');
                onWeightChange(grams);
              }}
              className={chipClasses(selected, size)}
            >
              {formatWeight(grams)}{' '}
              <span className="ml-1 font-mono tabular-nums">₹{weightPriceInr(pricePerKg, grams)}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="text-sm text-muted">
          Other weight
        </label>
        {/* The focus ring goes on the box, not the input, so it wraps the "g". */}
        <div
          className={
            'flex w-32 items-center rounded-md border focus-within:border-tan focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tan ' +
            (customInvalid ? 'border-tan-dark' : 'border-muted/80')
          }
        >
          <input
            id={inputId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={custom}
            onChange={(e) => {
              const next = e.target.value.replace(/\D/g, '').slice(0, 5);
              setCustom(next);
              onWeightChange(next === '' ? null : parseWeightInput(next));
            }}
            placeholder="grams"
            aria-describedby={hintId}
            aria-invalid={customInvalid || undefined}
            className="min-h-[44px] w-full min-w-0 rounded-md bg-transparent px-3 py-2 font-mono text-base tabular-nums text-charcoal outline-none focus-visible:outline-none"
          />
          <span className="pr-3 text-sm text-muted">g</span>
        </div>
        {custom !== '' && !customInvalid ? (
          <span className="font-mono text-sm tabular-nums text-charcoal">
            ₹{weightPriceInr(pricePerKg, Number(custom))}
          </span>
        ) : null}
        <span id={hintId} className={'text-xs ' + (customInvalid ? 'font-semibold text-tan-dark' : 'text-muted')}>
          {WEIGHT_MIN_GRAMS} to {WEIGHT_MAX_GRAMS} g
        </span>
      </div>
    </div>
  );
}

function AddonGroupBlock({
  group,
  selectedIds,
  onToggle,
  size,
  suggestedOptionIds,
}: {
  group: AddonGroup;
  selectedIds: string[];
  onToggle: (group: AddonGroup, optionId: string) => void;
  size: 'default' | 'touch';
  suggestedOptionIds?: ReadonlySet<string>;
}) {
  const labelId = useId();
  const required = isRequired(group);
  const count = selectedIds.length;

  // A required group is marked once, by the "Required" section heading it sits
  // under, so it gets no pill of its own (just a count once a multi-select has
  // some chosen).
  let badge: string | null;
  let badgeClass: string;
  if (group.selection_type === 'multi' && count > 0) {
    badge = `${count}/${group.max_select}`;
    badgeClass = 'bg-surface text-tan-dark';
  } else if (required) {
    badge = null;
    badgeClass = '';
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
        {badge ? (
          <span
            className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass}`}
            aria-label={selectionLabel(group)}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {group.options.map((option) => {
          const selected = selectedIds.includes(option.id);
          const atMax = group.selection_type === 'multi' && !selected && count >= group.max_select;
          const suggested = suggestedOptionIds?.has(option.id) ?? false;
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
              {/* Coffey's flavour add-on (COFFEY-ADDONS-PAIRINGS-SPEC §1.1). Real
                  text inside the button, so it is part of the option's accessible
                  name ("Hazelnut syrup Coffey's pick +₹35") and doesn't rely on
                  colour. Brand tokens: tan-dark text is AA on both `surface` and
                  the white pill used on a selected (tan-dark) chip. */}
              {suggested ? (
                <span
                  className={
                    'ml-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-tan-dark ' +
                    (selected ? 'bg-cream' : 'bg-surface')
                  }
                >
                  Coffey&apos;s pick
                </span>
              ) : null}
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
  const sizeClasses = size === 'touch' ? 'min-h-[44px] px-4 py-2' : 'min-h-[44px] px-3.5 py-2';
  return [
    'inline-flex items-center rounded-full text-sm font-medium transition-colors',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan',
    disabled ? 'cursor-not-allowed opacity-40' : '',
    sizeClasses,
    selected ? 'border border-tan bg-tan-dark text-cream' : 'border border-line text-charcoal hover:border-tan hover:text-tan-dark',
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
        className="text-sm font-semibold text-tan-dark hover:text-tan-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
      >
        + Add note
      </button>
    );
  }

  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-sm font-semibold text-muted">
        Note for this item
      </label>
      <input
        id={inputId}
        type="text"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, MAX_INSTRUCTIONS_LEN))}
        maxLength={MAX_INSTRUCTIONS_LEN}
        placeholder="e.g. less sugar, no ice"
        className="min-h-[44px] w-full rounded-md border border-muted/80 px-3 py-2 text-base text-charcoal outline-none focus:border-tan"
      />
    </div>
  );
}
