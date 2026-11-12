// Who is looking at the pending menu requests, and which of them they may
// cancel. GET /api/menu/requests answers with `viewer`; who may cancel what is
// the request lifecycle's rule (lib/menu/changeRequestStatus.ts: a pending
// request, by the requester, a manager or the owner) — the same check
// DELETE /api/menu/requests/[id] makes, which stays the real gate. Cancelling is
// also a menu change, so it needs canEditMenu too.

import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import { canCancelMenuChange } from '@/lib/menu/changeRequestStatus';

export interface MenuRequestViewer {
  id: string;
  role: string;
}

/** The `viewer` of a GET /api/menu/requests answer, or null if it isn't one. */
export function parseMenuRequestViewer(raw: unknown): MenuRequestViewer | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, role } = raw as { id?: unknown; role?: unknown };
  return typeof id === 'string' && typeof role === 'string' ? { id, role } : null;
}

export function canCancelMenuRequest(
  request: Pick<MenuChangeRequest, 'requested_by' | 'status'>,
  viewer: MenuRequestViewer | null,
  canEditMenu: boolean,
): boolean {
  return canEditMenu && canCancelMenuChange(request, viewer);
}
