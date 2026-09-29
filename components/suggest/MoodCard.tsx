'use client';

// Step 1's big feeling cards (COFFEY-SPEC §1). The step is multi-select, capped
// at two feelings, so each card is a toggle button (aria-pressed), not a radio.
// The group itself (role="group" + aria-labelledby the step heading) is wired
// up by the caller, which also owns the cap: once two are picked it passes
// `disabled` to the rest, and the visible hint under the heading says why.
//
// A picked card is never signalled by colour alone: it also gets a check badge
// and a heavier border.

export function MoodCard({
  label,
  icon,
  selected,
  disabled = false,
  onToggle,
}: {
  label: string;
  icon: string;
  selected: boolean;
  /** The cap is reached and this card isn't one of the picks. */
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onToggle}
      className={
        'relative flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-md border p-4 text-center transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan disabled:cursor-not-allowed disabled:opacity-50 ' +
        // The heavier selected border is a 1px ring over the 1px border, so
        // toggling never nudges the card's contents by a pixel.
        (selected
          ? 'border-tan-dark bg-surface ring-1 ring-tan-dark'
          : 'border-line bg-cream ' + (disabled ? '' : 'hover:border-tan'))
      }
    >
      {selected ? (
        <span
          aria-hidden="true"
          className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-tan-dark text-xs font-bold leading-none text-cream"
        >
          ✓
        </span>
      ) : null}
      <span aria-hidden="true" className="text-2xl">
        {icon}
      </span>
      {/* text-balance keeps a wrapped label even ("Curious — / surprise me")
          instead of leaving a lone word on the second line, and the non-breaking
          space keeps the dash on the end of a line rather than the start of one. */}
      <span className="text-balance text-sm font-semibold text-charcoal">{label.replace(' — ', '\u00A0— ')}</span>
    </button>
  );
}
