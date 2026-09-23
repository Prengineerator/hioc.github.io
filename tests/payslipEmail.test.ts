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

  it('omits OT and late-mark lines when there are none, and shows them when present', () => {
    const clean = renderPayslipEmail(line(), run, 'Ravi').text;
    expect(clean).not.toMatch(/Overtime/);
    expect(clean).not.toMatch(/Late marks/);

    const withOt = renderPayslipEmail(
      line({ ot_minutes: 90, ot_pay_inr: 500, late_marks: 2 }),
      run,
      'Ravi',
    ).text;
    expect(withOt).toContain('Overtime: 1h 30m');
    expect(withOt).toContain('Overtime pay: ₹500');
    expect(withOt).toContain('Late marks: 2');
  });

  it('shows deductions as a negative amount', () => {
    const { text } = renderPayslipEmail(line({ deductions_inr: 750 }), run, 'Ravi');
    expect(text).toContain('Deductions (lateness): −₹750');
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
