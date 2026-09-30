import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_STATUS_LABELS,
  CONSENT_SOURCE_LABELS,
  GUARDRAIL_LABELS,
  RECIPIENT_STATUS_LABELS,
  campaignTone,
  consentSourceLabel,
  describeRoi,
  describeSendWindow,
  formatBreakEven,
  formatCount,
  formatExpectedOrders,
  formatIstClock,
  formatIstDate,
  formatIstDateTime,
  formatLift,
  formatLiftShort,
  formatPercent,
  formatRate,
  formatRoi,
  hourLabel,
  inrExact,
  recipientTone,
  signedInr,
  tabFromParam,
  tabHref,
} from '@/components/owner/marketing/format';
import { addDaysToIstDate } from '@/lib/marketing/ist';
import { approvalMessageCount, maxMessageCost, pluralize } from '@/components/owner/marketing/approvals';
import { BAR_RADIUS_PX, MAX_BAR_PX, barPath, describeWeek, niceAxis, weeklyChartModel } from '@/components/owner/marketing/chart';
import {
  attributionSentence,
  liftSentence,
  pageCount,
  recipientReason,
  unwrapCampaignDetail,
} from '@/components/owner/marketing/campaignData';
import {
  CAMPAIGN_STATUSES,
  CONSENT_SOURCES,
  GUARDRAIL_FLAGS,
  MARKETING_TABS,
  RECIPIENT_STATUSES,
  type CampaignResults,
  type WeeklyPoint,
} from '@/lib/marketing/types';

describe('money and rate formatting (units are the types.ts ones)', () => {
  it('shows per-message costs with their real decimals', () => {
    expect(inrExact(1.02)).toBe('₹1.02');
    expect(inrExact(1)).toBe('₹1');
    expect(inrExact(1234.5)).toBe('₹1,234.5');
    expect(inrExact(-5)).toBe('−₹5');
    expect(inrExact(Number.NaN)).toBe('—');
  });

  it('shows whole rupees with Indian grouping and a real minus sign', () => {
    expect(signedInr(3237.84)).toBe('₹3,238');
    expect(signedInr(-120)).toBe('−₹120');
    expect(signedInr(-0.2)).toBe('₹0');
  });

  it('turns a 0–1 rate into a percentage exactly once', () => {
    expect(formatRate(0.12, 0)).toBe('12%');
    expect(formatRate(0.1234)).toBe('12.3%');
    expect(formatRate(null)).toBe('—');
    // …and leaves a 0–100 *_pct alone.
    expect(formatPercent(12.5, 1)).toBe('12.5%');
    expect(formatPercent(undefined)).toBe('—');
  });

  it('shows break-even as a % with more decimals when it is small (spec §1.6 worked example: 0.65%)', () => {
    expect(formatBreakEven(0.0065)).toBe('0.65%');
    expect(formatBreakEven(0.054)).toBe('5.4%');
    expect(formatBreakEven(0.126)).toBe('13%');
    expect(formatBreakEven(0.00005)).toBe('<0.01%');
    expect(formatBreakEven(null)).toBe('Not reachable');
  });

  it('shows ROI as a multiple and explains it in words', () => {
    expect(formatRoi(4.02)).toBe('4.0×');
    expect(formatRoi(-0.44)).toBe('−0.4×');
    expect(formatRoi(-0.001)).toBe('0.0×');
    expect(formatRoi(null)).toBe('—');
    expect(describeRoi(4.02)).toBe('Every ₹1 spent is expected to bring back ₹4.02 of profit.');
    expect(describeRoi(-0.5)).toBe('Every ₹1 spent is expected to lose ₹0.50.');
    expect(describeRoi(null)).toBe('');
  });

  it('shows lift in percentage POINTS and says so when there is no verdict yet', () => {
    expect(formatLift(4.2)).toBe('+4.2 points');
    expect(formatLift(-1)).toBe('−1.0 points');
    expect(formatLift(0)).toBe('0.0 points');
    expect(formatLift(null)).toBe('Not enough data yet');
    expect(formatLiftShort(4.24)).toBe('+4.2 pts');
    expect(formatLiftShort(null)).toBe('—');
  });

  it('rounds expected orders into plain words', () => {
    expect(formatExpectedOrders(19.4)).toBe('about 19');
    expect(formatExpectedOrders(0.4)).toBe('less than 1');
    expect(formatExpectedOrders(0)).toBe('0');
    expect(formatCount(12345)).toBe('12,345');
  });
});

describe('IST dates and times (arithmetic, never the browser timezone)', () => {
  it('formats an IST calendar date or an instant as "30 Sep"', () => {
    expect(formatIstDate('2026-09-30')).toBe('30 Sep');
    expect(formatIstDate('2026-09-30T20:00:00Z')).toBe('1 Oct'); // already 1:30 am IST on the 1st
    expect(formatIstDate(null)).toBe('—');
    expect(formatIstDate('not a date')).toBe('—');
  });

  it('formats the IST clock with am/pm', () => {
    expect(formatIstClock('2026-09-30T05:40:00Z')).toBe('11:10 am');
    expect(formatIstClock('2026-09-30T07:35:00Z')).toBe('1:05 pm');
    expect(formatIstClock('2026-09-30T18:30:00Z')).toBe('12:00 am');
    expect(formatIstDateTime('2026-09-30T18:30:00Z')).toBe('1 Oct, 12:00 am');
    expect(formatIstDateTime('2026-09-30T07:35:00Z')).toBe('30 Sep, 1:05 pm');
    expect(formatIstDateTime(undefined)).toBe('—');
  });

  it('says hours the way an owner does', () => {
    expect(hourLabel(0)).toBe('12 midnight');
    expect(hourLabel(11)).toBe('11 am');
    expect(hourLabel(12)).toBe('12 noon');
    expect(hourLabel(13)).toBe('1 pm');
    expect(hourLabel(20)).toBe('8 pm');
    expect(hourLabel(24)).toBe('12 midnight');
    expect(describeSendWindow(11, 20)).toBe('11 am to 8 pm IST');
  });
});

describe('labels cover every status the API can send', () => {
  it('has a label for every guardrail flag, campaign status, recipient status and consent source', () => {
    for (const f of GUARDRAIL_FLAGS) expect(GUARDRAIL_LABELS[f]).toBeTruthy();
    for (const s of CAMPAIGN_STATUSES) expect(CAMPAIGN_STATUS_LABELS[s]).toBeTruthy();
    for (const s of RECIPIENT_STATUSES) expect(RECIPIENT_STATUS_LABELS[s]).toBeTruthy();
    for (const s of CONSENT_SOURCES) expect(CONSENT_SOURCE_LABELS[s]).toBeTruthy();
  });

  it('falls back to the raw consent source rather than hiding an unknown one', () => {
    expect(consentSourceLabel('whatsapp_keyword')).toBe('Sent START on WhatsApp');
    expect(consentSourceLabel('brand_new_source')).toBe('brand_new_source');
    expect(consentSourceLabel('')).toBe('Unknown');
  });

  it('colours statuses by meaning', () => {
    expect(campaignTone('completed')).toBe('good');
    expect(campaignTone('pending_approval')).toBe('warn');
    expect(campaignTone('cancelled')).toBe('neutral');
    expect(recipientTone('failed')).toBe('bad');
    expect(recipientTone('read')).toBe('good');
    expect(recipientTone('holdout')).toBe('neutral');
  });
});

describe('?tab= parsing', () => {
  it('round-trips every tab and falls back to Overview for anything else', () => {
    for (const t of MARKETING_TABS) expect(tabFromParam(t.id)).toBe(t.id);
    expect(tabFromParam('nope')).toBe('overview');
    expect(tabFromParam('')).toBe('overview');
    expect(tabFromParam(null)).toBe('overview');
    expect(tabFromParam(undefined)).toBe('overview');
    expect(tabFromParam(['approvals', 'costs'])).toBe('approvals');
    expect(tabFromParam(['bogus'])).toBe('overview');
  });

  it('keeps the default tab URL clean', () => {
    expect(tabHref('/owner/marketing', 'overview')).toBe('/owner/marketing');
    expect(tabHref('/owner/marketing', 'settings')).toBe('/owner/marketing?tab=settings');
    // On owner.hioc.in the visible path is /marketing — the helper never assumes /owner.
    expect(tabHref('/marketing', 'costs')).toBe('/marketing?tab=costs');
  });
});

describe('approval confirm numbers', () => {
  const c = (treated_count: number, treated: number, cost = 1.02) =>
    ({ treated_count, projection: { treated, message_cost_inr: cost } }) as never;

  it('counts the messages an approval can send', () => {
    expect(approvalMessageCount(c(162, 100))).toBe(162);
    expect(approvalMessageCount(c(0, 100))).toBe(100);
    expect(approvalMessageCount(c(0, -5))).toBe(0);
  });

  it('prices the worst case: every message sent and charged', () => {
    expect(maxMessageCost(c(162, 0))).toBeCloseTo(165.24, 2);
    expect(maxMessageCost(c(0, 0))).toBe(0);
  });

  it('pluralises', () => {
    expect(pluralize(1, 'message')).toBe('1 message');
    expect(pluralize(162, 'message')).toBe('162 messages');
    expect(pluralize(1, 'person', 'people')).toBe('1 person');
    expect(pluralize(2, 'person', 'people')).toBe('2 people');
    expect(pluralize(1234, 'message')).toBe('1,234 messages');
  });
});

describe('weekly chart geometry', () => {
  const weeks = (n: number): WeeklyPoint[] =>
    Array.from({ length: n }, (_, i) => ({
      week_start: addDaysToIstDate('2026-08-03', i * 7),
      customers: 10 + i,
      orders: 20 + i * 2,
    }));

  it('picks round axis maxima with at most four intervals', () => {
    expect(niceAxis(13)).toEqual({ max: 15, ticks: [0, 5, 10, 15] });
    expect(niceAxis(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceAxis(4)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    expect(niceAxis(37)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
    expect(niceAxis(100)).toEqual({ max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceAxis(Number.NaN).max).toBe(1);
  });

  it('draws a column with a 4px rounded top and a square base', () => {
    expect(barPath(10, 20, 24, 100)).toBe('M10,120 L10,24 Q10,20 14,20 L30,20 Q34,20 34,24 L34,120 Z');
    expect(barPath(10, 20, 24, 0)).toBe('');
    // A 2px-tall bar can't have a 4px radius; it is clamped, never inverted.
    expect(barPath(0, 0, 24, 2)).toContain('Q0,0 2,0');
    expect(BAR_RADIUS_PX).toBe(4);
  });

  it('caps bar thickness at 24px however wide the chart is', () => {
    const wide = weeklyChartModel(weeks(9), 900, 220);
    for (const b of wide.bars) expect(b.w).toBeLessThanOrEqual(MAX_BAR_PX);
    const narrow = weeklyChartModel(weeks(9), 320, 220);
    for (const b of narrow.bars) expect(b.w).toBeLessThanOrEqual(MAX_BAR_PX);
    expect(narrow.bars[0].w).toBeGreaterThan(4);
  });

  it('keeps every bar and point inside the plot area and the line above the bars', () => {
    const m = weeklyChartModel(weeks(9), 360, 220);
    expect(m.bars).toHaveLength(9);
    expect(m.line).toHaveLength(9);
    for (const b of m.bars) {
      expect(b.y).toBeGreaterThanOrEqual(m.padding.top - 0.001);
      expect(b.y + b.h).toBeCloseTo(m.baselineY, 5);
    }
    // orders ≥ customers in this data, so each line point is at or above its bar top (smaller y).
    m.line.forEach((pt, i) => expect(pt.y).toBeLessThanOrEqual(m.bars[i].y + 0.001));
    expect(m.linePath.startsWith('M')).toBe(true);
    expect(m.yMax).toBeGreaterThanOrEqual(28);
  });

  it('drops alternate x labels on a narrow chart but always names the newest week', () => {
    const narrow = weeklyChartModel(weeks(9), 320, 220);
    expect(narrow.bars[8].label).not.toBe('');
    expect(narrow.bars[7].label).toBe('');
    expect(narrow.bars[6].label).not.toBe('');
    const wide = weeklyChartModel(weeks(9), 900, 220);
    expect(wide.bars.every((b) => b.label !== '')).toBe(true);
  });

  it('survives an empty or all-zero series', () => {
    const empty = weeklyChartModel([], 320, 220);
    expect(empty.bars).toEqual([]);
    expect(empty.linePath).toBe('');
    const zero = weeklyChartModel([{ week_start: '2026-08-03', customers: 0, orders: 0 }], 320, 220);
    expect(zero.bars[0].path).toBe('');
    expect(Number.isFinite(zero.line[0].y)).toBe(true);
  });

  it('describes a week for screen readers', () => {
    expect(describeWeek({ week_start: '2026-09-22', customers: 1, orders: 1 })).toBe('Week of 22 Sep: 1 customer, 1 order');
    expect(describeWeek({ week_start: '2026-09-22', customers: 18, orders: 40 })).toBe('Week of 22 Sep: 18 customers, 40 orders');
  });
});

describe('campaign drawer helpers', () => {
  const results = (over: Partial<CampaignResults>): CampaignResults => ({
    treated_delivered: 0,
    treated_converted: 0,
    holdout_n: 0,
    holdout_converted: 0,
    treated_rate: null,
    holdout_rate: null,
    lift_pp: null,
    incremental_orders: null,
    holdout_big_enough: false,
    window_closes_at: null,
    attribution_open: false,
    ...over,
  });

  it('reads the detail whether or not the server wrapped it in {campaign}', () => {
    const detail = { id: 'c1', recipients: [], results: results({}) };
    expect(unwrapCampaignDetail(detail)?.id).toBe('c1');
    expect(unwrapCampaignDetail({ campaign: detail })?.id).toBe('c1');
    expect(unwrapCampaignDetail(null)).toBeNull();
    expect(unwrapCampaignDetail({ id: 'c1' })).toBeNull();
    expect(unwrapCampaignDetail('nope')).toBeNull();
  });

  it('pages recipients 50 at a time (never fewer than one page)', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(50)).toBe(1);
    expect(pageCount(51)).toBe(2);
    expect(pageCount(101)).toBe(3);
  });

  it('explains why a recipient did not get a message', () => {
    const base = { status: 'skipped', skip_reason: '', error: '', error_code: '' } as const;
    expect(recipientReason({ ...base, skip_reason: 'too_soon' })).toBe('Messaged too recently');
    expect(recipientReason({ ...base, skip_reason: 'something_new' })).toBe('something_new');
    expect(recipientReason({ ...base, status: 'holdout' })).toContain('measure');
    expect(recipientReason({ ...base, status: 'failed', error: 'Template not found', error_code: '132001' })).toBe('Template not found (132001)');
    expect(recipientReason({ ...base, status: 'failed' })).toContain('could not deliver');
    expect(recipientReason({ ...base, status: 'read' })).toBe('');
  });

  it('says why lift is missing: a small holdout is not the same as nothing delivered', () => {
    expect(liftSentence(results({ holdout_n: 12 }))).toMatch(/at least 20.*12/);
    expect(liftSentence(results({ holdout_big_enough: true }))).toContain('nothing has been delivered');
    expect(liftSentence(results({ lift_pp: 4.2, holdout_big_enough: true }))).toContain('percentage points');
  });

  it('states the attribution window', () => {
    expect(attributionSentence(results({}))).toContain('Not sent yet');
    expect(attributionSentence(results({ window_closes_at: '2026-10-09T11:40:00Z', attribution_open: true }))).toBe(
      'Still counting returns until 9 Oct, 5:10 pm (IST).',
    );
    expect(attributionSentence(results({ window_closes_at: '2026-10-09T11:40:00Z', attribution_open: false }))).toContain('were counted until');
  });
});
