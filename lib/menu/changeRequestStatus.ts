// The life of a menu change request (supabase/2026-10-menu-change-requests.sql),
// in one place: which status a request may move to, who may move it, and which
// status the write must still find on the row. The staff and owner routes, the
// approval code (lib/menu/changeRequests.ts) and both screens (the POS request
// list, the owner's approvals) all ask here, so "is it still pending?" and "may
// this person cancel it?" have one answer. Pure and client-safe.
//
//   pending  ── approve (owner) ─────────────────────────▶ approved
//   pending  ── reject (owner) ──────────────────────────▶ rejected
//   pending  ── cancel (who asked, a manager, the owner) ─▶ cancelled
//   pending  ── supersede (a newer request for the same item / group) ─▶ cancelled
//   pending  ── item_deleted (its item is gone, it can never apply) ───▶ cancelled
//   approved ── put_back (applying it failed; the item was left as it was) ─▶ pending
//
// rejected and cancelled are final. approved is final for people; only the
// approval code itself puts one back, when applying it failed.
//
// Approving claims the row first (pending → approved, compare-and-set) and then
// applies the change, so for a moment an approved request is "being applied".
// `applied_at` (supabase/2026-11-menu-inventory-state-machine.sql) is stamped
// once the change is in: an approval that stays unstamped was interrupted
// between the claim and the end of the apply (see approvalUnconfirmed).

import type { MenuChangeRequest, MenuChangeStatus } from '@/lib/menu/changeRequestTypes';

export const MENU_CHANGE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

// The list above and MenuChangeStatus must name the same statuses: adding one
// to either without the other fails to compile here.
type ListedStatus = (typeof MENU_CHANGE_STATUSES)[number];
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const STATUSES_MATCH: SameSet<ListedStatus, MenuChangeStatus> = true;
void STATUSES_MATCH;

/** No transition leaves these. */
export const FINAL_MENU_CHANGE_STATUSES: readonly MenuChangeStatus[] = ['rejected', 'cancelled'];

/** Who moves a request. 'system' is the app itself, never a person's click. */
export type MenuChangeActor = 'requester' | 'manager' | 'owner' | 'system';

export type MenuChangeTransitionName = 'approve' | 'reject' | 'cancel' | 'supersede' | 'item_deleted' | 'put_back';

export interface MenuChangeTransition {
  name: MenuChangeTransitionName;
  /** The status the write must still find on the row (its compare-and-set guard). */
  from: MenuChangeStatus;
  to: MenuChangeStatus;
  actors: readonly MenuChangeActor[];
}

export const MENU_CHANGE_TRANSITIONS: readonly MenuChangeTransition[] = [
  { name: 'approve', from: 'pending', to: 'approved', actors: ['owner'] },
  { name: 'reject', from: 'pending', to: 'rejected', actors: ['owner'] },
  { name: 'cancel', from: 'pending', to: 'cancelled', actors: ['requester', 'manager', 'owner'] },
  { name: 'supersede', from: 'pending', to: 'cancelled', actors: ['system'] },
  { name: 'item_deleted', from: 'pending', to: 'cancelled', actors: ['system'] },
  { name: 'put_back', from: 'approved', to: 'pending', actors: ['system'] },
];

export function menuChangeTransition(name: MenuChangeTransitionName): MenuChangeTransition {
  // Every name is in the table (the type says so), so this always finds one.
  return MENU_CHANGE_TRANSITIONS.find((t) => t.name === name) as MenuChangeTransition;
}

/** The person (or the app) asking: `id` is profiles.id, `role` their role. */
export interface MenuChangeViewer {
  id: string;
  role: string;
}

/**
 * What a viewer counts as for one request: the requester when it is theirs, and
 * a manager / the owner by role. 'system' is the app (pass it explicitly).
 */
export function actorsFor(
  request: Pick<MenuChangeRequest, 'requested_by'>,
  viewer: MenuChangeViewer | 'system',
): MenuChangeActor[] {
  if (viewer === 'system') return ['system'];
  const out: MenuChangeActor[] = [];
  if (request.requested_by !== null && request.requested_by === viewer.id) out.push('requester');
  if (viewer.role === 'manager') out.push('manager');
  if (viewer.role === 'owner') out.push('owner');
  return out;
}

export type MenuChangeCheck =
  | { ok: true; transition: MenuChangeTransition }
  | { ok: false; status: 403 | 409; code: 'already_decided' | 'forbidden_actor'; message: string };

const FORBIDDEN_MESSAGE: Partial<Record<MenuChangeTransitionName, string>> = {
  approve: 'Only the owner can approve a menu change.',
  reject: 'Only the owner can reject a menu change.',
  cancel: 'Only the person who made this request, a manager or the owner can cancel it',
};

/**
 * May `viewer` move a request in `status` along `name`? A request no longer in
 * the transition's from-status is a 409 ("already approved" — someone got
 * there first); a viewer the transition does not allow is a 403. The status is
 * checked first only when the viewer is allowed at all, so a stranger is told
 * "not yours" rather than what became of someone else's request.
 */
export function checkMenuChange(
  name: MenuChangeTransitionName,
  request: Pick<MenuChangeRequest, 'status' | 'requested_by'>,
  viewer: MenuChangeViewer | 'system',
): MenuChangeCheck {
  const transition = menuChangeTransition(name);
  const mine = actorsFor(request, viewer);
  if (!mine.some((a) => transition.actors.includes(a))) {
    return { ok: false, status: 403, code: 'forbidden_actor', message: FORBIDDEN_MESSAGE[name] ?? 'Not allowed.' };
  }
  if (request.status !== transition.from) {
    return { ok: false, status: 409, code: 'already_decided', message: `This request was already ${request.status}.` };
  }
  return { ok: true, transition };
}

// ---------------------------------------------------------------------------
// Screen helpers (in terms of the table above)
// ---------------------------------------------------------------------------

/** Statuses a person can still move a request out of (approve, reject or cancel it). */
export const OPEN_MENU_CHANGE_STATUSES: readonly MenuChangeStatus[] = [
  ...new Set(MENU_CHANGE_TRANSITIONS.filter((t) => !t.actors.includes('system')).map((t) => t.from)),
];

/** Still waiting for the owner. */
export function isPendingMenuChange(request: Pick<MenuChangeRequest, 'status'>): boolean {
  return OPEN_MENU_CHANGE_STATUSES.includes(request.status);
}

/** The owner's Approve / Reject buttons. */
export function canDecideMenuChange(request: Pick<MenuChangeRequest, 'status'>): boolean {
  return request.status === menuChangeTransition('approve').from && request.status === menuChangeTransition('reject').from;
}

/** The POS list's Cancel button (the API re-checks: DELETE /api/menu/requests/[id]). */
export function canCancelMenuChange(
  request: Pick<MenuChangeRequest, 'status' | 'requested_by'>,
  viewer: MenuChangeViewer | null,
): boolean {
  return viewer !== null && checkMenuChange('cancel', request, viewer).ok;
}

/**
 * How long an approval may take to apply before an unstamped one counts as
 * interrupted. An apply is a handful of writes; a minute of slack covers a slow
 * database without flagging a request the owner is looking at mid-apply.
 */
export const APPLY_GRACE_MS = 2 * 60 * 1000;

/**
 * An approved request whose change is not confirmed as applied: the server
 * claimed it (pending → approved) but stopped before the apply finished and
 * before it could put the request back. The owner is told to check the item.
 *
 * With supabase/2026-11-menu-inventory-state-machine.sql applied the row says
 * so exactly (`applied_at` still empty after the grace period). Without it
 * (`applied_at` absent) only what the row itself shows can be read: an approved
 * create that never got its new item's id, or an approved delete whose item is
 * still linked (the link goes null when the item is deleted). An edit cannot be
 * told apart from one applied and edited again since, so it is never flagged.
 */
export function approvalUnconfirmed(
  request: Pick<MenuChangeRequest, 'status' | 'decided_at' | 'action' | 'menu_item_id' | 'target'> & {
    addon_group_id?: string | null;
    applied_at?: string | null;
  },
  now: Date = new Date(),
): boolean {
  if (request.status !== 'approved') return false;
  if (request.applied_at !== undefined) {
    if (request.applied_at !== null) return false;
    const decided = request.decided_at ? new Date(request.decided_at).getTime() : NaN;
    return !Number.isFinite(decided) || now.getTime() - decided > APPLY_GRACE_MS;
  }
  if (request.action === 'create') {
    return request.target === 'addon_group' ? !request.addon_group_id : !request.menu_item_id;
  }
  if (request.action === 'delete') return Boolean(request.menu_item_id);
  return false;
}
