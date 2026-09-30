import type { ReactNode } from 'react';
import { PASS_SHORT_NAME } from '@/lib/passes/brand';

/**
 * The small "Ritual" tag: a tan outline with tan-dark text (tan itself is
 * decoration only, never text). Used on menu items a Ritual cup can pay for and
 * on bill lines a cup did pay for ("Ritual ×2"). Presentational, so it works
 * from server and client components alike.
 */
export function RitualChip({ children = PASS_SHORT_NAME, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <span
      className={
        'inline-flex shrink-0 items-center rounded-full border border-tan px-1.5 py-0.5 text-[11px] font-semibold leading-none text-tan-dark ' +
        className
      }
    >
      {children}
    </span>
  );
}
