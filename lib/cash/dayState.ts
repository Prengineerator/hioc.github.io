// The cash day's lifecycle, declared in one place: Open → Close → Handover
// (owner request 2026-09-29), the reopen of a mistaken close, and the 3 am
// auto-end of a day nobody closed (owner decision 2026-10-07,
// lib/cash/autoEnd.ts). Pure and framework-free, so the routes
// (app/api/cash-days/**), the 3 am job (app/api/cron/end-cash-day), the
// owner's report and the POS all ask the SAME questions and cannot drift.
// The money rules of a close (variance, ₹0 count, unpaid orders, the handover
// split) stay in lib/cash/day.ts; this file only says which moves are legal,
// for whom, and what "ended" means.
//
// PERSISTED STATUS — cash_days.status (CHECK in supabase/apply-phase3.sql):
//   open    the drawer is in use. At most one at a time (idx_cash_days_one_open).
//   closed  counted and signed off. Not terminal: a mistaken close is undone
//           by a reopen, which puts the SAME row back to open.
//
// DERIVED PHASE of an open day (never stored; the clock is lib/cash/autoEnd.ts):
//   running  before its end — 3:00 am IST the morning after business_date.
//   ended    at/after its end (isCashDayOverdue). Its figures stop at the end,
//            whenever it is counted, and the counter takes no orders until it
//            is closed (cashDayGateStep 'close_overdue').
//
// An ended day comes in two kinds, and they differ in WHO may close it:
//   left open past its end — its current open spell (since it was opened, or
//     since a reopen) began BEFORE the end: nobody closed it in time. The
//     counter is waiting on it and nobody may be around to sign it off, so ANY
//     staffer at the counter may count and close it, over unpaid orders too
//     (with a reason). This is the forgotten-day path the auto-end exists for.
//   reopened after its end — a manager reopened it once it was already over,
//     to correct a close. Nobody forgot it: closing it again needs exactly
//     what any close needs (the cash_day_close permission; a manager or the
//     owner to override unpaid orders). Without this distinction a reopen of
//     yesterday made it "overdue" at once and let a plain staffer close it
//     without the permission and override its unpaid orders.
//
// cash_days.auto_ended_at (2026-10-cash-day-auto-end.sql) RECORDS that the
// current open spell was left open past its end — written by the 3 am job, or
// by the late close when the job had not run; always the end instant. A reopen
// starts a new spell, so it clears the record (the close it undid keeps
// prev_closed_at in reopen_log, which says whether that close came after the
// end). Readers never trust a record older than the last reopen anyway
// (cashDayEndedOnItsOwnAt), so a failed clear cannot make a reopened day read
// "never closed".

import type { CashDayStatus } from '@/lib/types';
import { cashDayEndsAt, isCashDayOverdue } from '@/lib/cash/autoEnd';

export const CASH_DAY_STATUSES = ['open', 'closed'] as const satisfies readonly CashDayStatus[];
// Compile-time: every CashDayStatus (lib/types.ts) is listed above.
const _everyStatusListed: [Exclude<CashDayStatus, (typeof CASH_DAY_STATUSES)[number]>] extends [never] ? true : never = true;
void _everyStatusListed;

export type CashDayPhase = 'running' | 'ended' | 'closed';
export type CashDayAction = 'open' | 'close' | 'reopen' | 'auto_end';

/** The facts about a cash_days row these rules read (a CashDay, a report row …). */
export interface CashDayFacts {
  status: string;
  business_date: string;
  /** The last reopen, if any. Undefined when the reader did not load it — then treated as never reopened. */
  reopened_at?: string | null;
}

export interface CashDayTransition {
  action: CashDayAction;
  /** null = no day is open (the create transition). */
  from: CashDayStatus | null;
  to: CashDayStatus;
  /** Who may, as the routes enforce it. */
  who: string;
  guard: string;
}

/** Every legal move. Anything else is refused by canCashDayTransition. */
export const CASH_DAY_TRANSITIONS: readonly CashDayTransition[] = [
  {
    action: 'open',
    from: null,
    to: 'open',
    who: 'cash_day_open permission (staff by default)',
    guard: 'no day is open (idx_cash_days_one_open backs it); the float is counted against the last close',
  },
  {
    action: 'close',
    from: 'open',
    to: 'closed',
    who: 'cash_day_close permission (manager by default) — or anyone at the counter, for a day left open past its end',
    guard: "status = 'open' at the write (compare-and-set); lib/cash/day.ts evaluateClose",
  },
  {
    action: 'reopen',
    from: 'closed',
    to: 'open',
    who: 'manager or owner (role, not the permission matrix)',
    guard: "the most recent day, nothing open; status = 'closed' at the write",
  },
  {
    action: 'auto_end',
    from: 'open',
    to: 'open',
    who: 'system — the 3 am job, or the late close when the job had not run',
    guard: 'left open past its end; only records auto_ended_at (once)',
  },
];

export function findCashDayTransition(action: CashDayAction): CashDayTransition {
  return CASH_DAY_TRANSITIONS.find((t) => t.action === action) as CashDayTransition;
}

// ── Who ──────────────────────────────────────────────────────────────────────

/**
 * "Manager" for the cash day, by ROLE: manager or owner. Reopens a close,
 * overrides unpaid orders at a close, reads the cash day log. (Closing itself
 * is the cash_day_close permission, which the owner can retune — a different
 * question, resolved by the route with hasPermission() and passed in.)
 */
export function isCashManagerRole(role: string | null | undefined): boolean {
  return role === 'manager' || role === 'owner';
}

// ── When ─────────────────────────────────────────────────────────────────────

/** True when the day's last reopen came at or after its end. */
export function wasReopenedAfterEnd(day: CashDayFacts): boolean {
  if (!day.reopened_at) return false;
  const at = Date.parse(day.reopened_at);
  return Number.isFinite(at) && at >= Date.parse(cashDayEndsAt(day.business_date));
}

/**
 * An OPEN day past its end whose current open spell began before the end:
 * nobody closed it in time. (A day is always opened before its own end — the
 * business date is the IST date it was opened on — so only a reopen can start
 * a spell after it.)
 */
export function isLeftOpenPastEnd(day: CashDayFacts | null | undefined, nowMs: number): boolean {
  return !!day && isCashDayOverdue(day, nowMs) && !wasReopenedAfterEnd(day);
}

export function cashDayPhase(day: CashDayFacts, nowMs: number): CashDayPhase {
  if (day.status !== 'open') return 'closed';
  return isCashDayOverdue(day, nowMs) ? 'ended' : 'running';
}

/**
 * When the day ended on its own, or null. The report, the log and the counter
 * all use this, so "never closed" means the same thing everywhere:
 *  - an open day: the end, once it is left open past it — from the clock, not
 *    from whether the 3 am job has recorded it yet;
 *  - a closed day: the recorded auto_ended_at, unless a reopen after the end
 *    makes it a record of an earlier, undone close.
 */
export function cashDayEndedOnItsOwnAt(
  day: CashDayFacts & { auto_ended_at?: string | null },
  nowMs: number,
): string | null {
  if (day.status === 'open') return isLeftOpenPastEnd(day, nowMs) ? cashDayEndsAt(day.business_date) : null;
  if (!day.auto_ended_at || wasReopenedAfterEnd(day)) return null;
  return day.auto_ended_at;
}

// ── May this actor close this day? ───────────────────────────────────────────

export interface CloseAuthority {
  /** The day was left open past its end (why a plain staffer may close it). */
  leftOpen: boolean;
  mayClose: boolean;
  /** May close it over unpaid orders, given a reason (lib/cash/day.ts unpaidGate). */
  mayOverrideUnpaid: boolean;
}

export function cashDayCloseAuthority(
  day: CashDayFacts | null | undefined,
  actor: { role: string; canClose: boolean },
  nowMs: number,
): CloseAuthority {
  const leftOpen = isLeftOpenPastEnd(day, nowMs);
  return {
    leftOpen,
    mayClose: actor.canClose || leftOpen,
    mayOverrideUnpaid: isCashManagerRole(actor.role) || leftOpen,
  };
}

// ── The check every writer runs ──────────────────────────────────────────────

export type CashDayCheckCode =
  | 'already_open'
  | 'left_open'
  | 'none_open'
  | 'not_closed'
  | 'not_latest'
  | 'forbidden'
  | 'not_ended';

export type CashDayCheck =
  | { ok: true; transition: CashDayTransition }
  | { ok: false; code: CashDayCheckCode; status: 403 | 404 | 409; message: string };

export interface CashDayCheckContext {
  nowMs: number;
  /** The counter actor. Not needed for 'auto_end' (the system). */
  actor?: {
    role: string;
    /** hasPermission(user, 'cash_day_open') — resolved by the route. */
    canOpen?: boolean;
    /** hasPermission(user, 'cash_day_close') — resolved by the route. */
    canClose?: boolean;
  };
  /** reopen: the id the caller asked to reopen, when it named one. */
  requestedId?: string | null;
}

function refuse(code: CashDayCheckCode, status: 403 | 404 | 409, message: string): CashDayCheck {
  return { ok: false, code, status, message };
}

/**
 * Is `action` legal now? `day` is the row the action acts on, as the route
 * read it:
 *   open     — the currently OPEN day, or null (the move needs it to be null);
 *   close    — the currently OPEN day, or null;
 *   reopen   — the most RECENT day of any status (by opened_at), or null;
 *   auto_end — the currently OPEN day, or null.
 * The route then writes with the matching compare-and-set guard, so a race
 * that slips past this check still loses at the database.
 */
export function canCashDayTransition(
  action: CashDayAction,
  day: (CashDayFacts & { id?: string }) | null | undefined,
  ctx: CashDayCheckContext,
): CashDayCheck {
  const transition = findCashDayTransition(action);
  const actor = ctx.actor;
  switch (action) {
    case 'open': {
      if (!actor?.canOpen) return refuse('forbidden', 403, 'You do not have permission to open the cash day');
      if (day && day.status === 'open') {
        return isCashDayOverdue(day, ctx.nowMs)
          ? refuse('left_open', 409, 'The last cash day was never closed — count the drawer and close it first.')
          : refuse('already_open', 409, 'A cash day is already open');
      }
      return { ok: true, transition };
    }
    case 'close': {
      if (!day || day.status !== 'open') return refuse('none_open', 404, 'No cash day is open to close');
      const authority = cashDayCloseAuthority(day, { role: actor?.role ?? '', canClose: !!actor?.canClose }, ctx.nowMs);
      if (!authority.mayClose) {
        return refuse(
          'forbidden',
          403,
          wasReopenedAfterEnd(day) && isCashDayOverdue(day, ctx.nowMs)
            ? 'This day was reopened after it ended — closing it again needs the close permission (a manager by default).'
            : 'You do not have permission to close the cash day',
        );
      }
      return { ok: true, transition };
    }
    case 'reopen': {
      if (!isCashManagerRole(actor?.role)) {
        return refuse('forbidden', 403, 'Only a manager or the owner can reopen a cash day.');
      }
      if (!day) return refuse('none_open', 404, 'There is no cash day to reopen');
      if (day.status !== 'closed') return refuse('not_closed', 409, 'The cash day is already open');
      if (typeof ctx.requestedId === 'string' && day.id !== undefined && ctx.requestedId !== day.id) {
        return refuse('not_latest', 409, 'Only the most recent cash day can be reopened');
      }
      return { ok: true, transition };
    }
    case 'auto_end': {
      if (!day || day.status !== 'open') return refuse('none_open', 404, 'no open day');
      if (!isCashDayOverdue(day, ctx.nowMs)) return refuse('not_ended', 409, 'the open day has not ended yet');
      if (!isLeftOpenPastEnd(day, ctx.nowMs)) {
        return refuse('not_ended', 409, 'the open day was reopened after it ended — it was not left open');
      }
      return { ok: true, transition };
    }
  }
}
