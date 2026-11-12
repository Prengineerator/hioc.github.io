import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_SESSION_STATUSES,
  SESSION_TRANSITIONS,
  canApproveSession,
  canEditSessionTimes,
  canSessionTransition,
  canVoidSession,
  sessionIsUnresolved,
  sessionNeedsApproval,
  type SessionAction,
  type SessionStatus,
} from '@/lib/attendance/sessionState';
import { rollUpDay } from '@/lib/attendance/day';
import {
  LEAVE_STATUSES,
  canApproveLeave,
  canDeclineLeave,
  canLeaveTransition,
  canRequestLeave,
  canWithdrawLeave,
  leaveFromStatuses,
  type LeaveAction,
} from '@/lib/leave/state';
import { SHORTAGE_STATUSES, canDecideShortage, canShortageTransition, isShortageLocked } from '@/lib/cash/counts';
import {
  PAYROLL_RUN_STATUSES,
  STORED_PAYROLL_RUN_STATUSES,
  canPayrollRunTransition,
  canReversePayrollRun,
} from '@/lib/payroll/runState';
import { employmentState, planEmploymentChange } from '@/lib/attendance/employmentState';
import { isDateLocked, lockingRunFor, lockingRunInRange, lockedMonthLabel, type LockingRun } from '@/lib/payroll/lock';
import type { LeaveStatus } from '@/lib/types';

// The five staff-ops machines (attendance session, cash shortage, leave
// request, payroll run, employment record) and the shared payroll lock, as
// pure tables. Route-level behaviour is in attendanceSessionsRoute,
// ownerCashShortages, leaveRoutes, payrollRoutes and ownerEmploymentRoute.

describe('attendance session machine', () => {
  const legal = (from: SessionStatus | null, action: SessionAction, approvedAt: string | null = null) =>
    canSessionTransition(from === null ? null : { status: from, approvedAt }, action).ok;

  it('approve is legal ONLY for an unapproved auto-close — exactly where the sheet offers it', () => {
    for (const s of ATTENDANCE_SESSION_STATUSES) expect(legal(s, 'approve')).toBe(s === 'auto_closed');
    expect(legal('auto_closed', 'approve', '2026-08-07T00:00:00Z')).toBe(false);
  });

  it('void is legal from everything but void', () => {
    for (const s of ATTENDANCE_SESSION_STATUSES) expect(legal(s, 'void')).toBe(s !== 'void');
  });

  it('a time edit never starts from void, and only resolves to closed (or stays open)', () => {
    expect(canEditSessionTimes({ status: 'void', approved_at: null })).toBe(false);
    for (const t of SESSION_TRANSITIONS.filter((r) => r.action === 'edit_times')) {
      expect(t.from).not.toBe('void');
      expect(['open', 'closed']).toContain(t.to);
    }
    expect(canSessionTransition({ status: 'closed' }, 'edit_times', { to: 'open' }).ok).toBe(false);
  });

  it('only a correction that resolves the session stamps approval; auto-close clears it', () => {
    const stamp = (action: SessionAction, from: SessionStatus | null, to?: SessionStatus) =>
      SESSION_TRANSITIONS.find((t) => t.action === action && t.from === from && (!to || t.to === to))?.approval;
    expect(stamp('edit_times', 'open', 'open')).toBeUndefined();
    expect(stamp('edit_times', 'open', 'closed')).toBe(true);
    expect(stamp('edit_times', 'auto_closed', 'closed')).toBe(true);
    expect(stamp('auto_close', 'open')).toBe(false);
    expect(stamp('manual_entry', null)).toBe(true);
  });

  it('void is terminal — no rule leaves it', () => {
    expect(SESSION_TRANSITIONS.some((t) => t.from === 'void')).toBe(false);
  });

  it('cron and punch are the only ways out of open other than void/edit', () => {
    expect(legal('open', 'auto_close')).toBe(true);
    expect(legal('open', 'clock_out')).toBe(true);
    expect(legal('closed', 'auto_close')).toBe(false);
    expect(legal('auto_closed', 'clock_out')).toBe(false);
  });

  it('one "needs approval" predicate, shared by day.ts, /me and the sheet', () => {
    expect(sessionNeedsApproval('auto_closed', null)).toBe(true);
    expect(sessionNeedsApproval('auto_closed', 'x')).toBe(false);
    expect(sessionNeedsApproval('open', null)).toBe(false);
    expect(sessionIsUnresolved('open', 'x')).toBe(true);
    expect(sessionIsUnresolved('closed', null)).toBe(false);
    expect(canApproveSession({ status: 'auto_closed', approved_at: null })).toBe(true);
    expect(canVoidSession({ status: 'void', approved_at: null })).toBe(false);
  });

  it('an open session carrying an (illegal) approval stamp still pays nothing until it is closed', () => {
    const r = rollUpDay({
      date: '2026-08-06',
      sessions: [
        { id: 's', clockInAt: '2026-08-06T04:30:00Z', clockOutAt: null, status: 'open', source: 'punch', approvedAt: 'x', flags: [] },
      ],
      rules: { gracePeriodMin: 0, otThresholdMin: 0, autoBreakMin: 0, autoBreakAfterMin: 0, halfDayMinMinutes: 240, absentBelowMinutes: 120 },
      employment: { contractedHoursPerDay: 9, shiftStartTime: '10:00', shiftEndTime: '19:00', weeklyOffDow: 0 },
      dayOfWeek: 4,
    });
    expect(r.needsApproval).toBe(true);
    expect(r.workedMinutes).toBe(0);
  });
});

describe('leave request machine', () => {
  const ok = (from: LeaveStatus | null, action: LeaveAction) => canLeaveTransition(from, action).ok;

  it('a staffer may ask for a fresh, declined or withdrawn day — never re-open an approved one', () => {
    expect(ok(null, 'request')).toBe(true);
    expect(ok('declined', 'request')).toBe(true);
    expect(ok('withdrawn', 'request')).toBe(true);
    expect(ok('requested', 'request')).toBe(true);
    expect(ok('approved', 'request')).toBe(false);
  });

  it('a staffer may withdraw only a pending request', () => {
    for (const s of LEAVE_STATUSES) expect(ok(s, 'withdraw')).toBe(s === 'requested');
    expect(leaveFromStatuses('withdraw')).toEqual(['requested']);
  });

  it('a manager decides requested, and may flip approved ↔ declined; withdrawn is not theirs', () => {
    expect(ok('requested', 'approve')).toBe(true);
    expect(ok('declined', 'approve')).toBe(true);
    expect(ok('approved', 'approve')).toBe(false);
    expect(ok('withdrawn', 'approve')).toBe(false);
    expect(ok('requested', 'decline')).toBe(true);
    expect(ok('approved', 'decline')).toBe(true);
    expect(ok('declined', 'decline')).toBe(false);
    expect(ok('withdrawn', 'decline')).toBe(false);
  });

  it('a decline needs a note', () => {
    expect(canLeaveTransition('requested', 'decline', { note: '  ' }).code).toBe('note_required');
  });

  it('UI helpers match the table (and the planner buttons they replaced)', () => {
    expect(canRequestLeave(undefined)).toBe(true);
    expect(canWithdrawLeave('approved')).toBe(false);
    expect(canApproveLeave('declined')).toBe(true);
    expect(canDeclineLeave('approved')).toBe(true);
    expect(canDeclineLeave('declined')).toBe(false);
  });
});

describe('cash shortage machine', () => {
  it('only a pending, unconsumed shortage can be decided', () => {
    for (const status of SHORTAGE_STATUSES) {
      for (const action of ['approve', 'waive', 'reassign'] as const) {
        expect(canShortageTransition({ status, payrollRunId: null }, action).ok).toBe(status === 'pending');
      }
    }
  });

  it('a decided shortage says what it already was; a paid-out one says it is paid out', () => {
    expect(canShortageTransition({ status: 'waived', payrollRunId: null }, 'approve').message).toMatch(/already waived/);
    expect(canShortageTransition({ status: 'approved', payrollRunId: 'run' }, 'waive').message).toMatch(/paid out/);
  });

  it('payroll consumes an approved, unconsumed row and releases a consumed one', () => {
    expect(canShortageTransition({ status: 'approved', payrollRunId: null }, 'consume').ok).toBe(true);
    expect(canShortageTransition({ status: 'approved', payrollRunId: 'r' }, 'consume').ok).toBe(false);
    expect(canShortageTransition({ status: 'pending', payrollRunId: null }, 'consume').ok).toBe(false);
    expect(canShortageTransition({ status: 'approved', payrollRunId: 'r' }, 'release').ok).toBe(true);
    expect(canShortageTransition({ status: 'approved', payrollRunId: null }, 'release').ok).toBe(false);
  });

  it('UI helpers', () => {
    expect(canDecideShortage({ status: 'pending', payrollRunId: null })).toBe(true);
    expect(isShortageLocked({ payroll_run_id: 'r' })).toBe(true);
    expect(isShortageLocked({ payroll_run_id: null })).toBe(false);
  });
});

describe('payroll run machine', () => {
  it("'draft' is declared but never stored", () => {
    expect(PAYROLL_RUN_STATUSES).toContain('draft');
    expect(STORED_PAYROLL_RUN_STATUSES).not.toContain('draft');
    expect(canPayrollRunTransition(null, 'finalize').rule?.to).toBe('finalized');
  });

  it('finalized → reversed (with a reason) is the only move; reversed is terminal', () => {
    expect(canPayrollRunTransition('finalized', 'reverse', { reason: 'wrong rate' }).ok).toBe(true);
    expect(canPayrollRunTransition('finalized', 'reverse', { reason: ' ' }).code).toBe('reason_required');
    expect(canPayrollRunTransition('reversed', 'reverse', { reason: 'x' }).ok).toBe(false);
    expect(canPayrollRunTransition('finalized', 'finalize').ok).toBe(false);
    expect(canPayrollRunTransition('draft', 'reverse', { reason: 'x' }).ok).toBe(false);
    expect(canReversePayrollRun('finalized')).toBe(true);
    expect(canReversePayrollRun(null)).toBe(false);
  });
});

describe('employment record machine', () => {
  it('current while effective_to is null', () => {
    expect(employmentState({ effective_to: null })).toBe('current');
    expect(employmentState({ effective_to: '2026-10-01' })).toBe('closed');
  });

  it('a new record must start after the current one; closed rows are ignored', () => {
    const rows = [
      { id: 'a', effective_from: '2026-01-01', effective_to: '2026-05-01' },
      { id: 'b', effective_from: '2026-05-01', effective_to: null },
    ];
    expect(planEmploymentChange(rows, '2026-09-01')).toEqual({ ok: true, toClose: ['b'] });
    expect(planEmploymentChange(rows, '2026-05-01').ok).toBe(false);
  });
});

describe('payroll lock predicate', () => {
  const runs: LockingRun[] = [
    { id: 'aug', user_id: 'u1', status: 'finalized', period_start: '2026-08-01', period_end: '2026-08-31' },
    { id: 'jul', user_id: 'u1', status: 'reversed', period_start: '2026-07-01', period_end: '2026-07-31' },
    { id: 'sep', user_id: 'u2', status: 'finalized', period_start: '2026-09-01', period_end: '2026-09-30' },
  ];

  it('a finalized run of THIS person locks its days, inclusive of both ends', () => {
    expect(isDateLocked(runs, '2026-08-01', 'u1')).toBe(true);
    expect(isDateLocked(runs, '2026-08-31', 'u1')).toBe(true);
    expect(isDateLocked(runs, '2026-09-01', 'u1')).toBe(false);
  });

  it('a reversed run, or another person’s run, locks nothing', () => {
    expect(isDateLocked(runs, '2026-07-15', 'u1')).toBe(false);
    expect(lockingRunFor(runs, '2026-09-10', 'u1')).toBeNull();
    expect(lockingRunFor(runs, '2026-09-10', 'u2')?.id).toBe('sep');
  });

  it('a range lock finds any finalized month on or after a date', () => {
    expect(lockingRunInRange(runs, '2026-06-15', undefined, 'u1')?.id).toBe('aug');
    expect(lockingRunInRange(runs, '2026-09-01', undefined, 'u1')).toBeNull();
  });

  it('labels the month for the refusal', () => {
    expect(lockedMonthLabel(runs[0])).toMatch(/August 2026/);
  });
});
