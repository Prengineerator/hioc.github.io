import { describe, expect, it } from 'vitest';
import {
  CASH_DAY_STATUSES,
  CASH_DAY_TRANSITIONS,
  canCashDayTransition,
  cashDayCloseAuthority,
  cashDayEndedOnItsOwnAt,
  cashDayPhase,
  isCashManagerRole,
  isLeftOpenPastEnd,
  wasReopenedAfterEnd,
} from '@/lib/cash/dayState';
import { isCashDayOverdue } from '@/lib/cash/autoEnd';

// The cash day lifecycle (lib/cash/dayState.ts), no mocks: the transition
// table, who may close a day that has ended, and the one "ended on its own"
// rule the counter, the 3 am job and the owner's report share. The routes
// that write through it are exercised end-to-end in cashDays.test.ts.

const DATE = '2026-10-06';
const ENDS_AT = '2026-10-06T21:30:00.000Z'; // 3:00 am IST on the 7th
const BEFORE_END = Date.parse('2026-10-06T19:00:00.000Z'); // 12:30 am IST
const NEXT_MORNING = Date.parse('2026-10-07T04:30:00.000Z'); // 10:00 am IST

const day = (over: { status?: string; reopened_at?: string | null; auto_ended_at?: string | null; id?: string } = {}) => ({
  id: 'cd-1',
  status: 'open',
  business_date: DATE,
  reopened_at: null,
  ...over,
});

describe('the table', () => {
  it('lists every status and exactly the four moves', () => {
    expect([...CASH_DAY_STATUSES]).toEqual(['open', 'closed']);
    expect(CASH_DAY_TRANSITIONS.map((t) => [t.action, t.from, t.to])).toEqual([
      ['open', null, 'open'],
      ['close', 'open', 'closed'],
      ['reopen', 'closed', 'open'],
      ['auto_end', 'open', 'open'],
    ]);
  });

  it('"manager" for the cash day is the manager or owner role', () => {
    expect(isCashManagerRole('manager')).toBe(true);
    expect(isCashManagerRole('owner')).toBe(true);
    expect(isCashManagerRole('staff')).toBe(false);
    expect(isCashManagerRole(undefined)).toBe(false);
  });
});

describe('phase and "left open past its end"', () => {
  it('an open day runs until 3 am the morning after, then has ended', () => {
    expect(cashDayPhase(day(), BEFORE_END)).toBe('running');
    expect(cashDayPhase(day(), NEXT_MORNING)).toBe('ended');
    expect(cashDayPhase(day({ status: 'closed' }), NEXT_MORNING)).toBe('closed');
  });

  it('an ended day nobody reopened was left open; one reopened after the end was not', () => {
    expect(isLeftOpenPastEnd(day(), NEXT_MORNING)).toBe(true);
    const reopenedLate = day({ reopened_at: '2026-10-07T04:00:00.000Z' });
    expect(wasReopenedAfterEnd(reopenedLate)).toBe(true);
    expect(isCashDayOverdue(reopenedLate, NEXT_MORNING)).toBe(true); // it HAS ended (window, gate)…
    expect(isLeftOpenPastEnd(reopenedLate, NEXT_MORNING)).toBe(false); // …but nobody forgot it
    // Reopened before the end, then forgotten: left open after all.
    const reopenedEarly = day({ reopened_at: '2026-10-06T18:00:00.000Z' });
    expect(wasReopenedAfterEnd(reopenedEarly)).toBe(false);
    expect(isLeftOpenPastEnd(reopenedEarly, NEXT_MORNING)).toBe(true);
    // Reopened at the very instant of the end counts as after it.
    expect(wasReopenedAfterEnd(day({ reopened_at: ENDS_AT }))).toBe(true);
  });

  it('a running day, a closed day and no day are never left open', () => {
    expect(isLeftOpenPastEnd(day(), BEFORE_END)).toBe(false);
    expect(isLeftOpenPastEnd(day({ status: 'closed' }), NEXT_MORNING)).toBe(false);
    expect(isLeftOpenPastEnd(null, NEXT_MORNING)).toBe(false);
  });
});

describe('cashDayEndedOnItsOwnAt — the report and the counter agree', () => {
  it('an open day left open past its end ended at 3 am, recorded by the job or not', () => {
    expect(cashDayEndedOnItsOwnAt(day(), NEXT_MORNING)).toBe(ENDS_AT);
    expect(cashDayEndedOnItsOwnAt(day({ auto_ended_at: ENDS_AT }), NEXT_MORNING)).toBe(ENDS_AT);
    expect(cashDayEndedOnItsOwnAt(day(), BEFORE_END)).toBeNull();
  });

  it('a day reopened after its end did not end on its own, even with a stale record', () => {
    const reopened = day({ reopened_at: '2026-10-07T04:00:00.000Z', auto_ended_at: ENDS_AT });
    expect(cashDayEndedOnItsOwnAt(reopened, NEXT_MORNING)).toBeNull();
    expect(cashDayEndedOnItsOwnAt({ ...reopened, status: 'closed' }, NEXT_MORNING)).toBeNull();
  });

  it('a closed day keeps its recorded auto-end', () => {
    expect(cashDayEndedOnItsOwnAt(day({ status: 'closed', auto_ended_at: ENDS_AT }), NEXT_MORNING)).toBe(ENDS_AT);
    expect(cashDayEndedOnItsOwnAt(day({ status: 'closed', auto_ended_at: null }), NEXT_MORNING)).toBeNull();
  });
});

describe('cashDayCloseAuthority', () => {
  const staff = { role: 'staff', canClose: false };
  it('a running day needs the close permission, and a manager to override unpaid orders', () => {
    expect(cashDayCloseAuthority(day(), staff, BEFORE_END)).toEqual({ leftOpen: false, mayClose: false, mayOverrideUnpaid: false });
    expect(cashDayCloseAuthority(day(), { role: 'staff', canClose: true }, BEFORE_END).mayClose).toBe(true);
    expect(cashDayCloseAuthority(day(), { role: 'manager', canClose: true }, BEFORE_END).mayOverrideUnpaid).toBe(true);
  });

  it('a day left open past its end: anyone at the counter closes it, over unpaid orders too', () => {
    expect(cashDayCloseAuthority(day(), staff, NEXT_MORNING)).toEqual({ leftOpen: true, mayClose: true, mayOverrideUnpaid: true });
  });

  it('a day reopened after its end: exactly the running-day rules (the privilege gap)', () => {
    const reopened = day({ reopened_at: '2026-10-07T04:00:00.000Z' });
    expect(cashDayCloseAuthority(reopened, staff, NEXT_MORNING)).toEqual({ leftOpen: false, mayClose: false, mayOverrideUnpaid: false });
    expect(cashDayCloseAuthority(reopened, { role: 'manager', canClose: true }, NEXT_MORNING)).toMatchObject({
      mayClose: true,
      mayOverrideUnpaid: true,
    });
  });
});

describe('canCashDayTransition', () => {
  const now = BEFORE_END;

  it('open: needs the permission and no open day; says when the open day was never closed', () => {
    expect(canCashDayTransition('open', null, { nowMs: now, actor: { role: 'staff', canOpen: true } }).ok).toBe(true);
    expect(canCashDayTransition('open', null, { nowMs: now, actor: { role: 'staff', canOpen: false } })).toMatchObject({
      ok: false,
      code: 'forbidden',
      status: 403,
    });
    expect(canCashDayTransition('open', day(), { nowMs: now, actor: { role: 'staff', canOpen: true } })).toMatchObject({
      ok: false,
      code: 'already_open',
      status: 409,
    });
    expect(canCashDayTransition('open', day(), { nowMs: NEXT_MORNING, actor: { role: 'staff', canOpen: true } })).toMatchObject({
      ok: false,
      code: 'left_open',
      message: expect.stringMatching(/never closed/),
    });
  });

  it('close: 404 with nothing open; 403 without authority; the reopened-late refusal says why', () => {
    expect(canCashDayTransition('close', null, { nowMs: now, actor: { role: 'staff', canClose: true } })).toMatchObject({ status: 404 });
    expect(canCashDayTransition('close', day({ status: 'closed' }), { nowMs: now, actor: { role: 'owner', canClose: true } })).toMatchObject({
      status: 404,
    });
    expect(canCashDayTransition('close', day(), { nowMs: now, actor: { role: 'staff', canClose: false } })).toMatchObject({
      code: 'forbidden',
      message: 'You do not have permission to close the cash day',
    });
    expect(canCashDayTransition('close', day(), { nowMs: NEXT_MORNING, actor: { role: 'staff', canClose: false } }).ok).toBe(true);
    const reopened = day({ reopened_at: '2026-10-07T04:00:00.000Z' });
    expect(canCashDayTransition('close', reopened, { nowMs: NEXT_MORNING, actor: { role: 'staff', canClose: false } })).toMatchObject({
      code: 'forbidden',
      message: expect.stringMatching(/reopened after it ended/),
    });
  });

  it('reopen: a manager/owner, the latest day, still closed', () => {
    const closed = day({ status: 'closed' });
    expect(canCashDayTransition('reopen', closed, { nowMs: now, actor: { role: 'manager' } }).ok).toBe(true);
    expect(canCashDayTransition('reopen', closed, { nowMs: now, actor: { role: 'staff' } })).toMatchObject({ status: 403 });
    expect(canCashDayTransition('reopen', null, { nowMs: now, actor: { role: 'owner' } })).toMatchObject({ status: 404 });
    expect(canCashDayTransition('reopen', day(), { nowMs: now, actor: { role: 'owner' } })).toMatchObject({ code: 'not_closed' });
    expect(canCashDayTransition('reopen', closed, { nowMs: now, actor: { role: 'owner' }, requestedId: 'cd-0' })).toMatchObject({
      code: 'not_latest',
    });
    expect(canCashDayTransition('reopen', closed, { nowMs: now, actor: { role: 'owner' }, requestedId: 'cd-1' }).ok).toBe(true);
  });

  it('auto_end: only a day left open past its end', () => {
    expect(canCashDayTransition('auto_end', day(), { nowMs: NEXT_MORNING }).ok).toBe(true);
    expect(canCashDayTransition('auto_end', day(), { nowMs: now })).toMatchObject({ code: 'not_ended' });
    expect(canCashDayTransition('auto_end', null, { nowMs: NEXT_MORNING })).toMatchObject({ code: 'none_open' });
    expect(
      canCashDayTransition('auto_end', day({ reopened_at: '2026-10-07T04:00:00.000Z' }), { nowMs: NEXT_MORNING }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/reopened after it ended/) });
  });
});
