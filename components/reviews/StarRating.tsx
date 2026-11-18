'use client';

// Shared 1-5 star rating control (LOY-3). Interactive when `onChange` is
// given (review form); read-only display otherwise (order-status invite,
// owner moderation table, review summaries).
//
// Interactive stars are a radio group: 44px targets, `muted` for empty stars
// (3:1+ on white; the old `line` colour was near invisible), roving tabindex so
// the group is one tab stop with arrow-key movement, and the current value in
// the group's accessible name.

const SIZES = { sm: 'text-base', md: 'text-2xl', lg: 'text-4xl' } as const;

export function StarRating({
  value,
  onChange,
  size = 'md',
  label,
}: {
  value: number;
  onChange?: (next: number) => void;
  size?: keyof typeof SIZES;
  label?: string;
}) {
  const interactive = typeof onChange === 'function';
  const stars = [1, 2, 3, 4, 5];

  return (
    <div
      role={interactive ? 'radiogroup' : 'img'}
      aria-label={
        interactive
          ? `${label ?? 'Rating'}, ${value > 0 ? `${value} out of 5 stars` : 'not rated yet'}`
          : (label ?? `${value} out of 5 stars`)
      }
      className={'flex items-center ' + (interactive ? 'gap-0 ' : 'gap-1 ') + SIZES[size]}
    >
      {stars.map((n) => {
        const filled = n <= Math.round(value);
        if (!interactive) {
          return (
            <span key={n} aria-hidden="true" className={filled ? 'text-tan-dark' : 'text-muted'}>
              ★
            </span>
          );
        }
        // Roving tabindex: the selected star (or the first, when unrated) is the tab stop.
        const tabStop = value > 0 ? n === value : n === 1;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={n === value}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            tabIndex={tabStop ? 0 : -1}
            onClick={() => onChange!(n)}
            onKeyDown={(e) => {
              let next = 0;
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(5, (value || 0) + 1);
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(1, (value || 2) - 1);
              if (!next) return;
              e.preventDefault();
              onChange!(next);
              e.currentTarget.parentElement
                ?.querySelectorAll<HTMLElement>('[role="radio"]')
                [next - 1]?.focus();
            }}
            className={
              'inline-flex min-h-[44px] min-w-[44px] items-center justify-center leading-none transition-colors ' +
              (filled ? 'text-tan-dark' : 'text-muted hover:text-tan-dark')
            }
          >
            <span aria-hidden="true">★</span>
          </button>
        );
      })}
    </div>
  );
}
