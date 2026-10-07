import { describe, expect, it } from 'vitest';
import {
  CASH_DAY_END_HOUR_IST,
  cashDayEndsAt,
  cashDayGateStep,
  cashDayWindowEnd,
  isCashDayOverdue,
  isGatedStaffPath,
} from '@/lib/cash/autoEnd';

// A cash day nobody closed ends on its own at 3:00 am IST the morning after its
// date (lib/cash/autoEnd.ts); the counter takes no orders until yesterday is
// closed and today is open.

const day = (status: string, business_date = '2026-10-06') => ({ status, business_date });

describe('cashDayEndsAt', () => {
  it('is 3:00 am IST the morning after the date', () => {
    expect(CASH_DAY_END_HOUR_IST).toBe(3);
    expect(cashDayEndsAt('2026-10-06')).toBe('2026-10-06T21:30:00.000Z'); // 03:00 IST on the 7th
    expect(cashDayEndsAt('2026-12-31')).toBe('2026-12-31T21:30:00.000Z'); // across the year
    expect(cashDayEndsAt('2026-02-28')).toBe('2026-02-28T21:30:00.000Z');
  });
});

describe('isCashDayOverdue', () => {
  it('is an open day at or past its 3 am end — after midnight is still the same day', () => {
    expect(isCashDayOverdue(day('open'), Date.parse('2026-10-06T19:00:00.000Z'))).toBe(false); // 00:30 IST
    expect(isCashDayOverdue(day('open'), Date.parse('2026-10-06T21:29:59.000Z'))).toBe(false); // 02:59:59
    expect(isCashDayOverdue(day('open'), Date.parse('2026-10-06T21:30:00.000Z'))).toBe(true); // 03:00
    expect(isCashDayOverdue(day('open'), Date.parse('2026-10-07T10:00:00.000Z'))).toBe(true); // next afternoon
  });

  it('never applies to a closed day or no day', () => {
    expect(isCashDayOverdue(day('closed'), Date.parse('2026-10-09T10:00:00.000Z'))).toBe(false);
    expect(isCashDayOverdue(null, Date.now())).toBe(false);
  });
});

describe('cashDayWindowEnd', () => {
  it('runs to now while the day is going, and stops at 3 am once it has ended', () => {
    expect(cashDayWindowEnd(day('open'), '2026-10-06T19:00:00.000Z')).toBe('2026-10-06T19:00:00.000Z');
    expect(cashDayWindowEnd(day('open'), '2026-10-07T10:00:00.000Z')).toBe('2026-10-06T21:30:00.000Z');
  });
});

describe('cashDayGateStep', () => {
  it('asks to open with no day, to close a day left open, and nothing while a day runs', () => {
    expect(cashDayGateStep(null, Date.parse('2026-10-07T05:00:00.000Z'))).toBe('open');
    expect(cashDayGateStep(day('open'), Date.parse('2026-10-06T19:00:00.000Z'))).toBeNull();
    expect(cashDayGateStep(day('open'), Date.parse('2026-10-07T05:00:00.000Z'))).toBe('close_overdue');
  });
});

describe('isGatedStaffPath', () => {
  it('locks the POS screens', () => {
    for (const p of ['/staff', '/staff/orders/new', '/staff/tables', '/staff/settle', '/staff/expenses', '/staff/cash-movements']) {
      expect(isGatedStaffPath(p)).toBe(true);
    }
  });

  it('leaves the cash drawer, attendance, leave and setup pages usable', () => {
    for (const p of ['/staff/cash', '/staff/attendance', '/staff/leave', '/staff/settings/printers', '/staff/device', '/staff/printers', '/staff/login']) {
      expect(isGatedStaffPath(p)).toBe(false);
    }
    expect(isGatedStaffPath('/owner/reports')).toBe(false); // not a staff page at all
  });
});
