'use client';

// POS → Menu: the edits, new items and deletes this shop has sent to the owner
// that are still waiting for a decision (menu_change_requests, status pending).
// A requester, a manager or the owner can cancel one before it is decided; the
// same list sits behind the Menu badge in the staff header (MenuRequestsPanel).

import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import { MenuRequestList } from './MenuRequestList';
import { canCancelMenuRequest, type MenuRequestViewer } from './requestViewer';
import { useCancelMenuRequest } from './useCancelMenuRequest';

export function PendingMenuRequests({
  requests,
  canCancel,
  viewer,
  onChanged,
}: {
  requests: MenuChangeRequest[];
  /** Cancelling is a menu change, so it follows canEditMenu (POS only). */
  canCancel: boolean;
  /** Who is looking: Cancel shows only on their own requests, or on all for a manager / the owner. */
  viewer: MenuRequestViewer | null;
  /** A request was cancelled, or turned out to be decided already: reload the list. */
  onChanged: () => void;
}) {
  const cancel = useCancelMenuRequest(onChanged);

  if (requests.length === 0) return null;

  return (
    <section
      aria-label="Menu changes waiting for the owner"
      className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4"
    >
      <h2 className="text-sm font-bold text-amber-900">Waiting for owner approval ({requests.length})</h2>
      <p className="mt-0.5 text-xs text-amber-900/80">
        The menu stays as it is until the owner approves.
      </p>

      <MenuRequestList
        requests={requests}
        canCancel={(r) => canCancelMenuRequest(r, viewer, canCancel)}
        cancel={cancel}
      />
    </section>
  );
}
