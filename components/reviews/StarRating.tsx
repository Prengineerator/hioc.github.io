'use client';

// Shared 1–5 star rating control (LOY-3). Interactive when `onChange` is
// given (review form); read-only display otherwise (order-status invite,
// owner moderation table, review summaries).

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
      aria-label={label ?? `${value} out of 5 stars`}
      className={'flex items-center gap-1 ' + SIZES[size]}
    >
      {stars.map((n) => {
        const filled = n <= Math.round(value);
        if (!interactive) {
          return (
            <span key={n} aria-hidden="true" className={filled ? 'text-tan' : 'text-[#e5e5e5]'}>
              ★
            </span>
          );
        }
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={n === value}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            onClick={() => onChange!(n)}
            className={
              'leading-none transition-colors ' + (filled ? 'text-tan' : 'text-[#e5e5e5] hover:text-tan/60')
            }
          >
            ★
          </button>
        );
      })}
    </div>
  );
}
