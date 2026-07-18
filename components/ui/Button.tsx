import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-tan text-cream hover:bg-tan-dark',
  secondary:
    'border-2 border-tan text-tan hover:bg-tan hover:text-cream disabled:hover:bg-transparent disabled:hover:text-tan',
  ghost: 'text-charcoal hover:bg-surface disabled:hover:bg-transparent',
  danger: 'bg-red-700 text-cream hover:bg-red-800',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2.5 text-sm',
  lg: 'px-8 py-3 text-base',
};

/**
 * Returns the same class string <Button> renders with, for callers that
 * need button styling on a non-<button> element (most commonly a Next.js
 * <Link>, e.g. the hero "View Menu" CTA) — keeps every primary/secondary
 * action on brand without duplicating the variant/size logic per call site.
 */
export function buttonVariants({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className = '',
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
} = {}): string {
  return [
    'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md font-bold transition-colors',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth ? 'w-full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Shows an inline spinner and disables the button, without shifting its label out. */
  loading?: boolean;
}

/**
 * The shared action button — variants (primary/secondary/ghost/danger),
 * sizes, a loading state, and consistent focus/disabled/tap-target
 * treatment. Drop-in replacement for hand-rolled `<button className="...">`
 * calls; unopinionated beyond that (spreads all native button props).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', fullWidth, loading, disabled, className = '', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonVariants({ variant, size, fullWidth, className })}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
        />
      ) : null}
      {children}
    </button>
  );
});
