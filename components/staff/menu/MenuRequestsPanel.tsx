'use client';

// The list behind the Menu badge in the staff header: what is waiting for the
// owner, with Cancel where the viewer may use it, and a link on to the Menu
// screen. The caller positions it (a dropdown on the bar, inline in the phone
// drawer) and owns closing it on an outside click / Esc.

import { useEffect } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import { MenuRequestList } from './MenuRequestList';
import { canCancelMenuRequest, type MenuRequestViewer } from './requestViewer';
import type { CancelMenuRequest } from './useCancelMenuRequest';

export function MenuRequestsPanel({
  requests,
  viewer,
  canEditMenu,
  cancel,
  onClose,
  className = '',
}: {
  requests: MenuChangeRequest[];
  viewer: MenuRequestViewer | null;
  canEditMenu: boolean;
  cancel: CancelMenuRequest;
  /** "Open menu" was tapped. */
  onClose: () => void;
  className?: string;
}) {
  // Closing the list drops a half-finished confirm or an old error.
  const { reset } = cancel;
  useEffect(() => reset, [reset]);

  return (
    <div
      role="dialog"
      aria-label="Menu changes waiting for the owner"
      className={`max-h-[70vh] overflow-y-auto rounded-md border border-line bg-cream p-4 text-charcoal shadow-lg ${className}`}
    >
      <h2 className="text-sm font-bold text-amber-900">Waiting for owner approval ({requests.length})</h2>
      <p className="mt-0.5 text-xs text-muted">The menu stays as it is until the owner approves.</p>

      <MenuRequestList
        requests={requests}
        canCancel={(r) => canCancelMenuRequest(r, viewer, canEditMenu)}
        cancel={cancel}
        className="divide-line"
      />

      <Link
        href="/staff/menu"
        onClick={onClose}
        className="mt-2 flex min-h-[44px] items-center justify-center rounded-md border border-line text-sm font-bold text-charcoal hover:border-tan"
      >
        Open menu
      </Link>
    </div>
  );
}
