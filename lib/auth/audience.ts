// Which door does an account belong to?
//
// One Supabase user pool serves three surfaces, and until now one login page
// served two of them: /staff/login established owner sessions as readily as
// staff ones. That is convenient and wrong — the owner's dashboard reaches
// payroll and salary, and a counter tablet's login screen should not be able to
// open it.
//
// So each surface gets its own entrance, and an entrance only admits the role
// it is for. Pure, because the rule is worth asserting in tests rather than
// re-reading three route handlers to work out who can get in where.

import type { UserRole } from '@/lib/types';

/** The three surfaces, each with its own login page. */
export type LoginAudience = 'customer' | 'staff' | 'owner';

export const AUDIENCE_LOGIN_PATH: Record<LoginAudience, string> = {
  customer: '/login',
  staff: '/staff/login',
  owner: '/owner/login',
};

/**
 * The single door an account may use.
 *
 * `manager` maps to the staff door on purpose: a manager runs the floor and
 * uses the counter, and the elevated things they can do (voids, comps, refunds,
 * attendance approval) are gated per-action by hasPermission() rather than by
 * which page they signed in on. Only the owner — the one role that sees money
 * at rest — gets a separate entrance.
 */
export function audienceForRole(role: UserRole | null): LoginAudience {
  if (role === 'owner') return 'owner';
  if (role === 'staff' || role === 'manager') return 'staff';
  return 'customer';
}

export function isValidAudience(value: unknown): value is LoginAudience {
  return value === 'customer' || value === 'staff' || value === 'owner';
}

const AUDIENCE_LABEL: Record<LoginAudience, string> = {
  customer: 'the customer sign-in',
  staff: 'the staff portal',
  owner: 'the owner dashboard',
};

/**
 * What to tell someone who used the wrong door.
 *
 * Names the right one rather than saying "access denied", because the common
 * case is an owner tapping the counter tablet's bookmark, not an attacker — and
 * a refusal with no next step reads as the login being broken.
 */
export function wrongDoorMessage(actual: LoginAudience, attempted: LoginAudience): string {
  return `That account belongs to ${AUDIENCE_LABEL[actual]}. Sign in at ${AUDIENCE_LOGIN_PATH[actual]} instead.`;
}

/** True when `role` may sign in at the page serving `attempted`. */
export function mayUseDoor(role: UserRole | null, attempted: LoginAudience): boolean {
  return audienceForRole(role) === attempted;
}
