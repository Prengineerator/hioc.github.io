import type { HTMLAttributes } from 'react';

export type BadgeVariant = 'neutral' | 'tan' | 'success' | 'danger' | 'outline';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'bg-surface text-charcoal',
  tan: 'bg-tan text-cream',
  success: 'bg-green-700 text-cream',
  danger: 'bg-red-700 text-cream',
  outline: 'border border-line text-charcoal',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

/** A small pill label — status tags, counts, "New" markers. */
export function Badge({ variant = 'neutral', className = '', children, ...rest }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold',
        VARIANT_CLASSES[variant],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </span>
  );
}
