'use client';

// "How sweet?" (COFFEY-SPEC §1, step 2): a fully labelled five-point scale —
// Not sweet · Lightly sweet · Medium · Sweet · Very sweet — drawn as one
// connected strip rather than loose chips, plus a separate "Any" chip, which is
// the default. The labels are taste levels, not ingredients: a latte can be
// "Not sweet" and still come with sugar on the side, which is Coffey's job.
//
// Each segment is its own toggle button (aria-pressed) with a visible label.
// Tapping the segment that is already on turns it off, which is the same as
// "Any". The ramp lives ONLY in the little level meter above each label (none →
// full), so "sweeter" reads as "more" without leaning on colour. Every
// unselected segment stays the same plain white: a background that deepened
// towards "Very sweet" made that end look picked while "Any" was the actual
// choice. The picked segment gets the same pressed style as the chips — solid
// tan-dark with cream text (5.3:1). Tokens only.
//
// The group's label and helper text come from the caller (a FieldGroup); this
// renders the controls. It has to fit 360px with no horizontal scroll: the five
// segments share the row equally and their labels wrap ("Lightly / sweet").

import { Chip } from '@/components/suggest/Chip';
import { SWEETNESS_PREFS, type SweetnessPref } from '@/lib/suggest/types';

type SweetStep = Exclude<SweetnessPref, 'any'>;

const STEP_LABEL: Record<SweetStep, string> = {
  none: 'Not sweet',
  light: 'Lightly sweet',
  medium: 'Medium',
  sweet: 'Sweet',
  very: 'Very sweet',
};

// The scale's order is the contract's order, minus 'any' (which is its own chip).
const STEPS = SWEETNESS_PREFS.filter((p): p is SweetStep => p !== 'any');

// Meter bars, shortest to tallest (heights in px). A segment at index i lights
// its first i bars, so "Not sweet" is an empty meter and "Very sweet" a full one:
// one bar fewer than there are steps.
const BAR_HEIGHTS = Array.from({ length: STEPS.length - 1 }, (_, i) => 6 + i * 3);

function Meter({ level, selected }: { level: number; selected: boolean }) {
  return (
    <span aria-hidden="true" className="flex h-[15px] items-end gap-0.5">
      {BAR_HEIGHTS.map((height, i) => (
        <span
          key={i}
          style={{ height }}
          className={
            'w-1 rounded-sm ' +
            (i < level ? (selected ? 'bg-cream' : 'bg-tan') : selected ? 'bg-cream/40' : 'bg-charcoal/20')
          }
        />
      ))}
    </span>
  );
}

export function SweetnessScale({
  value,
  onChange,
}: {
  value: SweetnessPref;
  onChange: (next: SweetnessPref) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-5 overflow-hidden rounded-md border border-line">
        {STEPS.map((step, i) => {
          const selected = value === step;
          return (
            <button
              key={step}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected ? 'any' : step)}
              className={
                // The focus outline is drawn inside the segment (negative offset),
                // because the strip clips overflow and an outer ring would be cut
                // off. The label size steps up with the screen: on a 320px phone a
                // segment has ~52px for text, and "Medium" only fits at 12px.
                'flex min-h-[68px] min-w-0 flex-col items-center gap-2 border-l border-line px-0.5 py-2.5 text-center text-xs font-semibold leading-tight transition-colors first:border-l-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-tan min-[360px]:text-[13px] sm:text-sm ' +
                (selected ? 'bg-tan-dark text-cream' : 'bg-cream text-charcoal hover:bg-surface')
              }
            >
              <Meter level={i} selected={selected} />
              <span className="[overflow-wrap:anywhere]">{STEP_LABEL[step]}</span>
            </button>
          );
        })}
      </div>
      <div>
        <Chip label="Any" pressed={value === 'any'} onClick={() => onChange('any')} />
      </div>
    </>
  );
}
