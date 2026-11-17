'use client';

// A big, friendly toggle tile for step 2 (icon above a short label). Same
// contract as Chip: a real button with aria-pressed, tap again to clear (the
// caller does that), selected = tan-dark fill with cream text. A disabled tile is
// greyed and not tappable; the caller says why in a visible hint. Tiles sit in
// an equal-column grid, so the label may wrap to two lines but never widens the
// tile.

import type { ReactNode } from 'react';

export function ChoiceTile({
  label,
  icon,
  pressed,
  disabled = false,
  onClick,
  minHeight = 72,
}: {
  label: string;
  icon: ReactNode;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** px; whole tile is the tap target. */
  minHeight?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      style={{ minHeight }}
      className={
        'flex min-w-0 flex-col items-center justify-center gap-1 rounded-md border px-2 py-2 text-center text-sm font-semibold leading-tight transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan disabled:cursor-not-allowed disabled:opacity-50 ' +
        (disabled ? '' : 'active:scale-[0.97] motion-reduce:active:scale-100 ') +
        (pressed
          ? 'border-tan bg-tan-dark text-cream'
          : 'border-line bg-cream text-charcoal ' + (disabled ? '' : 'hover:border-tan hover:text-tan-dark'))
      }
    >
      <span aria-hidden="true" className="flex h-7 items-center justify-center text-xl leading-none">
        {icon}
      </span>
      <span className="max-w-full [overflow-wrap:anywhere]">{label}</span>
    </button>
  );
}
