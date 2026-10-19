// Who is looking at the pending menu requests, and which of them they may
// cancel. GET /api/menu/requests answers with `viewer`; the rule below mirrors
// DELETE /api/menu/requests/[id] (the requester, a manager or the owner), which
// stays the real gate. Cancelling is also a menu change, so it needs canEditMenu.

import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';

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
  request: Pick<MenuChangeRequest, 'requested_by'>,
  viewer: MenuRequestViewer | null,
  canEditMenu: boolean,
): boolean {
  if (!canEditMenu || !viewer) return false;
  return request.requested_by === viewer.id || viewer.role === 'manager' || viewer.role === 'owner';
}
