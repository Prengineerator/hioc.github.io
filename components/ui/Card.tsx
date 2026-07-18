import type { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Adds a hover lift + tan border, for cards that are themselves a link/button trigger. */
  interactive?: boolean;
}

const PADDING_CLASSES: Record<NonNullable<CardProps['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

/**
 * The shared surface for grouped content (menu items, info blocks, form
 * panels) — a bordered, softly-shadowed rounded-md box matching the
 * border/shadow treatment already used across the site. Unopinionated about
 * layout inside; pass `padding="none"` to fully control spacing yourself
 * (e.g. when a child already has its own padding, like an image).
 */
export function Card({
  padding = 'md',
  interactive = false,
  className = '',
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={[
        'rounded-md border border-line bg-cream shadow-card',
        PADDING_CLASSES[padding],
        interactive
          ? 'transition-all duration-150 hover:-translate-y-0.5 hover:border-tan hover:shadow-elevated'
          : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}
