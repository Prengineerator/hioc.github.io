'use client';

// Overview (spec §7.1): is sending on, what has it cost and brought back, what
// needs attention. The first thing on the page is the kill switch, because it is
// the one answer the owner must never have to hunt for: "am I messaging
// customers right now?".

import { Button } from '@/components/ui/Button';
import { MIN_HOLDOUT_FOR_LIFT, type MarketingOverview, type MarketingTab, type PlaybookKey } from '@/lib/marketing/types';
import { CampaignsTable } from './CampaignsTable';
import {
  describeRoi,
  formatCount,
  formatIstDate,
  formatLift,
  formatPercent,
  formatRoi,
  inr,
} from './format';
import type { ApiResource } from './hooks';
import { useKillSwitch } from './KillSwitch';
import { Kpi, Notice, Panel, ProgressBar, ResourceGate } from './ui';
import { WeeklyChart } from './WeeklyChart';

export interface TabNavigation {
  onNavigate: (tab: MarketingTab, playbook?: PlaybookKey) => void;
  onOpenCampaign: (id: string) => void;
}

export function OverviewTab({
  overview,
  onNavigate,
  onOpenCampaign,
}: { overview: ApiResource<MarketingOverview> } & TabNavigation) {
  return (
    <ResourceGate resource={overview} label="Loading your overview…">
      {(data) => <OverviewBody data={data} reload={overview.reload} onNavigate={onNavigate} onOpenCampaign={onOpenCampaign} />}
    </ResourceGate>
  );
}

/** Exported for the render smoke test (tests/marketingDashboardRender.test.ts). */
export function OverviewBody({
  data,
  reload,
  onNavigate,
  onOpenCampaign,
}: { data: MarketingOverview; reload: () => void } & TabNavigation) {
  const { kpis } = data;
  const { ask, dialog } = useKillSwitch({ monthlyBudgetInr: kpis.monthly_budget_inr, onChanged: reload });

  const overBudget = kpis.month_spend_inr > kpis.monthly_budget_inr;
  // The receipts notice below replaces this insight; showing both would say the same thing twice.
  const insights = (data.insights ?? []).filter((i) => i.id !== 'receipts_not_connected');

  return (
    <div className="flex flex-col gap-5">
      {/* 1. Kill switch */}
      <div
        className={
          'flex flex-wrap items-center justify-between gap-3 rounded-md border p-4 ' +
          (data.enabled ? 'border-green-200 bg-green-50' : 'border-amber-300 bg-amber-50')
        }
      >
        <div className="min-w-0">
          <p className={'text-lg font-bold ' + (data.enabled ? 'text-green-900' : 'text-amber-900')}>
            <span aria-hidden="true">{data.enabled ? '● ' : '○ '}</span>
            {data.enabled ? 'Sending is ON' : 'Sending is OFF'}
          </p>
          <p className="mt-0.5 max-w-2xl text-sm text-charcoal">
            {data.enabled
              ? 'Campaigns you approve are being sent to customers who opted in, inside your send window and within your monthly budget.'
              : 'Nothing is being sent to anyone, whatever has been approved. This is the safe default until you are ready.'}
          </p>
        </div>
        <Button variant={data.enabled ? 'secondary' : 'primary'} onClick={() => ask(!data.enabled)}>
          {data.enabled ? 'Turn sending off' : 'Turn sending on'}
        </Button>
      </div>

      {!data.whatsapp_configured ? (
        <Notice tone="warn" title="WhatsApp is not connected on the server">
          Until it is, every message would be skipped as “WhatsApp is not configured” instead of sent. Ask your developer to set <code className="font-mono text-xs">WHATSAPP_TOKEN</code> and{' '}
          <code className="font-mono text-xs">WHATSAPP_PHONE_ID</code>.
        </Notice>
      ) : null}

      {data.pending_approvals > 0 ? (
        <Notice
          tone="info"
          title={`${data.pending_approvals} campaign${data.pending_approvals === 1 ? ' is' : 's are'} waiting for your OK`}
          action={<Button size="sm" onClick={() => onNavigate('approvals')}>Review and approve</Button>}
        >
          Nothing is sent until you approve it. Each one shows what it will cost and what it should bring back.
        </Notice>
      ) : null}

      {/* 2. Drop alert */}
      {data.drop_alert ? (
        <Notice
          tone="bad"
          role="alert"
          title={`Fewer customers ordered last week: down ${data.drop_alert.drop_pct}%`}
          action={
            <Button size="sm" onClick={() => onNavigate('playbooks', 'winback_1')}>
              Plan a win-back
            </Button>
          }
        >
          In the week of {formatIstDate(data.drop_alert.week_start)}, {formatCount(data.drop_alert.last_week_customers)} customers ordered, compared with about{' '}
          {data.drop_alert.baseline_customers} a week over the 4 weeks before, roughly {formatCount(data.drop_alert.drop_customers)} fewer. A win-back message
          can bring some of them back.
        </Notice>
      ) : null}

      {/* 3. Receipts */}
      {!data.receipts_connected ? (
        <Notice tone="warn" title="Delivery receipts are not connected">
          WhatsApp has not reported a single message as delivered or read. Until it does, STOP and START replies, delivery and read counts and the measured lift do not work. Ask your developer to set{' '}
          <code className="font-mono text-xs">WHATSAPP_APP_SECRET</code> and subscribe the webhook to <code className="font-mono text-xs">messages</code> and{' '}
          <code className="font-mono text-xs">user_preferences</code> (see docs/MARKETING-AGENT-SETUP.md, step 3).
        </Notice>
      ) : null}

      {/* 4. KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Kpi
          label="Customers who opted in"
          value={formatCount(kpis.opted_in)}
          hint={
            kpis.active_opted_in_pct === null
              ? 'No active customers yet'
              : `${formatPercent(kpis.active_opted_in_pct)} of your active customers can get offers`
          }
        />
        <Kpi
          label="Spent this month"
          value={inr(kpis.month_spend_inr)}
          hint={overBudget ? `Over the ${inr(kpis.monthly_budget_inr)} budget` : `of your ${inr(kpis.monthly_budget_inr)} budget`}
        >
          <ProgressBar
            value={kpis.month_spend_inr}
            max={kpis.monthly_budget_inr}
            label="Spent this month against the monthly budget"
            valueText={`${inr(kpis.month_spend_inr)} of ${inr(kpis.monthly_budget_inr)}`}
          />
        </Kpi>
        <Kpi
          label="Messages sent · 30 days"
          value={formatCount(kpis.messages_sent_30d)}
          hint={
            kpis.delivered_pct_30d === null
              ? 'Delivery tracking is not connected yet'
              : `${formatPercent(kpis.delivered_pct_30d)} delivered · ${formatPercent(kpis.read_pct_30d)} read`
          }
        />
        <Kpi
          label="Returning orders · 30 days"
          value={formatCount(kpis.returning_orders_30d)}
          hint={`${inr(kpis.returning_revenue_30d_inr)} of orders from customers we messaged`}
        />
        <Kpi
          label="Measured lift"
          value={kpis.lift_pp === null ? '—' : formatLift(kpis.lift_pp)}
          hint={
            kpis.lift_pp === null
              ? `Not enough data yet. It needs a comparison group of at least ${MIN_HOLDOUT_FOR_LIFT} people who were not messaged.`
              : 'more customers came back than among people we did not message'
          }
        />
        <Kpi
          label="Estimated ROI"
          value={formatRoi(kpis.est_roi)}
          hint={kpis.est_roi === null ? 'Nothing has been spent yet' : describeRoi(kpis.est_roi)}
        />
      </div>

      {/* 5. Insights */}
      <Panel title="What the agent noticed">
        {insights.length === 0 ? (
          <p className="text-sm text-muted">Nothing to flag right now. It looks at Beanies, lapsed customers, opt-ins and product costs every day.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[#f2efe9]">
            {insights.map((i) => (
              <li key={i.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <p className="flex items-start gap-2 text-sm text-charcoal">
                  <span
                    aria-hidden="true"
                    className={
                      'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ' +
                      (i.tone === 'warn' ? 'bg-amber-100 text-amber-900' : 'bg-surface text-tan-dark')
                    }
                  >
                    {i.tone === 'warn' ? '!' : 'i'}
                  </span>
                  <span>
                    <span className="sr-only">{i.tone === 'warn' ? 'Heads up: ' : 'Tip: '}</span>
                    {i.message}
                  </span>
                </p>
                {i.cta ? (
                  <Button variant="secondary" size="sm" className="shrink-0 self-start sm:self-auto" onClick={() => onNavigate(i.cta!.tab, i.cta!.playbook_key)}>
                    {i.cta.label}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* 6. Weekly chart */}
      <Panel title="Customers and orders, last 9 weeks" subtitle="Weeks run Monday to Sunday, India time. Tap a week for its numbers.">
        <WeeklyChart points={data.weekly ?? []} dropWeekStart={data.drop_alert?.week_start ?? null} />
      </Panel>

      {/* 7. Recent campaigns */}
      <Panel
        title="Recent campaigns"
        action={
          <Button variant="ghost" size="sm" onClick={() => onNavigate('campaigns')}>
            All campaigns
          </Button>
        }
      >
        <CampaignsTable rows={data.recent_campaigns ?? []} onOpen={onOpenCampaign} emptyMessage="No campaigns yet. Once a playbook is on Review, its first campaign shows up here." />
      </Panel>

      {dialog}
    </div>
  );
}
