import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORT_SETTINGS,
  dueReports,
  isEmptyReport,
  isoWeekday,
  latestPeriod,
  parseSettingsPatch,
  pctChange,
  periodLabel,
  previousPeriod,
  readReportSettings,
  renderOwnerDigest,
  resolveRecipients,
  topItems,
  type OwnerReportSettings,
} from '@/lib/reports/ownerDigest';
import { buildReport, type CashDayRow, type ReportInput } from '@/lib/reports/reconcile';

const S = (patch: Partial<OwnerReportSettings> = {}): OwnerReportSettings => ({ ...DEFAULT_REPORT_SETTINGS, ...patch });

function report(from: string, to: string, over: Partial<ReportInput> = {}) {
  return buildReport({
    from,
    to,
    orders: [],
    parts: [],
    paidOrders: [],
    ordersWithParts: new Set(),
    refunds: [],
    movements: [],
    cashDays: [],
    ...over,
  });
}

describe('isoWeekday', () => {
  it('numbers Monday 1 through Sunday 7', () => {
    expect(isoWeekday('2026-09-28')).toBe(1); // Monday
    expect(isoWeekday('2026-10-04')).toBe(7); // Sunday
  });
});

describe('dueReports', () => {
  it('sends yesterday every day', () => {
    // Tuesday the 29th: not the weekly day (Monday), not the 1st.
    expect(dueReports('2026-09-29', S())).toEqual([{ kind: 'daily', from: '2026-09-28', to: '2026-09-28' }]);
  });

  it('adds the weekly report on the chosen weekday, covering the 7 days before', () => {
    expect(dueReports('2026-09-28', S())).toContainEqual({ kind: 'weekly', from: '2026-09-21', to: '2026-09-27' });
    expect(dueReports('2026-09-30', S({ weekly_send_dow: 3 }))).toContainEqual({
      kind: 'weekly',
      from: '2026-09-23',
      to: '2026-09-29',
    });
  });

  it('adds the monthly report on the chosen day — the 1st is the calendar month', () => {
    expect(dueReports('2026-10-01', S())).toContainEqual({ kind: 'monthly', from: '2026-09-01', to: '2026-09-30' });
    expect(dueReports('2026-03-01', S())).toContainEqual({ kind: 'monthly', from: '2026-02-01', to: '2026-02-28' });
    expect(dueReports('2026-10-05', S({ monthly_send_day: 5 }))).toContainEqual({
      kind: 'monthly',
      from: '2026-09-05',
      to: '2026-10-04',
    });
  });

  it('crosses a year boundary', () => {
    expect(dueReports('2027-01-01', S())).toContainEqual({ kind: 'monthly', from: '2026-12-01', to: '2026-12-31' });
  });

  it('respects switched-off reports', () => {
    const off = S({ daily_enabled: false, weekly_enabled: false, monthly_enabled: false });
    expect(dueReports('2026-06-01', off)).toEqual([]); // a Monday and the 1st
  });
});

describe('latestPeriod', () => {
  it('daily is yesterday', () => {
    expect(latestPeriod('daily', '2026-09-29', S())).toEqual({ kind: 'daily', from: '2026-09-28', to: '2026-09-28' });
  });

  it('weekly is the last complete week for the chosen start day', () => {
    // Tue 29 Sep, Monday weeks → Mon 21 – Sun 27.
    expect(latestPeriod('weekly', '2026-09-29', S())).toEqual({ kind: 'weekly', from: '2026-09-21', to: '2026-09-27' });
    // On the send day itself the week just ended is complete.
    expect(latestPeriod('weekly', '2026-09-28', S())).toEqual({ kind: 'weekly', from: '2026-09-21', to: '2026-09-27' });
  });

  it('monthly is the last complete month for the chosen start day', () => {
    expect(latestPeriod('monthly', '2026-09-29', S())).toEqual({ kind: 'monthly', from: '2026-08-01', to: '2026-08-31' });
    expect(latestPeriod('monthly', '2026-09-03', S({ monthly_send_day: 5 }))).toEqual({
      kind: 'monthly',
      from: '2026-07-05',
      to: '2026-08-04',
    });
    expect(latestPeriod('monthly', '2026-09-05', S({ monthly_send_day: 5 }))).toEqual({
      kind: 'monthly',
      from: '2026-08-05',
      to: '2026-09-04',
    });
  });
});

describe('previousPeriod', () => {
  it('steps back one period of the same kind', () => {
    expect(previousPeriod({ kind: 'daily', from: '2026-09-01', to: '2026-09-01' })).toEqual({
      kind: 'daily',
      from: '2026-08-31',
      to: '2026-08-31',
    });
    expect(previousPeriod({ kind: 'weekly', from: '2026-09-21', to: '2026-09-27' })).toEqual({
      kind: 'weekly',
      from: '2026-09-14',
      to: '2026-09-20',
    });
    expect(previousPeriod({ kind: 'monthly', from: '2026-03-01', to: '2026-03-31' })).toEqual({
      kind: 'monthly',
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });
});

describe('parseSettingsPatch', () => {
  it('accepts valid fields and normalizes recipients', () => {
    const r = parseSettingsPatch({
      daily_enabled: false,
      weekly_send_dow: 7,
      monthly_send_day: 28,
      recipients: [' Partner@Example.com ', 'partner@example.com', '', 'acc@example.in'],
      unknown_future_column: 'ignored',
    });
    expect(r).toEqual({
      ok: true,
      patch: {
        daily_enabled: false,
        weekly_send_dow: 7,
        monthly_send_day: 28,
        recipients: ['partner@example.com', 'acc@example.in'],
      },
    });
  });

  it.each([
    [{ daily_enabled: 'yes' }, 'daily_enabled must be true or false.'],
    [{ weekly_send_dow: 0 }, 'The weekly report day must be a weekday (1 = Monday … 7 = Sunday).'],
    [{ monthly_send_day: 29 }, 'The monthly report day must be between 1 and 28.'],
    [{ monthly_send_day: 1.5 }, 'The monthly report day must be between 1 and 28.'],
    [{ recipients: 'a@b.com' }, 'recipients must be a list of email addresses.'],
    [{ recipients: ['not-an-email'] }, '"not-an-email" is not a valid email address.'],
    [{}, 'Nothing to update'],
  ])('rejects %j', (body, message) => {
    expect(parseSettingsPatch(body as Record<string, unknown>)).toEqual({ ok: false, message });
  });

  it('caps the extra recipients', () => {
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`);
    expect(parseSettingsPatch({ recipients: many }).ok).toBe(false);
  });
});

describe('readReportSettings', () => {
  it('fills anything missing with the defaults', () => {
    expect(readReportSettings(null)).toEqual(DEFAULT_REPORT_SETTINGS);
    expect(readReportSettings({ weekly_send_dow: 5, recipients: ['a@b.com'] })).toEqual({
      ...DEFAULT_REPORT_SETTINGS,
      weekly_send_dow: 5,
      recipients: ['a@b.com'],
    });
  });
});

describe('resolveRecipients', () => {
  it('combines owner logins and extras without duplicates', () => {
    expect(resolveRecipients(S({ recipients: ['owner@hioc.in', 'acc@x.com'] }), ['Owner@hioc.in'])).toEqual([
      'owner@hioc.in',
      'acc@x.com',
    ]);
  });

  it('leaves out owner logins when switched off', () => {
    expect(resolveRecipients(S({ send_to_owner_login: false, recipients: ['acc@x.com'] }), ['owner@hioc.in'])).toEqual([
      'acc@x.com',
    ]);
  });
});

describe('topItems', () => {
  it('sums lines by item and ranks by revenue', () => {
    expect(
      topItems(
        [
          { name_snapshot: 'Latte', quantity: 2, line_total_inr: 400 },
          { name_snapshot: 'Espresso', quantity: 5, line_total_inr: 500 },
          { name_snapshot: 'Latte', quantity: 1, line_total_inr: 200 },
          { name_snapshot: 'Cookie', quantity: 1, line_total_inr: 80 },
        ],
        2,
      ),
    ).toEqual([
      { name: 'Latte', units: 3, revenueInr: 600 },
      { name: 'Espresso', units: 5, revenueInr: 500 },
    ]);
  });
});

describe('pctChange', () => {
  it('is null without a baseline', () => {
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
  });
});

describe('periodLabel', () => {
  it('names a calendar month by its name, other ranges by dates', () => {
    expect(periodLabel({ kind: 'monthly', from: '2026-09-01', to: '2026-09-30' })).toMatch(/September 2026/);
    expect(periodLabel({ kind: 'monthly', from: '2026-09-05', to: '2026-10-04' })).toMatch(/5 Sept?.*4 Oct/);
    expect(periodLabel({ kind: 'weekly', from: '2026-09-21', to: '2026-09-27' })).toMatch(/21 Sept?.*27 Sept?/);
  });
});

describe('renderOwnerDigest', () => {
  const day = '2026-09-28';
  const orders = [
    { id: 'o1', created_at: '2026-09-28T06:00:00Z', status: 'completed', payment_status: 'paid', total_inr: 600, subtotal_inr: 571, tax_inr: 29, discount_inr: 0 },
    { id: 'o2', created_at: '2026-09-28T07:00:00Z', status: 'completed', payment_status: 'unpaid', total_inr: 400, subtotal_inr: 381, tax_inr: 19, discount_inr: 0 },
  ];
  const paidOrders = [{ id: 'o1', payment_method: 'upi', total_inr: 600, subtotal_inr: 571, paid_at: '2026-09-28T06:05:00Z' }];

  it('renders the headline numbers, comparison, top sellers and link', () => {
    const r = report(day, day, { orders, paidOrders });
    const prev = report('2026-09-27', '2026-09-27', { orders: [{ ...orders[0], created_at: '2026-09-27T06:00:00Z', total_inr: 500 }] });
    const email = renderOwnerDigest({
      period: { kind: 'daily', from: day, to: day },
      report: r,
      previous: prev,
      items: [{ name: 'Cold <Brew>', units: 3, revenueInr: 600 }],
      reportUrl: 'https://hioc.in/owner/reports?from=2026-09-28&to=2026-09-28',
    });

    expect(email.subject).toContain('Daily report');
    expect(email.subject).toContain('₹1,000 from 2 orders');
    expect(email.html).toContain('₹1,000');
    expect(email.html).toContain('▲ 100%'); // 1,000 vs 500
    expect(email.html).toContain('Cold &lt;Brew&gt; × 3'); // escaped
    expect(email.html).not.toContain('Cold <Brew>');
    expect(email.html).toContain('still unpaid');
    expect(email.html).toContain('https://hioc.in/owner/reports?from=2026-09-28&amp;to=2026-09-28');
    expect(email.html).toContain('not opened'); // no cash day
    expect(email.text).toContain('Net sales: ₹1,000 (▲ 100% vs the day before)');
    expect(email.text).toContain('UPI: ₹600');
  });

  // A closed cash day as PATCH /api/cash-days freezes it: opened 3 pm on the
  // 28th, closed 1:15 am on the 29th (after midnight).
  const closedDay = (over: Partial<CashDayRow> = {}): CashDayRow => ({
    id: 'cd1',
    business_date: day,
    status: 'closed',
    opened_at: '2026-09-28T09:30:00Z',
    closed_at: '2026-09-28T19:45:00Z',
    opening_total_inr: 2000,
    cash_sales_inr: 10500,
    cash_sales_count: 14,
    cash_refunds_inr: 200,
    cash_in_inr: 0,
    cash_out_inr: 350,
    expenses_inr: 350,
    expected_cash_inr: 11950,
    counted_total_inr: 11900,
    over_short_inr: -50,
    closing_denoms: { '500': 18, '200': 5, '100': 16, '50': 4, '20': 5, '10': 0, '5': 0, '2': 0, '1': 0 }, // = ₹11,900
    handover_inr: 9900,
    float_left_total_inr: 2000,
    float_left_denoms: { '500': 2, '100': 10 },
    close_reason: 'gave change twice',
    notes: '',
    ...over,
  });

  it('shows a daily drawer the way it was closed, with the closing count by denomination', () => {
    const email = renderOwnerDigest({
      period: { kind: 'daily', from: day, to: day },
      report: report(day, day, { orders, cashDays: [closedDay()] }),
      previous: null,
      items: [],
      reportUrl: 'https://x',
    });
    for (const part of [
      'Opening float',
      'Cash sales (14)',
      '+₹10,500',
      'Expected in drawer',
      '₹11,950',
      'Counted at close',
      '₹11,900',
      '−₹50',
      'gave change twice',
      'Expenses',
      '−₹350',
      'Handed over to owner',
      '₹9,900',
      'Float left in drawer',
      'Closing count',
      'Left as float',
      '₹9,000', // 18 × ₹500
      'Closed after midnight',
    ]) {
      expect(email.html).toContain(part);
    }
    expect(email.text).toContain('Counted at close: ₹11,900');
    expect(email.text).not.toContain('Cash out to owner'); // all its cash out was an expense
    expect(email.text).toContain('Handed over to owner: ₹9,900');
    expect(email.text).toContain('₹500 × 18 = ₹9,000 (2 left as float)');
    expect(email.text).toContain('₹200 × 5 = ₹1,000');
    expect(email.text).not.toContain('₹10 ×'); // nothing counted, no row
    expect(email.text).toContain('Total: ₹11,900');
  });

  it('counts any cash out that is not an expense as handed to the owner', () => {
    const email = renderOwnerDigest({
      period: { kind: 'daily', from: day, to: day },
      // ₹1,350 out: ₹350 of expenses, ₹1,000 taken to the owner during the day.
      report: report(day, day, { orders, cashDays: [closedDay({ cash_out_inr: 1350, expenses_inr: 350, expected_cash_inr: 10950, counted_total_inr: 10900, handover_inr: 8900 })] }),
      previous: null,
      items: [],
      reportUrl: 'https://x',
    });
    expect(email.text).toContain('Expenses: −₹350');
    expect(email.text).toContain('Cash out to owner: −₹1,000');
    expect(email.text).toContain('Handed over at close: ₹8,900');
    expect(email.text).toContain('Handed over to owner (total): ₹9,900');
  });

  it('says a daily drawer is still open rather than showing a count', () => {
    const email = renderOwnerDigest({
      period: { kind: 'daily', from: day, to: day },
      report: report(day, day, {
        orders,
        cashDays: [{ business_date: day, status: 'open', opened_at: '2026-09-28T09:30:00Z', opening_total_inr: 2000, cash_sales_inr: null, expected_cash_inr: 0, counted_total_inr: 0, over_short_inr: 0 }],
      }),
      previous: null,
      items: [],
      reportUrl: 'https://x',
    });
    expect(email.html).toContain('the day is still open');
    expect(email.html).not.toContain('Counted at close');
  });

  it('adds up a range’s drawer from its cash days, expenses only when there were any', () => {
    const send = (cashDays: CashDayRow[]) =>
      renderOwnerDigest({
        period: { kind: 'weekly', from: '2026-09-22', to: '2026-09-28' },
        report: report('2026-09-22', '2026-09-28', {
          orders,
          cashDays,
        }),
        previous: null,
        items: [],
        reportUrl: 'https://x',
      });
    // ₹300 out during the day, none of it an expense: it went to the owner.
    const plain = send([closedDay({ cash_out_inr: 300, expenses_inr: 0 })]);
    expect(plain.text).not.toContain('Expenses from the drawer');
    expect(plain.text).toContain('Handed over to owner: ₹10,200'); // ₹300 + ₹9,900 at close
    expect(plain.text).toContain('of which cash out during the day: ₹300');
    expect(plain.html).toContain('Closing count by day');

    // ₹380 out, ₹80 of it expenses: the expenses stand apart, the rest went to the owner.
    const withExpense = send([closedDay({ cash_out_inr: 380, expenses_inr: 80 })]);
    expect(withExpense.text).toContain('Expenses from the drawer: −₹80');
    expect(withExpense.text).toContain('Handed over to owner: ₹10,200');
    expect(withExpense.text).not.toContain('₹380');
  });

  it('lists every day on a weekly report and best/slowest on a monthly one', () => {
    const weekly = renderOwnerDigest({
      period: { kind: 'weekly', from: '2026-09-22', to: '2026-09-28' },
      report: report('2026-09-22', '2026-09-28', { orders }),
      previous: null,
      items: [],
      reportUrl: 'https://x',
    });
    expect(weekly.html).toContain('Day by day');
    expect(weekly.html).toContain('Days closed');

    const monthly = renderOwnerDigest({
      period: { kind: 'monthly', from: '2026-09-01', to: '2026-09-30' },
      report: report('2026-09-01', '2026-09-30', { orders }),
      previous: null,
      items: [],
      reportUrl: 'https://x',
    });
    expect(monthly.html).toContain('Best day');
    expect(monthly.html).toContain('Trading days');
    expect(monthly.subject).toContain('September 2026');
  });

  it('isEmptyReport spots a day with nothing in it', () => {
    expect(isEmptyReport(report(day, day))).toBe(true);
    expect(isEmptyReport(report(day, day, { orders }))).toBe(false);
  });
});
