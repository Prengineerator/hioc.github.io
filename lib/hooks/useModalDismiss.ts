'use client';

// Shared modal behavior (M13) for the hand-rolled staff dialogs that don't use
// components/ui/Modal: Escape-to-close + background scroll lock. Uses a ref for
// the latest onClose so it only binds/unbinds once (no churn on re-render).

import { useEffect, useRef } from 'react';

export function useModalDismiss(onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, []);
}
