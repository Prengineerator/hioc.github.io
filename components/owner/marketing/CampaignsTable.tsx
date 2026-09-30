'use client';

// One table for campaigns, used by the Overview ("recent") and the Campaigns tab
// (active + history): status, how far it got, what it brought back, what it cost
// and the measured lift. Built on the shared DataTable (sortable, filterable,
// scrolls sideways inside its own card so the page never does).

import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { MANUAL_CAMPAIGN_LABEL, PLAYBOOK_LABELS, type CampaignSummary } from '@/lib/marketing/types';
import { CAMPAIGN_STATUS_LABELS, campaignTone, formatCount, formatIstDate, formatLiftShort, inr } from './format';
import { Pill } from './ui';

/** Delivered / read are 0 while WhatsApp receipts aren't flowing, which is "unknown", not "nobody" — show a dash. */
function receipt(c: CampaignSummary, n: number): string {
  if (c.totals.sent > 0 && c.totals.delivered === 0 && c.totals.read === 0) return '—';
  return formatCount(n);
}

export function CampaignsTable({
  rows,
  onOpen,
  emptyMessage,
}: {
  rows: CampaignSummary[];
  onOpen: (id: string) => void;
  emptyMessage: string;
}) {
  const columns: DataTableColumn<CampaignSummary>[] = [
    {
      key: 'name',
      header: 'Campaign',
      filter: 'text',
      value: (c) => c.name,
      render: (c) => (
        <div className="min-w-[150px]">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(c.id);
            }}
            className="min-h-[40px] text-left font-bold text-tan-dark hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
          >
            {c.name}
          </button>
          <p className="text-xs text-muted">
            {c.playbook_key ? PLAYBOOK_LABELS[c.playbook_key] : MANUAL_CAMPAIGN_LABEL} · {formatIstDate(c.planned_for)}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      filter: 'select',
      value: (c) => CAMPAIGN_STATUS_LABELS[c.status],
      render: (c) => <Pill tone={campaignTone(c.status)}>{CAMPAIGN_STATUS_LABELS[c.status]}</Pill>,
    },
    { key: 'sent', header: 'Sent', filter: 'none', sortable: true, align: 'right', value: (c) => c.totals.sent, render: (c) => formatCount(c.totals.sent) },
    {
      key: 'delivered',
      header: 'Delivered',
      filter: 'none',
      sortable: true,
      align: 'right',
      value: (c) => c.totals.delivered,
      render: (c) => receipt(c, c.totals.delivered),
    },
    { key: 'read', header: 'Read', filter: 'none', sortable: true, align: 'right', value: (c) => c.totals.read, render: (c) => receipt(c, c.totals.read) },
    { key: 'clicked', header: 'Clicked', filter: 'none', sortable: true, align: 'right', value: (c) => c.totals.clicked, render: (c) => formatCount(c.totals.clicked) },
    { key: 'returned', header: 'Returned', filter: 'none', sortable: true, align: 'right', value: (c) => c.totals.returned, render: (c) => formatCount(c.totals.returned) },
    { key: 'revenue', header: 'Revenue', filter: 'none', sortable: true, align: 'right', value: (c) => c.totals.revenue_inr, render: (c) => inr(c.totals.revenue_inr) },
    { key: 'spend', header: 'Spend', filter: 'none', sortable: true, align: 'right', value: (c) => c.totals.spend_inr, render: (c) => inr(c.totals.spend_inr) },
    {
      key: 'lift',
      header: 'Lift',
      filter: 'none',
      sortable: true,
      align: 'right',
      value: (c) => c.lift_pp,
      render: (c) => (
        <span title={c.lift_pp === null ? 'Not enough data yet: the comparison group is too small or nothing has been sent' : 'Extra returns compared with people we did not message (percentage points)'}>
          {formatLiftShort(c.lift_pp)}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(c) => c.id}
      emptyMessage={emptyMessage}
      onRowClick={(c) => onOpen(c.id)}
      minWidth={880}
      cellPadding="py-2 pr-3"
      className="text-charcoal"
    />
  );
}
