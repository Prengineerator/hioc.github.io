// Smoke-renders the dashboard's components on the server with realistic data, in the
// node test environment (no DOM). It cannot click anything — the logic behind the
// clicks is unit-tested in the other tests/marketingDashboard*.test.ts files — but
// it does prove that every tab's markup builds from the API shapes in
// lib/marketing/types.ts without throwing, and that the words the spec asks for
// (kill-switch banner, break-even as a %, guardrail chips, "Auto (best value)",
// migration-missing instruction…) are actually on the page.

import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { project } from '@/lib/marketing/economics';
import {
  DEFAULT_SETTINGS,
  GUARDRAIL_EXPLANATIONS,
  defaultPlaybook,
  type AudienceSummary,
  type CampaignDetail,
  type CampaignPreview,
  type CampaignSummary,
  type CostsResponse,
  type MarketingOverview,
  type PlaybookView,
  type WeeklyPoint,
} from '@/lib/marketing/types';
import { formatBreakEven } from '@/components/owner/marketing/format';
import { ApprovalCard } from '@/components/owner/marketing/ApprovalsTab';
import { AudienceBody } from '@/components/owner/marketing/AudienceTab';
import { CampaignsTable } from '@/components/owner/marketing/CampaignsTable';
import { GuardrailList, ProjectionGrid, SamplePreviews } from '@/components/owner/marketing/CampaignParts';
import { Facts, Header, Recipients, Results } from '@/components/owner/marketing/CampaignDrawer';
import { AudienceStep, CampaignWizard, PreviewBody, ScheduleStep } from '@/components/owner/marketing/CampaignWizard';
import { CostsBody } from '@/components/owner/marketing/CostsTab';
import { OverviewBody, OverviewTab } from '@/components/owner/marketing/OverviewTab';
import { PlaybookCard } from '@/components/owner/marketing/PlaybooksTab';
import { SettingsBody } from '@/components/owner/marketing/SettingsTab';
import { WeeklyChart } from '@/components/owner/marketing/WeeklyChart';
import { ErrorNote, Kpi, MigrationMissing, Notice, Pill, ProgressBar, ResourceGate, Segmented } from '@/components/owner/marketing/ui';
import { emptyWizard } from '@/components/owner/marketing/wizard';
import { OptInCard } from '@/components/marketing/OptInCard';
import { OwnerMarketingCard } from '@/components/owner/marketing/OwnerMarketingCard';

const html = (el: ReactElement) => renderToStaticMarkup(el);
const noop = () => undefined;

// The worked example of spec §1.6: 200 eligible, 10% holdout, ₹1.02 a message, 10% off (cap ₹60), basket ₹320, 35% food cost.
const projection = project({
  eligible: 200,
  holdout_pct: 10,
  message_cost_inr: 1.02,
  deliverability: 0.9,
  conversion_rate: 0.12,
  basket_inr: 320,
  food_cost_ratio: 0.35,
  offer: { type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 },
});

const totals = { sent: 0, delivered: 0, read: 0, clicked: 0, failed: 0, skipped: 0, returned: 0, revenue_inr: 0, spend_inr: 0 };

const summary = (over: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: 'c1',
  kind: 'playbook',
  playbook_key: 'winback_1',
  name: 'Win-back stage 1 · 30 Sep',
  status: 'pending_approval',
  planned_for: '2026-09-30',
  send_after: null,
  created_at: '2026-09-30T04:15:00Z',
  approved_at: null,
  started_at: null,
  completed_at: null,
  treated_count: 180,
  holdout_count: 20,
  offer_text: '10% off (up to ₹60) on orders above ₹150',
  offer: { type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 },
  template_name: 'hioc_winback_1',
  guardrail_flags: ['low_margin', 'missing_costs'],
  projection,
  samples: [
    { first_name: 'Asha', text: 'Hi Asha, we have missed you at HIOC! Here is 10% off.', vars: ['Asha'], coupon_code: '' },
    { first_name: 'Ravi', text: 'Hi Ravi, we have missed you at HIOC! Here is 10% off.', vars: ['Ravi'], coupon_code: '' },
  ],
  totals,
  lift_pp: null,
  ...over,
});

const weekly: WeeklyPoint[] = Array.from({ length: 9 }, (_, i) => ({
  week_start: `2026-08-${String(3 + i * 7).padStart(2, '0')}`.replace('-38', '-31'),
  customers: 20 + i,
  orders: 40 + i * 2,
}));
// fix the dates that overflow August in the line above with plain valid ones
weekly[5].week_start = '2026-09-07';
weekly[6].week_start = '2026-09-14';
weekly[7].week_start = '2026-09-21';
weekly[8].week_start = '2026-09-28';

const overview = (over: Partial<MarketingOverview> = {}): MarketingOverview => ({
  enabled: false,
  whatsapp_configured: true,
  receipts_connected: false,
  kpis: {
    opted_in: 214,
    active_customers: 640,
    active_opted_in_pct: 33.4,
    month_spend_inr: 212,
    monthly_budget_inr: 1000,
    messages_sent_30d: 208,
    delivered_pct_30d: null,
    read_pct_30d: null,
    returning_orders_30d: 19,
    returning_revenue_30d_inr: 6080,
    lift_pp: null,
    est_roi: 3.2,
  },
  pending_approvals: 2,
  weekly,
  drop_alert: { week_start: '2026-09-21', last_week_customers: 18, baseline_customers: 24, drop_pct: 25, drop_customers: 6 },
  insights: [
    { id: 'points_expiring_off', tone: 'warn', message: '₹1,240 of points (31 customers) expire in the next 7 days.', cta: { label: 'Turn on the points reminder', tab: 'playbooks', playbook_key: 'points_expiring' } },
    { id: 'receipts_not_connected', tone: 'warn', message: 'RECEIPTS-INSIGHT-SENTENCE', cta: null },
    { id: 'best_free_item', tone: 'info', message: 'Best free-item offer: Cold Coffee (worth ₹180, costs ₹45).', cta: { label: 'See product costs', tab: 'costs' } },
  ],
  recent_campaigns: [summary({ status: 'completed', totals: { ...totals, sent: 180, returned: 19, revenue_inr: 6080, spend_inr: 184 }, guardrail_flags: [], lift_pp: 4.2 })],
  ...over,
});

const detail = (over: Partial<CampaignDetail> = {}): CampaignDetail => ({
  ...summary({ status: 'completed', totals: { ...totals, sent: 180, delivered: 0, read: 0, returned: 19, revenue_inr: 6080, spend_inr: 184, skipped: 3 } }),
  template: { name: 'hioc_winback_1', lang: 'en', vars: ['first_name'], url_button: true, body_preview: 'Hi {{1}}' },
  audience: {},
  recipients: [
    { id: 'r1', phone: '+919876543210', first_name: 'Asha', arm: 'treatment', status: 'sent', skip_reason: '', coupon_code: 'WBK7M3QX', error: '', error_code: '', cost_inr: 1.02, sent_at: '2026-10-01T06:00:00Z', delivered_at: null, read_at: null, clicked_at: null, converted_at: '2026-10-02T06:00:00Z', conversion_revenue_inr: 320, attributed_via: 'coupon' },
    { id: 'r2', phone: '+919812345678', first_name: 'Ravi', arm: 'treatment', status: 'skipped', skip_reason: 'too_soon', coupon_code: '', error: '', error_code: '', cost_inr: 0, sent_at: null, delivered_at: null, read_at: null, clicked_at: null, converted_at: null, conversion_revenue_inr: 0, attributed_via: '' },
    { id: 'r3', phone: '+919899999999', first_name: 'Meena', arm: 'holdout', status: 'holdout', skip_reason: '', coupon_code: '', error: '', error_code: '', cost_inr: 0, sent_at: null, delivered_at: null, read_at: null, clicked_at: null, converted_at: null, conversion_revenue_inr: 0, attributed_via: '' },
  ],
  page: 1,
  recipients_total: 3,
  results: { treated_delivered: 180, treated_converted: 19, holdout_n: 12, holdout_converted: 1, treated_rate: 0.1056, holdout_rate: 0.083, lift_pp: null, incremental_orders: null, holdout_big_enough: false, window_closes_at: '2026-10-09T11:40:00Z', attribution_open: true },
  ...over,
});

const playbookView = (key: 'winback_2' | 'points_expiring' | 'winback_1', over: Partial<PlaybookView> = {}): PlaybookView =>
  ({
    ...defaultPlaybook(key),
    mode: 'review',
    observed_treated: 240,
    observed_conversions: 30,
    last_planned_at: '2026-09-30T04:15:00Z',
    updated_at: null,
    label: key,
    description: 'Customers who are still away a month later.',
    learned_conversion_pct: 12.4,
    last_runs: [summary({ status: 'completed', totals: { ...totals, sent: 180, returned: 19, revenue_inr: 6080 } })],
    ...over,
  }) as unknown as PlaybookView;

const ranking = [
  { item_id: 'i1', item_name: 'Cold Coffee', variant_id: 'v1', variant_label: 'Large', price_inr: 180, cost_inr: 45, value_per_rupee: 4 },
  { item_id: 'i2', item_name: 'Waffle', variant_id: 'v2', variant_label: 'Regular', price_inr: 150, cost_inr: 50, value_per_rupee: 3 },
];

describe('shared pieces', () => {
  it('shows the money grid with break-even as a % (the worked example is ≈ 0.65%)', () => {
    const out = html(createElement(ProjectionGrid, { projection }));
    expect(formatBreakEven(projection.break_even_rate)).toMatch(/^0\.6\d%$/);
    expect(out).toContain(formatBreakEven(projection.break_even_rate));
    for (const label of ['Message cost', 'Returning orders', 'Revenue', 'Offer cost', 'Expected profit', 'ROI', 'Break-even', 'Profit per order']) {
      expect(out).toContain(label);
    }
    expect(out).toContain('₹184'); // 180 messages × ₹1.02
    expect(out).toContain('180 messages at ₹1.02 each');
  });

  it('says so when a campaign can never break even', () => {
    const losing = { ...projection, break_even_rate: null, expected_profit_inr: -300, profit_per_conv_inr: -5, roi: -0.4 };
    const out = html(createElement(ProjectionGrid, { projection: losing }));
    expect(out).toContain('Not reachable');
    expect(out).toContain('−₹300');
    expect(out).toContain('a loss');
  });

  it('shows a red chip and the plain-English reason for every flag', () => {
    const out = html(createElement(GuardrailList, { flags: ['negative_profit', 'no_template'] }));
    expect(out).toContain('Expected to lose money');
    expect(out).toContain(GUARDRAIL_EXPLANATIONS.negative_profit.replace(/'/g, '&#x27;'));
    expect(html(createElement(GuardrailList, { flags: [] }))).toBe('');
  });

  it('shows at most three sample messages and explains the personal code', () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({ first_name: `P${i}`, text: `Hello P${i}`, vars: [], coupon_code: '' }));
    const out = html(createElement(SamplePreviews, { samples, hasCoupon: true }));
    expect(out.match(/Hello P/g)).toHaveLength(3);
    expect(out).toContain('own code when the message is sent');
    expect(html(createElement(SamplePreviews, { samples: [], hasCoupon: false }))).toContain('No sample messages yet');
  });

  it('builds the small UI pieces', () => {
    expect(html(createElement(Pill, { tone: 'good', children: 'Done' }))).toContain('Done');
    expect(html(createElement(Notice, { tone: 'warn', title: 'Careful' }, 'body'))).toContain('Heads up');
    expect(html(createElement(Kpi, { label: 'L', value: '5', hint: 'h' }))).toContain('L');
    const bar = html(createElement(ProgressBar, { value: 212, max: 1000, label: 'Spend' }));
    expect(bar).toContain('role="progressbar"');
    expect(bar).toContain('aria-valuenow="212"');
    expect(html(createElement(ProgressBar, { value: 1200, max: 1000, label: 'Spend' }))).toContain('bg-red-600');
    const seg = html(createElement(Segmented, { label: 'Mode', value: 'review', onChange: noop, options: [{ value: 'off', label: 'Off' }, { value: 'review', label: 'Review' }] }));
    expect(seg).toContain('aria-pressed="true"');
    expect(seg).toContain('aria-pressed="false"');
  });

  it('shows the migration instruction for a 409 and a retry for anything else', () => {
    const out = html(createElement(MigrationMissing));
    expect(out).toContain('supabase/2026-10-marketing-agent.sql');
    expect(out).toContain('SQL editor');
    expect(html(createElement(ErrorNote, { error: { kind: 'migration_missing', status: 409, message: 'x' } }))).toContain('supabase/2026-10-marketing-agent.sql');
    const other = html(createElement(ErrorNote, { error: { kind: 'network', status: 0, message: 'Could not reach the server.' }, onRetry: noop }));
    expect(other).toContain('Could not reach the server.');
    expect(other).toContain('Try again');
  });

  it('gates every fetch: loading, error, migration missing, ready', () => {
    const base = { reload: noop, setData: noop, update: noop };
    const child = (d: string) => createElement('p', null, `DATA:${d}`);
    expect(html(createElement(ResourceGate<string>, { resource: { ...base, state: { status: 'loading' } }, label: 'Loading things…', children: child }))).toContain('Loading things…');
    expect(html(createElement(ResourceGate<string>, { resource: { ...base, state: { status: 'ready', data: 'ok' } }, label: 'x', children: child }))).toContain('DATA:ok');
    expect(html(createElement(ResourceGate<string>, { resource: { ...base, state: { status: 'error', error: { kind: 'migration_missing', status: 409, message: '' } } }, label: 'x', children: child }))).toContain('2026-10-marketing-agent.sql');
    expect(html(createElement(ResourceGate<string>, { resource: { ...base, state: { status: 'error', error: { kind: 'server', status: 500, message: 'Boom' } } }, label: 'x', children: child }))).toContain('Boom');
  });
});

describe('Overview', () => {
  const render = (o: MarketingOverview) => html(createElement(OverviewBody, { data: o, reload: noop, onNavigate: noop, onOpenCampaign: noop }));

  it('leads with the kill switch and everything the spec lists', () => {
    const out = render(overview());
    expect(out).toContain('Sending is OFF');
    expect(out).toContain('Turn sending on');
    expect(out).toContain('2 campaigns are waiting for your OK');
    for (const label of ['Customers who opted in', 'Spent this month', 'Messages sent', 'Returning orders', 'Measured lift', 'Estimated ROI']) expect(out).toContain(label);
    expect(out).toContain('₹212');
    expect(out).toContain('of your ₹1,000 budget');
    expect(out).toContain('Delivery tracking is not connected yet');
    expect(out).toContain('Not enough data yet'); // lift is null
    expect(out).toContain('Recent campaigns');
    expect(out).toContain('Win-back stage 1');
  });

  it('shows the drop alert, the receipts notice and the insight buttons', () => {
    const out = render(overview());
    expect(out).toContain('Fewer customers ordered last week: down 25%');
    expect(out).toContain('Plan a win-back');
    expect(out).toContain('Delivery receipts are not connected');
    expect(out).toContain('WHATSAPP_APP_SECRET');
    expect(out).toContain('Turn on the points reminder');
    expect(out).toContain('See product costs');
    // the dedicated receipts notice replaces the duplicate insight
    expect(out).not.toContain('RECEIPTS-INSIGHT-SENTENCE');
  });

  it('flips to "Sending is ON" and hides the notices that no longer apply', () => {
    const out = render(overview({ enabled: true, receipts_connected: true, drop_alert: null, pending_approvals: 0, whatsapp_configured: false }));
    expect(out).toContain('Sending is ON');
    expect(out).toContain('Turn sending off');
    expect(out).not.toContain('Delivery receipts are not connected');
    expect(out).not.toContain('Fewer customers ordered');
    expect(out).not.toContain('waiting for your OK');
    expect(out).toContain('WhatsApp is not connected on the server');
  });

  it('renders through the fetch gate too, and shows a loading state before data', () => {
    const ready = html(createElement(OverviewTab, { overview: { state: { status: 'ready', data: overview() }, reload: noop, setData: noop, update: noop }, onNavigate: noop, onOpenCampaign: noop }));
    expect(ready).toContain('Sending is OFF');
    const loading = html(createElement(OverviewTab, { overview: { state: { status: 'loading' }, reload: noop, setData: noop, update: noop }, onNavigate: noop, onOpenCampaign: noop }));
    expect(loading).toContain('Loading your overview');
  });

  it('draws the weekly chart with a legend and a table alternative', () => {
    const out = html(createElement(WeeklyChart, { points: weekly, dropWeekStart: '2026-09-21' }));
    expect(out).toContain('<svg');
    expect(out).toContain('Customers who ordered');
    expect(out).toContain('All orders');
    expect(out).toContain('Show as a table');
    expect(out).toContain('▼');
    expect(html(createElement(WeeklyChart, { points: [], dropWeekStart: null }))).toContain('No weekly numbers yet');
  });

  it('shows dashes, not zeros, for delivery counts while receipts are not flowing', () => {
    const rows = [summary({ status: 'completed', totals: { ...totals, sent: 50 } })];
    const out = html(createElement(CampaignsTable, { rows, onOpen: noop, emptyMessage: 'none' }));
    expect(out).toContain('—');
    expect(html(createElement(CampaignsTable, { rows: [], onOpen: noop, emptyMessage: 'Nothing yet' }))).toContain('Nothing yet');
  });
});

describe('Approvals', () => {
  it('shows the card the spec describes', () => {
    const out = html(createElement(ApprovalCard, { campaign: summary(), sendingEnabled: false, onDone: noop, onOpen: noop }));
    expect(out).toContain('Win-back stage 1');
    expect(out).toContain('180 people');
    expect(out).toContain('20 people');
    expect(out).toContain('10% off (up to ₹60) on orders above ₹150');
    expect(out).toContain('hioc_winback_1');
    expect(out).toContain(formatBreakEven(projection.break_even_rate));
    expect(out).toContain('Thin margin');
    expect(out).toContain('Product costs missing');
    expect(out).toContain('2 warnings');
    expect(out).toContain('Approve &amp; send');
    expect(out).toContain('Skip');
    expect(out).toContain('Hi Asha');
    expect(out).toContain('Hi Ravi');
  });

  it('handles a points campaign with no coupon and a template that is not set', () => {
    const out = html(createElement(ApprovalCard, { campaign: summary({ playbook_key: 'points_expiring', offer: { type: 'none' }, offer_text: '', template_name: '', guardrail_flags: ['no_template'] }), sendingEnabled: true, onDone: noop, onOpen: noop }));
    expect(out).toContain('Their own points are the offer');
    expect(out).toContain('Not set');
    expect(out).toContain('1 warning');
  });

  it('handles a manual campaign scheduled for later', () => {
    const out = html(createElement(ApprovalCard, { campaign: summary({ kind: 'manual', playbook_key: null, status: 'draft', send_after: '2026-10-02T05:30:00Z' }), sendingEnabled: null, onDone: noop, onOpen: noop }));
    expect(out).toContain('Manual campaign');
    expect(out).toContain('Draft');
    expect(out).toContain('Not before 2 Oct, 11:00 am (IST)');
  });
});

describe('Playbooks', () => {
  it('shows the mode control, the Auto explanation and the offer/template editors when opened', () => {
    const out = html(createElement(PlaybookCard, { view: playbookView('winback_2'), ranking, costsAvailable: true, focused: true, onSaved: noop, onOpenCampaign: noop }));
    expect(out).toContain('Priority 3');
    expect(out).toContain('Off');
    expect(out).toContain('Review');
    expect(out).toContain('Auto');
    expect(out).toContain('Who qualifies');
    expect(out).toContain('Offer');
    expect(out).toContain('Auto (best value)');
    expect(out).toContain('Cold Coffee (Large) · worth ₹180, costs ₹45 · 4.0× value');
    expect(out).toContain('Send test to my phone');
    expect(out).toContain('hioc_winback_1');
    expect(out).toContain('Starting guess'); // prior vs learned
    expect(out).toContain('12.4%');
    expect(out).toContain('240 delivered messages');
    expect(out).toContain('Recent runs');
    expect(out).toContain('No changes');
  });

  it('keeps a points reminder free of offers, and tells the owner why', () => {
    const out = html(createElement(PlaybookCard, { view: playbookView('points_expiring'), ranking: [], costsAvailable: false, focused: true, onSaved: noop, onOpenCampaign: noop }));
    expect(out).toContain('carry no coupon');
    expect(out).not.toContain('Which free item?');
  });

  it('explains Auto next to the control when it is selected', () => {
    const out = html(createElement(PlaybookCard, { view: playbookView('winback_1', { mode: 'auto' }), ranking: [], costsAvailable: true, focused: false, onSaved: noop, onOpenCampaign: noop }));
    expect(out).toContain('every guardrail passes');
  });

  it('starts collapsed unless it was asked for', () => {
    const out = html(createElement(PlaybookCard, { view: playbookView('winback_1'), ranking: [], costsAvailable: true, focused: false, onSaved: noop, onOpenCampaign: noop }));
    expect(out).not.toContain('Who qualifies');
    expect(out).toContain('Edit who, offer and message');
  });
});

describe('Campaign drawer', () => {
  it('shows results with a "not enough data yet" lift and the attribution window', () => {
    const c = detail();
    const out = html(createElement(Results, { c }));
    expect(out).toContain('Measured lift');
    expect(out).toContain('Not enough data yet');
    expect(out).toContain('at least 20 held-back people; this campaign has 12');
    expect(out).toContain('Still counting returns until 9 Oct, 5:10 pm (IST)');
    expect(out).toContain('receipts not received yet');
  });

  it('shows a measured lift with the comparison in words', () => {
    const c = detail({ results: { treated_delivered: 180, treated_converted: 19, holdout_n: 20, holdout_converted: 1, treated_rate: 0.1056, holdout_rate: 0.05, lift_pp: 5.6, incremental_orders: 10.08, holdout_big_enough: true, window_closes_at: '2026-10-09T11:40:00Z', attribution_open: false } });
    const out = html(createElement(Results, { c }));
    expect(out).toContain('+5.6 points');
    expect(out).toContain('the campaign caused');
    expect(out).toContain('Returns were counted until');
  });

  it('lists recipients with skip reasons, groups and what they brought back', () => {
    const out = html(createElement(Recipients, { c: detail(), page: 1, onPage: noop }));
    expect(out).toContain('+919876543210');
    expect(out).toContain('Messaged too recently');
    expect(out).toContain('Held back');
    expect(out).toContain('₹320');
    expect(out).toContain('used code');
    expect(out).not.toContain('Next →'); // one page
    const many = html(createElement(Recipients, { c: detail({ recipients_total: 120 }), page: 2, onPage: noop }));
    expect(many).toContain('Page 2 of 3');
  });

  it('shows the header, the facts and a stop button only while it can be stopped', () => {
    const c = detail({ status: 'sending' });
    expect(html(createElement(Header, { c, stoppable: true, onStop: noop }))).toContain('Stop this campaign');
    expect(html(createElement(Header, { c: detail(), stoppable: false, onStop: noop }))).not.toContain('Stop this campaign');
    const facts = html(createElement(Facts, { c: detail({ kind: 'manual', playbook_key: null, audience: { filter: { stages: ['lapsed_1'] }, headline: 'New latte' } }) }));
    expect(facts).toContain('Lapsed · stage 1');
    expect(facts).toContain('New latte');
  });
});

describe('New campaign wizard', () => {
  it('opens on step 1 with the live forecast beside it', () => {
    const out = html(createElement(CampaignWizard, { onClose: noop, onCreated: noop, onGoToApprovals: noop }));
    expect(out).toContain('New campaign');
    expect(out).toContain('Step 1 of 5');
    for (const step of ['Name', 'Audience', 'Offer', 'Message', 'When']) expect(out).toContain(step);
    expect(out).toContain('Live forecast');
    expect(out).toContain('Campaign name');
    expect(out).toContain('Nothing is sent when you finish');
  });

  it('renders the audience and schedule steps', () => {
    const state = { ...emptyWizard(), name: 'Push', headline: 'New latte' };
    const audience = html(createElement(AudienceStep, { state, onChange: noop, eligible: 162, refreshing: false }));
    expect(audience).toContain('162');
    expect(audience).toContain('customers match');
    expect(audience).toContain('Only customers who opted in are ever counted');
    const when = html(createElement(ScheduleStep, { state, onChange: noop, offerText: '10% off' }));
    expect(when).toContain('As soon as approved');
    expect(when).toContain('Check it over');
    expect(when).toContain('hioc_offer_1');
    const later = html(createElement(ScheduleStep, { state: { ...state, send: 'later', send_after_local: '2026-10-02T11:00' }, onChange: noop, offerText: '10% off' }));
    expect(later).toContain('Not before 2 Oct, 11:00 am (IST)');
  });

  it('renders the forecast panel from a preview response', () => {
    const preview: CampaignPreview = { eligible: 200, projection, guardrail_flags: ['low_margin'], samples: [{ first_name: 'Asha', text: 'Hello Asha', vars: [], coupon_code: '' }] };
    const out = html(createElement(PreviewBody, { preview: { status: 'ready', data: preview }, shown: preview, problem: null, hasCoupon: true }));
    expect(out).toContain('200');
    expect(out).toContain('Thin margin');
    expect(out).toContain('Hello Asha');
    const paused = html(createElement(PreviewBody, { preview: { status: 'idle' }, shown: undefined, problem: 'Give the campaign a name', hasCoupon: false }));
    expect(paused).toContain('Forecast paused');
  });
});

describe('Audience', () => {
  const audience = (over: Partial<AudienceSummary> = {}): AudienceSummary => ({
    total_customers: 900,
    stages: [
      { stage: 'new', all: 40, opted_in: 5 },
      { stage: 'active', all: 500, opted_in: 190 },
      { stage: 'at_risk', all: 60, opted_in: 12 },
      { stage: 'lapsed_1', all: 120, opted_in: 30 },
      { stage: 'lapsed_2', all: 60, opted_in: 8 },
      { stage: 'lapsed_3', all: 40, opted_in: 3 },
      { stage: 'lost', all: 70, opted_in: 1 },
      { stage: 'no_orders', all: 10, opted_in: 0 },
    ],
    points: { customers_with_balance: 210, outstanding_inr: 18400, expiring_7d_inr: 1240, expiring_7d_customers: 31 },
    consent: {
      opted_in: 214,
      opted_out: 9,
      by_source: [{ source: 'whatsapp_keyword', opted_in: 120, opted_out: 0 }, { source: 'stop_keyword', opted_in: 0, opted_out: 7 }],
      recent_events: [{ phone_masked: '+91 98••• ••210', action: 'opt_in', source: 'profile', created_at: '2026-09-29T06:00:00Z' }],
    },
    whatsapp_business_number: '+919876543210',
    optin_url: 'https://wa.me/919876543210?text=START',
    ...over,
  });

  it('shows stages, points, consent, the opt-in link, the opt-out form and why owners cannot add opt-ins', () => {
    const out = html(createElement(AudienceBody, { data: audience(), reload: noop, onNavigate: noop }));
    expect(out).toContain('Customers by stage');
    expect(out).toContain('Lapsed · stage 1');
    expect(out).toContain('₹18,400');
    expect(out).toContain('Sent START on WhatsApp');
    expect(out).toContain('+91 98••• ••210');
    expect(out).toContain('https://wa.me/919876543210?text=START');
    expect(out).toContain('Scan to get HIOC offers on WhatsApp');
    expect(out).toContain('Print the card');
    expect(out).toContain('Record an opt-out');
    expect(out).toContain('Why can’t I add customers myself?');
    expect(out).toContain('DPDP');
  });

  it('tells the owner to set the business number when it is missing', () => {
    const out = html(createElement(AudienceBody, { data: audience({ optin_url: null, whatsapp_business_number: '' }), reload: noop, onNavigate: noop }));
    expect(out).toContain('Your WhatsApp business number is not set');
    expect(out).not.toContain('Print the card');
  });
});

describe('Product costs', () => {
  const costs = (over: Partial<CostsResponse> = {}): CostsResponse => ({
    items: [
      { variant_id: 'v1', item_id: 'i1', category: 'Coffee', item_name: 'Cold Coffee', variant_label: 'Large', price_inr: 180, cost_inr: 45, food_cost_pct: 25, margin_inr: 135, is_available: true, revenue_90d_inr: 9000 },
      { variant_id: 'v2', item_id: 'i2', category: 'Coffee', item_name: 'Latte', variant_label: 'Regular', price_inr: 100, cost_inr: 70, food_cost_pct: 70, margin_inr: 30, is_available: true, revenue_90d_inr: 4000 },
      { variant_id: 'v3', item_id: 'i3', category: 'Waffles', item_name: 'Almond Honey', variant_label: '', price_inr: 150, cost_inr: null, food_cost_pct: null, margin_inr: null, is_available: false, revenue_90d_inr: 12000 },
    ],
    default_food_cost_pct: 35,
    coverage_pct: 30,
    free_item_ranking: ranking,
    ...over,
  });

  it('groups by category, highlights high food cost, and shows coverage and the best free items', () => {
    const out = html(createElement(CostsBody, { data: costs(), setData: noop, onNavigate: noop }));
    expect(out).toContain('Coffee');
    expect(out).toContain('Waffles');
    expect(out).toContain('Cold Coffee');
    expect(out).toContain('Regular'); // the blank variant label is shown as Regular
    expect(out).toContain('⚠'); // Latte: 70% food cost
    expect(out).toContain('bg-amber-50');
    expect(out).toContain('Costs are entered for only 30% of your sales');
    expect(out).toContain('35%');
    expect(out).toContain('Best free-item offers');
    expect(out).toContain('Cold Coffee (Large)');
    expect(out).toContain('4.0×');
    expect(out).toContain('Save costs');
    expect(out).toContain('No changes yet');
    expect(out).toContain('(not on the menu right now)');
  });

  it('asks for a first few costs when none are entered', () => {
    const out = html(createElement(CostsBody, { data: costs({ coverage_pct: 0, free_item_ranking: [], items: costs().items.map((i) => ({ ...i, cost_inr: null, food_cost_pct: null, margin_inr: null })) }), setData: noop, onNavigate: noop }));
    expect(out).toContain('No product costs yet');
    expect(out).toContain('Enter costs for a few items');
  });
});

describe('Settings', () => {
  it('shows the kill switch first, then every field with its help and range', () => {
    const out = html(createElement(SettingsBody, { settings: DEFAULT_SETTINGS, onSaved: noop, onEnabledChanged: noop }));
    expect(out.indexOf('Sending is OFF')).toBeGreaterThan(-1);
    expect(out.indexOf('Sending is OFF')).toBeLessThan(out.indexOf('Monthly budget'));
    expect(out).toContain('Meta marketing rate + 18% GST');
    expect(out).toContain('₹1.02 as of 2026');
    expect(out).toContain('Sending opens at (IST)');
    expect(out).toContain('11 am');
    expect(out).toContain('8 pm');
    expect(out).toContain('Allowed: 0 to 10,00,000');
    expect(out).toContain('WhatsApp business number');
    expect(out).toContain('Warn me when active customers fall by');
    expect(out).toContain('Save settings');
    expect(out).toContain('No changes yet');
  });

  it('describes the window once sending is on', () => {
    const out = html(createElement(SettingsBody, { settings: { ...DEFAULT_SETTINGS, enabled: true }, onSaved: noop, onEnabledChanged: noop }));
    expect(out).toContain('Sending is ON');
    expect(out).toContain('11 am to 8 pm IST');
  });
});

describe('quiet components', () => {
  it('renders nothing on first paint: the order-page card and the /owner card', () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(html(createElement(OptInCard))).toBe('');
    expect(html(createElement(OwnerMarketingCard))).toBe('');
    vi.unstubAllGlobals();
  });
});
