import type { ReactNode } from 'react';
import { CoffeyMascot, type CoffeyExpression } from '@/components/coffey/CoffeyMascot';

// Coffey speaking (docs/COFFEY-SPEC.md §6.1): the mascot with a speech bubble
// beside it. The wizard opens every step with one.
//
// Side by side at every width: on a 360px phone the 56px mascot plus its gap
// leave the bubble ~230px, which is plenty for Coffey's short lines, and the
// text wraps inside it (`min-w-0`) rather than pushing the row wider.
// `text-pretty` stops a line of Coffey's speech ending on a lone word.
//
// Server-renderable (no hooks, no 'use client').

export function CoffeyBubble({
  children,
  size = 56,
  expression = 'happy',
  animated,
  live = false,
  lead,
  centered = false,
  className = '',
}: {
  children: ReactNode;
  /** Mascot size in px. */
  size?: number;
  expression?: CoffeyExpression;
  /** Passed to the mascot: steam drift on or off (its default is on). */
  animated?: boolean;
  /** Announce the bubble's text politely when it changes — for status updates
   * (e.g. Coffey's picks arriving). The region has to already be on the page
   * when its text changes for a screen reader to speak it, so keep one bubble
   * mounted and swap its children rather than mounting a new one. */
  live?: boolean;
  /** Something other than the default mascot beside the bubble (e.g. the
   * wizard's live cup). `size` should then be that thing's size, for the tail. */
  lead?: ReactNode;
  /** Centre the bubble against a tall `lead` instead of top-aligning it. */
  centered?: boolean;
  className?: string;
}) {
  return (
    <div className={['flex gap-3', centered ? 'items-center' : 'items-start', className].filter(Boolean).join(' ')}>
      {lead ?? <CoffeyMascot size={size} expression={expression} animated={animated} />}
      <div
        aria-live={live ? 'polite' : undefined}
        className="relative min-w-0 flex-1 text-pretty rounded-2xl border border-line bg-surface px-4 py-3 text-charcoal"
      >
        {/* The tail: a square turned 45°, with only its two outward edges
            bordered, half hidden behind the bubble's own fill so it reads as
            part of the bubble. It sits at the height of Coffey's face. */}
        <span
          aria-hidden="true"
          className="absolute -left-[7px] h-3 w-3 rotate-45 border-b border-l border-line bg-surface"
          style={centered ? { top: 'calc(50% - 6px)' } : { top: Math.round(size * 0.55 - 6) }}
        />
        {children}
      </div>
    </div>
  );
}
