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
import { buildReport, type ReportInput } from '@/lib/reports/reconcile';

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

  it('shows expenses from the drawer only when there were any', () => {
    const send = (movements: ReportInput['movements']) =>
      renderOwnerDigest({
        period: { kind: 'weekly', from: '2026-09-22', to: '2026-09-28' },
        report: report('2026-09-22', '2026-09-28', { orders, movements }),
        previous: null,
        items: [],
        reportUrl: 'https://x',
      });
    const plain = send([{ direction: 'out', amount_inr: 300, created_at: '2026-09-27T05:00:00Z' }]);
    expect(plain.html).toContain('Cash in / out');
    expect(plain.html).not.toContain('Expenses from the drawer');

    const withExpense = send([
      { direction: 'out', amount_inr: 300, created_at: '2026-09-27T05:00:00Z' },
      { direction: 'out', amount_inr: 80, created_at: '2026-09-27T06:00:00Z', category: 'ice' },
    ]);
    expect(withExpense.html).toContain('Expenses from the drawer');
    expect(withExpense.html).toContain('−₹80');
    expect(withExpense.html).toContain('−₹380'); // cash out still includes the expense
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
