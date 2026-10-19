'use client';

// Cancelling a pending menu request (DELETE /api/menu/requests/[id]): ask first,
// then call the API. Shared by the POS Menu screen's panel and the header badge's
// list so both behave the same. `onChanged` runs after every attempt, success or
// not: a 409 means the owner decided it in the meantime, and the reload drops it.

import { useCallback, useState } from 'react';
import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';

export interface CancelMenuRequest {
  /** The request waiting on the "are you sure" dialog. */
  confirmTarget: MenuChangeRequest | null;
  cancellingId: string | null;
  /** The API's own message (403 / 409 …) or a connection fallback. */
  error: string | null;
  ask: (request: MenuChangeRequest) => void;
  dismiss: () => void;
  confirm: () => Promise<void>;
  /** Forget the dialog and any error (when the list closes). */
  reset: () => void;
}

export function useCancelMenuRequest(onChanged: () => void): CancelMenuRequest {
  const [confirmTarget, setConfirmTarget] = useState<MenuChangeRequest | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dismiss = useCallback(() => setConfirmTarget(null), []);
  const reset = useCallback(() => {
    setConfirmTarget(null);
    setError(null);
  }, []);

  const confirm = async () => {
    const request = confirmTarget;
    if (!request) return;
    setConfirmTarget(null);
    setCancellingId(request.id);
    setError(null);
    try {
      const res = await fetch(`/api/menu/requests/${request.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? 'Could not cancel the request. Try again.');
      }
      onChanged();
    } catch {
      setError('Could not cancel the request. Check the connection and try again.');
    } finally {
      setCancellingId(null);
    }
  };

  return { confirmTarget, cancellingId, error, ask: setConfirmTarget, dismiss, confirm, reset };
}
