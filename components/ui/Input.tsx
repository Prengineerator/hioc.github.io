'use client';

import { forwardRef, useId, type InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

/**
 * A labeled text input with an error/hint slot. Uncontrolled or controlled —
 * spreads all native input props through, so existing `value`/`onChange`
 * call sites (e.g. the login form) can adopt it without changing behavior.
 * Auto-generates an id via useId() when one isn't passed, so <label> stays
 * correctly associated without every call site inventing one.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, id, className = '', ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <label htmlFor={inputId} className="text-sm font-bold text-charcoal">
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={!!error || undefined}
        aria-describedby={describedBy}
        className={[
          'min-h-[44px] w-full rounded-md border bg-cream px-3 py-2 text-charcoal outline-none transition-colors',
          'placeholder:text-muted',
          'focus:border-tan focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan',
          'disabled:cursor-not-allowed disabled:bg-surface disabled:opacity-60',
          error ? 'border-red-600' : 'border-line',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      />
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs font-bold text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
