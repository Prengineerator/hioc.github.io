'use client';

import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Rendered as the dialog's accessible name (aria-labelledby) and its visible header. */
  title: string;
  children: ReactNode;
  /** Optional pinned bottom bar (e.g. a submit button), rendered outside the scrollable body. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASSES: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

/**
 * The shared dialog shell — overlay, centered panel, header with a close
 * button, scrollable body, optional pinned footer. Handles the a11y/UX
 * plumbing every hand-rolled modal on this site needs (Escape to close,
 * background scroll lock, `role="dialog"`/`aria-modal`) so feature code only
 * has to supply `title` + content. Renders nothing when `open` is false —
 * callers control mount/unmount, so no exit animation is attempted.
 */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  // Portal to <body> so the fixed overlay always covers the viewport — if it
  // rendered in place, an ancestor with a CSS transform/overflow (e.g. the menu
  // Card's hover-lift) would become its containing block and trap it inside the
  // tile instead of centering it on screen.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-4 py-8">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 animate-fade-in bg-charcoal/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative flex max-h-[85vh] w-full animate-scale-in flex-col rounded-md bg-cream shadow-elevated ${SIZE_CLASSES[size]}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-4">
          <h2 id={titleId} className="text-lg font-bold text-charcoal">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 rounded-full p-1 text-2xl leading-none text-charcoal transition-colors hover:bg-surface hover:text-tan focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
          >
            &times;
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer ? <div className="border-t border-line px-6 py-4">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
