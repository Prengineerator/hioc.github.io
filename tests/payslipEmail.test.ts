import { describe, expect, it } from 'vitest';
import { renderPayslipEmail } from '@/lib/payroll/payslipEmail';
import type { PayrollRun, PayrollRunLine } from '@/lib/types';

// SA-5 — renderPayslipEmail is pure: it reads only the FROZEN
// payroll_run_lines columns (+ the run's period) and never recomputes
// anything. These tests pin the values it shows, its Indian-format money
// (paise never touches this layer — it reads whole-rupee columns), and that
// attacker-influenced text (a staffer's display name) is escaped in the HTML
// but left readable in the plain-text part.

function line(overrides: Partial<PayrollRunLine> = {}): PayrollRunLine {
  return {
    id: 'line-1',
    run_id: 'run-1',
    user_id: 'user-1',
    monthly_salary_inr: 25_000,
    contracted_hours_per_day: 9,
    per_minute_paise: 100,
    days_present: 20,
    days_half: 1,
    days_absent: 0,
    days_off: 4,
    days_paid_leave: 1,
    worked_minutes: 10_800,
    ot_minutes: 0,
    late_marks: 0,
    base_pay_inr: 24_000,
    ot_pay_inr: 0,
    deductions_inr: 0,
    cash_shortage_inr: 0,
    adjustments_inr: 0,
    net_pay_inr: 24_000,
    detail: {},
    ...overrides,
  };
}

const run: Pick<PayrollRun, 'period_start' | 'period_end'> = {
  period_start: '2026-08-01',
  period_end: '2026-08-31',
};

describe('renderPayslipEmail', () => {
  it('names the month from the run period', () => {
    const { subject, html, text } = renderPayslipEmail(line(), run, 'Ravi Kumar');
    expect(subject).toContain('August 2026');
    expect(html).toContain('August 2026');
    expect(text).toContain('August 2026');
  });

  it('shows net pay in ₹ with Indian digit grouping', () => {
    const { html, text } = renderPayslipEmail(line({ net_pay_inr: 123_456 }), run, 'Ravi');
    expect(html).toContain('₹1,23,456');
    expect(text).toContain('Net pay: ₹1,23,456');
  });

  it('carries days present/half/absent/off/paid-leave and hours worked', () => {
    const { text } = renderPayslipEmail(
      line({
        days_present: 22,
        days_half: 2,
        days_absent: 1,
        days_off: 4,
        days_paid_leave: 1,
        worked_minutes: 9 * 60 + 30,
      }),
      run,
      'Ravi',
    );
    expect(text).toContain('Days present: 22');
    expect(text).toContain('Half days: 2');
    expect(text).toContain('Absent: 1');
    expect(text).toContain('Weekly off: 4');
    expect(text).toContain('Paid leave: 1');
    expect(text).toContain('Hours worked: 9h 30m');
  });

  it('never breaks out overtime or late marks — one pay line for all hours worked', () => {
    const { html, text } = renderPayslipEmail(
      line({ worked_minutes: 600, ot_minutes: 90, base_pay_inr: 24_000, ot_pay_inr: 500, late_marks: 2, net_pay_inr: 24_500 }),
      run,
      'Ravi',
    );
    for (const out of [html, text]) {
      expect(out).not.toMatch(/Overtime/i);
      expect(out).not.toMatch(/Late marks/i);
      expect(out).not.toMatch(/Base pay/);
    }
    // Older runs without the frozen pre-deduction total fall back to base + OT.
    expect(text).toContain('Pay for hours worked (10h 0m): ₹24,500');
  });

  it('takes the pay line from the frozen pre-deduction total so it adds up to net', () => {
    const { text } = renderPayslipEmail(
      line({
        base_pay_inr: 18_163,
        ot_pay_inr: 3_990,
        deductions_inr: 369,
        adjustments_inr: -500,
        net_pay_inr: 21_284,
        detail: { net_before_deductions_inr: 21_653, adjustment_reason: 'Advance' },
      }),
      run,
      'Umesh Kumar',
    );
    // 22,153 earned − 500 advance − 369 lateness = 21,284.
    expect(text).toContain('₹22,153');
    expect(text).toContain('Deductions (lateness): −₹369');
    expect(text).toContain('Adjustment — Advance: −₹500');
    expect(text).toContain('Net pay: ₹21,284');
  });

  it('lists every day with its counted clock-in, clock-out and hours, in IST', () => {
    const { html, text } = renderPayslipEmail(
      line({
        worked_minutes: 648 + 549,
        detail: {
          days: [
            // 09:59 punch rounded to 10:00 IST; out 20:47:51 IST shows as 20:48.
            { date: '2026-10-03', status: 'present', worked: 648, in: '2026-10-03T04:30:00.000Z', out: '2026-10-03T15:17:51.384Z' },
            // Shift past midnight: 15:03:02 → 00:11:54 IST shows as 15:03 → 00:12.
            { date: '2026-10-01', status: 'present', worked: 549, in: '2026-10-01T09:33:02.786Z', out: '2026-10-01T18:41:54.113Z' },
            { date: '2026-10-23', status: 'absent', worked: 0, in: null, out: null },
            { date: '2026-10-07', status: 'weekly_off', worked: 0, in: null, out: null },
            { date: '2026-09-30', status: 'not_employed', worked: 0, in: null, out: null },
          ],
        },
      }),
      run,
      'Umesh',
    );
    expect(text).toContain('Day by day:');
    // Each row adds up: in – out = the hours counted.
    expect(text).toContain('Sat 3 Oct: 10:00 – 20:48 = 10h 48m');
    expect(text).toContain('Thu 1 Oct: 15:03 – 00:12 = 9h 9m');
    expect(text).toContain('Fri 23 Oct: Absent');
    expect(text).toContain('Wed 7 Oct: Weekly off');
    expect(text).not.toContain('30 Sept');
    expect(text).toContain('Total: 19h 57m');
    expect(html).toContain('Day by day');
    expect(html).toContain('20:48');
  });

  it('makes every row add up even when rounding the two ends separately would not', () => {
    // 15:02:17 → 00:09:33 IST is 9h 7m 16s, counted as 9h 7m. Rounding each end
    // alone would print 15:02 → 00:10 (9h 8m).
    const { text } = renderPayslipEmail(
      line({
        worked_minutes: 547,
        detail: {
          days: [
            { date: '2026-10-10', status: 'present', worked: 547, in: '2026-10-10T09:32:16.945Z', out: '2026-10-10T18:39:32.646Z' },
          ],
        },
      }),
      run,
      'Umesh',
    );
    expect(text).toContain('Sat 10 Oct: 15:02 – 00:09 = 9h 7m');
  });

  it('keeps the real last clock-out on a day with a break, rather than inventing one', () => {
    // 10:00 → 19:00 with an hour's break: 8h counted.
    const { text } = renderPayslipEmail(
      line({
        worked_minutes: 480,
        detail: {
          days: [
            { date: '2026-10-05', status: 'present', worked: 480, in: '2026-10-05T04:30:00.000Z', out: '2026-10-05T13:30:00.000Z' },
          ],
        },
      }),
      run,
      'Ravi',
    );
    expect(text).toContain('Mon 5 Oct: 10:00 – 19:00 = 8h 0m');
  });

  it('leaves the day-by-day table out for a run frozen before it existed', () => {
    const { html, text } = renderPayslipEmail(line({ detail: {} }), run, 'Ravi');
    expect(text).not.toContain('Day by day');
    expect(html).not.toContain('Day by day');
  });

  it('shows deductions as a negative amount', () => {
    const { text } = renderPayslipEmail(line({ deductions_inr: 750 }), run, 'Ravi');
    expect(text).toContain('Deductions (lateness): −₹750');
  });

  // CC-5 (docs/PHASE-5-CASH-COUNTS.md)
  it('shows an approved cash shortage as its own negative line, in both html and text', () => {
    const { html, text } = renderPayslipEmail(line({ cash_shortage_inr: 500 }), run, 'Ravi');
    expect(text).toContain('Cash shortage (approved): −₹500');
    expect(html).toContain('Cash shortage (approved)');
    expect(html).toContain('−₹500');
  });

  it('omits the cash shortage line entirely when there is none', () => {
    const { html, text } = renderPayslipEmail(line({ cash_shortage_inr: 0 }), run, 'Ravi');
    expect(text).not.toMatch(/Cash shortage/);
    expect(html).not.toMatch(/Cash shortage/);
  });

  it('shows a positive adjustment with its reason, and a negative one without double-negating', () => {
    const bonus = renderPayslipEmail(
      line({ adjustments_inr: 1_000, net_pay_inr: 25_000, detail: { adjustment_reason: 'Festival bonus' } }),
      run,
      'Ravi',
    ).text;
    expect(bonus).toContain('Adjustment — Festival bonus: +₹1,000');

    const advance = renderPayslipEmail(
      line({ adjustments_inr: -2_000, net_pay_inr: 22_000, detail: { adjustment_reason: 'Advance repayment' } }),
      run,
      'Ravi',
    ).text;
    expect(advance).toContain('Adjustment — Advance repayment: −₹2,000');
  });

  it('omits the adjustment line entirely when there is none', () => {
    const { text } = renderPayslipEmail(line({ adjustments_inr: 0 }), run, 'Ravi');
    expect(text).not.toMatch(/Adjustment/);
  });

  it('escapes a staffer name and adjustment reason in the HTML but not in the plain text', () => {
    const maliciousLine = line({
      adjustments_inr: 100,
      detail: { adjustment_reason: '<script>alert(1)</script>' },
    });
    const { html, text } = renderPayslipEmail(maliciousLine, run, '<b>Ravi</b>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<b>Ravi</b>');
    expect(html).toContain('&lt;b&gt;Ravi&lt;/b&gt;');
    // The plain-text part is not HTML, so it carries the raw text unescaped.
    expect(text).toContain('<script>alert(1)</script>');
  });

  it('falls back to a generic name when the staffer has none', () => {
    const { text } = renderPayslipEmail(line(), run, '');
    expect(text).toContain('Payslip for Staff');
  });
});
