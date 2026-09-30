'use client';

// One campaign in full (spec §7.4): who was in it, what happened to each person,
// what it brought back and what it really achieved (lift over the held-back
// group). Opens from any campaign row on the Overview, Campaigns, Approvals and
// Playbooks views.

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Spinner } from '@/components/ui/Spinner';
import {
  MANUAL_CAMPAIGN_LABEL,
  PLAYBOOK_LABELS,
  RECIPIENT_PAGE_SIZE,
  type CampaignDetail,
  type CampaignResponse,
  type RecipientRow,
} from '@/lib/marketing/types';
import { API, requestJson } from './api';
import { attributionSentence, liftSentence, pageCount, recipientReason, unwrapCampaignDetail } from './campaignData';
import { GuardrailList, ProjectionGrid } from './CampaignParts';
import {
  CAMPAIGN_STATUS_LABELS,
  RECIPIENT_STATUS_LABELS,
  campaignTone,
  formatCount,
  formatIstDate,
  formatIstDateTime,
  formatLift,
  formatRate,
  inr,
  inrExact,
  recipientTone,
} from './format';
import { useApi } from './hooks';
import { ConfirmDialog, Drawer, ErrorNote, Notice, Pill } from './ui';
import { describeAudience } from './wizard';

export function CampaignDrawer({
  id,
  onClose,
  onChanged,
}: {
  /** null = closed. */
  id: string | null;
  onClose: () => void;
  /** The campaign was stopped: refresh the lists behind the drawer. */
  onChanged: () => void;
}) {
  return (
    <Drawer open={id !== null} onClose={onClose} title="Campaign details">
      {id ? <DrawerBody key={id} id={id} onChanged={onChanged} onClose={onClose} /> : null}
    </Drawer>
  );
}

function DrawerBody({ id, onChanged, onClose }: { id: string; onChanged: () => void; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const res = useApi<unknown>(API.campaign(id, page));
  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  if (res.state.status === 'loading') return <Spinner label="Loading the campaign…" />;
  if (res.state.status === 'error') return <ErrorNote error={res.state.error} onRetry={res.reload} />;
  const c = unwrapCampaignDetail(res.state.data);
  if (!c) {
    return (
      <Notice tone="bad" role="alert" title="This campaign could not be read">
        The server sent an answer this page does not understand. Try reloading.
      </Notice>
    );
  }

  const stoppable = c.status === 'draft' || c.status === 'pending_approval' || c.status === 'approved' || c.status === 'sending';
  const stop = async () => {
    setStopping(true);
    setStopError(null);
    const r = await requestJson<CampaignResponse>(API.cancel(c.id), { method: 'POST' });
    setStopping(false);
    if (!r.ok) {
      setStopError(r.error.message);
      return;
    }
    setStopOpen(false);
    onChanged();
    onClose();
  };

  return (
    <div className="flex flex-col gap-6">
      <Header c={c} stoppable={stoppable} onStop={() => setStopOpen(true)} />
      <Facts c={c} />
      <Results c={c} />

      <details className="rounded-md border border-line">
        <summary className="min-h-[44px] cursor-pointer px-4 py-3 text-sm font-bold text-charcoal">What we forecast before it went out</summary>
        <div className="flex flex-col gap-3 border-t border-line p-4">
          <ProjectionGrid projection={c.projection} />
          <GuardrailList flags={c.guardrail_flags ?? []} />
        </div>
      </details>

      <Recipients c={c} page={page} onPage={setPage} />

      <ConfirmDialog
        open={stopOpen}
        title="Stop this campaign?"
        confirmLabel="Yes, stop it"
        danger
        busy={stopping}
        error={stopError}
        onConfirm={stop}
        onCancel={() => setStopOpen(false)}
      >
        <p>Messages that have not been sent yet are cancelled and nobody else will be messaged. Messages that already went out cannot be recalled. This cannot be undone.</p>
      </ConfirmDialog>
    </div>
  );
}

export function Header({ c, stoppable, onStop }: { c: CampaignDetail; stoppable: boolean; onStop: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-xl font-bold text-charcoal">{c.name}</h3>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Pill tone={campaignTone(c.status)}>{CAMPAIGN_STATUS_LABELS[c.status]}</Pill>
          <span>{c.playbook_key ? PLAYBOOK_LABELS[c.playbook_key] : MANUAL_CAMPAIGN_LABEL}</span>
          <span>· planned for {formatIstDate(c.planned_for)}</span>
        </p>
      </div>
      {stoppable ? (
        <Button variant="secondary" size="sm" onClick={onStop}>
          Stop this campaign
        </Button>
      ) : null}
    </div>
  );
}

export function Facts({ c }: { c: CampaignDetail }) {
  const audience =
    c.kind === 'manual'
      ? describeAudience(c.audience.filter ?? {})
      : `${c.playbook_key ? PLAYBOOK_LABELS[c.playbook_key] : 'Playbook'}: customers who qualified on the day it was planned`;
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      <Fact label="Audience">{audience}</Fact>
      <Fact label="Who">
        {formatCount(c.treated_count)} messaged · {formatCount(c.holdout_count)} held back to measure
      </Fact>
      <Fact label="Offer">{c.offer_text || (c.offer.type === 'none' ? 'No offer' : '—')}</Fact>
      <Fact label="Template">
        <span className="font-mono">{c.template_name || 'Not set'}</span>
      </Fact>
      {c.audience.headline ? <Fact label="Headline">{c.audience.headline}</Fact> : null}
      <Fact label="Started">{c.started_at ? formatIstDateTime(c.started_at) + ' (IST)' : c.send_after ? `Not before ${formatIstDateTime(c.send_after)} (IST)` : 'Not sent yet'}</Fact>
      {c.completed_at ? <Fact label="Finished">{formatIstDateTime(c.completed_at)} (IST)</Fact> : null}
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-charcoal">{children}</dd>
    </div>
  );
}

export function Results({ c }: { c: CampaignDetail }) {
  const r = c.results;
  const t = c.totals;
  const noReceipts = t.sent > 0 && t.delivered === 0 && t.read === 0;
  return (
    <section>
      <h4 className="mb-2 text-sm font-bold uppercase tracking-wide text-charcoal">Results</h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Sent" value={formatCount(t.sent)} />
        <Stat label="Delivered" value={noReceipts ? '—' : formatCount(t.delivered)} hint={noReceipts ? 'receipts not received yet' : undefined} />
        <Stat label="Read" value={noReceipts ? '—' : formatCount(t.read)} />
        <Stat label="Tapped Order now" value={formatCount(t.clicked)} />
        <Stat label="Came back" value={formatCount(t.returned)} hint={r.treated_rate === null ? undefined : `${formatRate(r.treated_rate)} of those messaged`} />
        <Stat label="Revenue" value={inr(t.revenue_inr)} hint="from returning customers" />
        <Stat label="Spent on messages" value={inrExact(t.spend_inr)} hint={t.failed > 0 ? `${formatCount(t.failed)} failed, not charged` : undefined} />
        <Stat label="Skipped" value={formatCount(t.skipped)} hint="see the Reason column below" />
      </div>

      <div className="mt-3 rounded-md border border-tan bg-surface p-4">
        <p className="text-xs uppercase tracking-wide text-muted">Measured lift</p>
        <p className="mt-1 break-words font-mono text-xl font-bold text-charcoal sm:text-2xl">{r.lift_pp === null ? 'Not enough data yet' : formatLift(r.lift_pp)}</p>
        <p className="mt-1 text-sm text-charcoal">{liftSentence(r)}</p>
        {r.lift_pp !== null ? (
          <p className="mt-2 text-sm text-charcoal">
            Messaged: {formatCount(r.treated_converted)} of {formatCount(r.treated_delivered)} came back ({formatRate(r.treated_rate)}). Held back:{' '}
            {formatCount(r.holdout_converted)} of {formatCount(r.holdout_n)} came back on their own ({formatRate(r.holdout_rate)}).
            {r.incremental_orders !== null ? (
              <>
                {' '}
                That is about <strong>{formatCount(r.incremental_orders)}</strong> order{Math.round(r.incremental_orders) === 1 ? '' : 's'} the campaign caused.
              </>
            ) : null}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted">{attributionSentence(r)}</p>
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-[#f2efe9] p-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 break-words font-mono text-lg font-bold tabular-nums text-charcoal">{value}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Recipients({ c, page, onPage }: { c: CampaignDetail; page: number; onPage: (p: number) => void }) {
  const pages = pageCount(c.recipients_total);
  const columns: DataTableColumn<RecipientRow>[] = useMemo(
    () => [
      { key: 'name', header: 'Name', filter: 'text', value: (r) => r.first_name },
      { key: 'phone', header: 'Phone', filter: 'text', value: (r) => r.phone, cellClassName: 'font-mono text-xs whitespace-nowrap' },
      {
        key: 'group',
        header: 'Group',
        filter: 'select',
        value: (r) => (r.arm === 'holdout' ? 'Held back' : 'Messaged'),
      },
      {
        key: 'status',
        header: 'Status',
        filter: 'select',
        value: (r) => RECIPIENT_STATUS_LABELS[r.status],
        render: (r) => <Pill tone={recipientTone(r.status)}>{RECIPIENT_STATUS_LABELS[r.status]}</Pill>,
      },
      {
        key: 'reason',
        header: 'Reason',
        filter: 'text',
        value: (r) => recipientReason(r),
        cellClassName: 'min-w-[180px] text-xs text-charcoal',
      },
      { key: 'code', header: 'Code', filter: 'none', value: (r) => r.coupon_code, cellClassName: 'font-mono text-xs' },
      {
        key: 'sent',
        header: 'Sent',
        filter: 'none',
        sortable: true,
        value: (r) => r.sent_at,
        render: (r) => (r.sent_at ? formatIstDateTime(r.sent_at) : '—'),
        cellClassName: 'text-xs whitespace-nowrap',
      },
      {
        key: 'returned',
        header: 'Came back',
        filter: 'none',
        sortable: true,
        align: 'right',
        value: (r) => r.conversion_revenue_inr,
        render: (r) => (r.converted_at ? `${inr(r.conversion_revenue_inr)}${r.attributed_via ? ` (${r.attributed_via === 'coupon' ? 'used code' : 'ordered'})` : ''}` : '—'),
        cellClassName: 'text-xs whitespace-nowrap',
      },
    ],
    [],
  );

  return (
    <section>
      <h4 className="mb-1 text-sm font-bold uppercase tracking-wide text-charcoal">People in this campaign</h4>
      <p className="mb-2 text-xs text-muted">
        {formatCount(c.recipients_total)} in total{c.recipients_total > RECIPIENT_PAGE_SIZE ? `, ${RECIPIENT_PAGE_SIZE} per page` : ''}. Full numbers are shown because only you can see this page.
      </p>
      <DataTable
        rows={c.recipients ?? []}
        columns={columns}
        rowKey={(r) => r.id}
        emptyMessage="Nobody has been added to this campaign yet."
        minWidth={820}
        cellPadding="py-2 pr-3"
      />
      {pages > 1 ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            ← Previous
          </Button>
          <span className="text-sm text-muted">
            Page {page} of {pages}
          </span>
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            Next →
          </Button>
        </div>
      ) : null}
    </section>
  );
}
