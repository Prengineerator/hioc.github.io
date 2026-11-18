'use client';

import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  error?: string;
  hint?: string;
}

/** Same labeled/error/hint shell as <Input>, for multi-line text (e.g. special instructions, refund reasons). */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, hint, id, className = '', 'aria-describedby': describedByProp, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  // A caller's own aria-describedby (e.g. a hint rendered outside this
  // component) is kept alongside the error/hint link, not replaced by it.
  const describedBy =
    [describedByProp, error ? `${inputId}-error` : hint ? `${inputId}-hint` : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <label htmlFor={inputId} className="text-sm font-semibold text-charcoal">
          {label}
        </label>
      ) : null}
      <textarea
        ref={ref}
        id={inputId}
        aria-invalid={!!error || undefined}
        aria-describedby={describedBy}
        className={[
          'w-full rounded-md border bg-cream px-3 py-2 text-base text-charcoal outline-none transition-colors',
          'placeholder:text-muted',
          'focus:border-tan focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan',
          'disabled:cursor-not-allowed disabled:bg-surface disabled:opacity-60',
          error ? 'border-red-700' : 'border-muted/80',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      />
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
