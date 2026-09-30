'use client';

// The Marketing card on the /owner overview (flag on): what needs the owner's
// attention today — campaigns waiting for approval, this month's WhatsApp spend
// against the budget, and a customer-drop alert — with one link into
// /owner/marketing.
//
// It reads the SUMMARY (?summary=1: settings, a campaign count, the month's spend and ten
// weeks of orders), not the full overview: this card loads on every /owner visit, and the full
// overview joins a year of orders and the whole points ledger.
//
// It is a courtesy, never a blocker: while loading, and on ANY failure (the
// migration not applied yet, a network blip, a 500), it renders nothing at all. The
// Overview must not grow a red error box because an optional feature isn't
// set up, and the real explanation lives on /owner/marketing where the owner can
// act on it.

import { useEffect, useState } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card } from '@/components/owner/dashboard';
import type { MarketingOverviewSummary } from '@/lib/marketing/types';
import { API, requestJson } from './api';
import { formatPercent, inr } from './format';
import { Pill, ProgressBar } from './ui';

/** The one request this card makes: the light summary, never the full overview. */
export function fetchMarketingSummary(signal?: AbortSignal) {
  return requestJson<MarketingOverviewSummary>(API.overviewSummary, { signal });
}

export function OwnerMarketingCard() {
  const [data, setData] = useState<MarketingOverviewSummary | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchMarketingSummary(ac.signal).then((r) => {
      if (!ac.signal.aborted && r.ok) setData(r.data);
    });
    return () => ac.abort();
  }, []);

  if (!data) return null;
  return <OwnerMarketingCardBody data={data} />;
}

export function OwnerMarketingCardBody({ data }: { data: MarketingOverviewSummary }) {
  const drop = data.drop_alert;
  return (
    <Card title="Marketing">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Waiting for your OK</p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-charcoal">{data.pending_approvals}</p>
          <p className="text-xs text-muted">{data.pending_approvals === 0 ? 'nothing to approve' : data.pending_approvals === 1 ? 'campaign to review' : 'campaigns to review'}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">WhatsApp spend this month</p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-charcoal">
            {inr(data.month_spend_inr)} <span className="text-sm font-normal text-muted">of {inr(data.month_budget_inr)}</span>
          </p>
          <ProgressBar
            value={data.month_spend_inr}
            max={data.month_budget_inr}
            label="Spent this month against the monthly budget"
            valueText={`${inr(data.month_spend_inr)} of ${inr(data.month_budget_inr)}`}
          />
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Customers last week</p>
          {drop ? (
            <>
              <p className="mt-1 text-sm font-bold text-red-700">
                <span aria-hidden="true">▼ </span>
                Down {formatPercent(drop.drop_pct)}
              </p>
              <p className="text-xs text-muted">
                {drop.last_week_customers} ordered, against about {drop.baseline_customers} a week before
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-charcoal">No drop in customers</p>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Pill tone={data.enabled ? 'good' : 'warn'}>{data.enabled ? 'Sending is ON' : 'Sending is OFF'}</Pill>
        <Link
          href={data.pending_approvals > 0 ? '/owner/marketing?tab=approvals' : '/owner/marketing'}
          className="inline-flex min-h-[44px] items-center text-sm font-bold text-tan-dark hover:underline"
        >
          {data.pending_approvals > 0 ? 'Review campaigns →' : 'Open marketing →'}
        </Link>
      </div>
    </Card>
  );
}
