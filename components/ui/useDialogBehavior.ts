'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The keyboard/AT plumbing every overlay on this site needs (Modal, the cart
 * drawer): Escape closes, the page behind stops scrolling, focus moves into
 * the panel on open, Tab/Shift+Tab stay inside it, and focus goes back to
 * whatever opened it on close — so a keyboard or screen-reader user never
 * ends up "behind" the overlay, and the counter tablet's hardware keyboard
 * can dismiss any dialog.
 *
 * `onClose` is read through a ref on purpose: callers almost always pass an
 * inline arrow, and depending on it directly would re-run the open effect —
 * and yank focus back to the first field — on every parent render.
 */
export function useDialogBehavior(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Initial focus: the first form field (a PIN, an amount, a reason), else
    // the close button, else the panel. Never "the first button" — in the
    // cart and most staff dialogs that's a Remove/Void/Reject, and a stray
    // Enter would fire it.
    // On a touch screen, focusing a text field pops the on-screen keyboard
    // over half the dialog, so there it's the panel itself (screen readers
    // still land inside the dialog). A child that already took focus during
    // commit (an `autoFocus` PIN or amount field) wins either way.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const finePointer = window.matchMedia?.('(pointer: fine)').matches ?? true;
      const field = finePointer
        ? panel.querySelector<HTMLElement>(
            'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])',
          )
        : null;
      const close = panel.querySelector<HTMLElement>('[data-dialog-close]:not([disabled])');
      const target = field ?? (finePointer ? close : null) ?? panel;
      target.focus({ preventScroll: true });
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      // Only restore if focus is still inside (or lost to <body>) — if the
      // close action itself moved focus somewhere deliberate, leave it there.
      if (
        previouslyFocused &&
        document.contains(previouslyFocused) &&
        (document.activeElement === document.body || panel?.contains(document.activeElement))
      ) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open, panelRef]);
}
