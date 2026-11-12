// A HIOC Ritual pass's life (docs/COFFEE-PASS-SPEC.md CP-D5, D14-D16). Pure:
// no server-only import, so the staff and customer screens ask the same
// questions the routes and the database do.
//
// Two layers. The STORED status (coffee_passes.status, CHECK active / refunded
// / void) is what the database writes, always inside a function or trigger
// that locks the pass row first. The STATE a screen shows (PassState) adds two
// that are DERIVED, never written: v_coffee_pass_balances computes them, and
// passState() in rules.ts mirrors that.
//
//   stored          (issue) ──▶ active ◀──restore after failed refund── refunded
//                                  └────void for refund / sale refunded──▶ ┘
//   derived, while  active ⇄ used_up    (last cup spent ⇄ a cup given back or
//   active:                              a redemption reversed)
//                   active / used_up ⇄ expired   (expires_at passes ⇄ extended)
//
// 'void' has NO writer. The CHECK allows it and every reader handles it (it
// reads as "Cancelled" and can't be spent or changed), but nothing in the
// database or the app sets it: a refunded pass is 'refunded'. It is kept so a
// future "cancel this pass" needs no schema change.

import type { PassState } from './types';

export const PASS_STORED_STATUSES = ['active', 'refunded', 'void'] as const;
export type PassStoredStatus = (typeof PASS_STORED_STATUSES)[number];

export const PASS_STATES = ['active', 'used_up', 'expired', 'refunded', 'void'] as const satisfies readonly PassState[];

// Every PassState is listed above: one added to the type but not here fails to compile.
const everyStateListed: Exclude<PassState, (typeof PASS_STATES)[number]> extends never ? true : never = true;
void everyStateListed;

/** The states computed from cups and dates; a stored status is never one of these. */
export const DERIVED_PASS_STATES = ['used_up', 'expired'] as const satisfies readonly PassState[];

/** No stored transition leaves 'void'. ('refunded' can go back to 'active' while the refund's money step is unwound.) */
export const PASS_TERMINAL_STATUSES: readonly PassStoredStatus[] = ['void'];

/** Who writes a stored status: always a SECURITY DEFINER function or trigger, under a row lock. */
export type PassStatusWriter =
  | 'coffee_pass_issue_on_paid' //               trigger: the sale order becomes paid
  | 'coffee_pass_void_for_refund' //             a refund route, BEFORE money moves (CP-D15)
  | 'coffee_pass_return_on_order' //             trigger: the sale order is fully refunded (safety net)
  | 'coffee_pass_restore_after_failed_refund'; // a refund route, when the money step failed

export interface PassStatusTransition {
  /** null = the pass is created. */
  from: PassStoredStatus | null;
  to: PassStoredStatus;
  writer: PassStatusWriter;
  /** What the writer requires, in its own words (it checks it under the lock). */
  when: string;
}

export const PASS_STATUS_TRANSITIONS: readonly PassStatusTransition[] = [
  {
    from: null,
    to: 'active',
    writer: 'coffee_pass_issue_on_paid',
    when: 'the sale order becomes paid, has an account, and (with supabase/2026-11-peripheral-money-state-machine.sql) is not cancelled or rejected',
  },
  { from: 'active', to: 'refunded', writer: 'coffee_pass_void_for_refund', when: 'no cup has been spent (a non-reversed redemption refuses it)' },
  { from: 'active', to: 'refunded', writer: 'coffee_pass_return_on_order', when: "the sale order's payment_status becomes 'refunded'" },
  { from: 'refunded', to: 'active', writer: 'coffee_pass_restore_after_failed_refund', when: "the sale order is still 'paid' (the money did not move)" },
];

export type PassTransitionCheck = { ok: true; rule: PassStatusTransition } | { ok: false; code: 'not_allowed'; message: string };

/** Whether the stored status may go `from` → `to` (by `writer`, when given). */
export function canTransitionPassStatus(
  from: PassStoredStatus | null,
  to: PassStoredStatus,
  writer?: PassStatusWriter,
): PassTransitionCheck {
  const rule = PASS_STATUS_TRANSITIONS.find((t) => t.from === from && t.to === to && (!writer || t.writer === writer));
  if (!rule) return { ok: false, code: 'not_allowed', message: `A pass can't go from ${from ?? '(new)'} to ${to}${writer ? ` by ${writer}` : ''}.` };
  return { ok: true, rule };
}

/** The writers that exist for a status: [] for 'void', which nothing sets. */
export function writersOf(to: PassStoredStatus): PassStatusWriter[] {
  return PASS_STATUS_TRANSITIONS.filter((t) => t.to === to).map((t) => t.writer);
}

/**
 * Whether a manager may extend a pass or give a cup back (coffee_pass_adjust,
 * which refuses anything else as 'inactive'): a pass whose stored status is
 * active, whatever its cups or dates — a used-up or lapsed one is exactly when
 * a manager needs to.
 */
export function canAdjustPass(pass: { status: PassStoredStatus }): boolean {
  return pass.status === 'active';
}
