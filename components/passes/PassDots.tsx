import { passCupsLeftLabel, passDots } from '@/lib/passes/ui';
import type { PassSummary } from '@/lib/passes/types';

/**
 * A pass's cups as dots: filled for the ones still to spend, empty for the ones
 * used. Cups a manager gave back are square rather than round, so the difference
 * is in the shape and not only the colour. The text label says the same in words
 * (the dots themselves are hidden from screen readers).
 */
export function PassDots({
  pass,
}: {
  pass: Pick<PassSummary, 'drinks_total' | 'drinks_credited' | 'drinks_remaining'>;
}) {
  const dots = passDots(pass);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div aria-hidden="true" className="flex flex-wrap gap-1.5">
        {dots.map((dot, i) => (
          <span
            key={i}
            className={
              'h-4 w-4 border-2 border-tan ' +
              (dot.extra ? 'rounded-[4px] ' : 'rounded-full ') +
              (dot.filled ? 'bg-tan' : 'bg-cream')
            }
          />
        ))}
      </div>
      <span className="text-sm font-semibold text-charcoal">{passCupsLeftLabel(pass)}</span>
    </div>
  );
}
