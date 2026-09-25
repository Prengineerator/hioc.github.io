'use client';

// Step 2's big mood cards — a real radiogroup (SUG-7 AC: "mood cards are a
// radiogroup"). The group itself (role="radiogroup" + aria-labelledby) is
// wired up by the caller; this is one role="radio" option in it.

export function MoodCard({
  label,
  icon,
  selected,
  onSelect,
}: {
  label: string;
  icon: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={
        'flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-md border p-4 text-center transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
        (selected ? 'border-tan bg-surface' : 'border-line bg-cream hover:border-tan')
      }
    >
      <span aria-hidden="true" className="text-2xl">
        {icon}
      </span>
      <span className="text-sm font-semibold text-charcoal">{label}</span>
    </button>
  );
}
