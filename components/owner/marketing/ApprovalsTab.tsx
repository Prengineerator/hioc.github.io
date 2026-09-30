'use client';

// Approvals (spec §7.2): every campaign waiting for the owner's OK, priced. This is
// where money and consent decisions are made, so each card leads with the
// numbers that matter (cost, expected profit, break-even) and the warnings, and
// "Approve & send" always asks once more, in words, before anything is sent.

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  MANUAL_CAMPAIGN_LABEL,
  PLAYBOOK_LABELS,
  type CampaignResponse,
  type CampaignSummary,
  type CampaignsResponse,
} from '@/lib/marketing/types';
import { approvalMessageCount, maxMessageCost, pluralize } from './approvals';
import { API, requestJson } from './api';
import { GuardrailList, ProjectionGrid, SamplePreviews } from './CampaignParts';
import {
  CAMPAIGN_STATUS_LABELS,
  campaignTone,
  formatIstDate,
  formatIstDateTime,
  inr,
  inrExact,
  signedInr,
} from './format';
import { useApi } from './hooks';
import { ConfirmDialog, Notice, Pill, ResourceGate, TabIntro } from './ui';

export function ApprovalsTab({
  sendingEnabled,
  onChanged,
  onOpenCampaign,
}: {
  /** From the overview: false means "approved messages will wait", which the dialog must say. */
  sendingEnabled: boolean | null;
  /** Something was approved or skipped: refresh the tab badge and the overview. */
  onChanged: () => void;
  onOpenCampaign: (id: string) => void;
}) {
  const list = useApi<CampaignsResponse>(API.campaigns('pending_approval'));
  const [flash, setFlash] = useState<string | null>(null);

  const finish = (id: string, message: string) => {
    list.update((d) => ({ campaigns: d.campaigns.filter((c) => c.id !== id) }));
    setFlash(message);
    onChanged();
  };

  return (
    <div className="flex flex-col gap-5">
      <TabIntro title="Waiting for your OK">
        Nothing here is sent until you approve it. Each card shows what the messages will cost, what should come back and whether it pays for itself.
      </TabIntro>

      {flash ? (
        <Notice tone="good" role="status">
          {flash}
        </Notice>
      ) : null}

      <ResourceGate resource={list} label="Loading campaigns waiting for approval…">
        {(data) =>
          (data.campaigns ?? []).length === 0 ? (
            <div className="rounded-md border border-line bg-cream p-8 text-center shadow-sm">
              <p className="font-bold text-charcoal">Nothing is waiting for approval</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted">
                When a playbook is on Review, the agent prepares a campaign each morning and it appears here first. You can also make your own in Campaigns → New campaign.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {(data.campaigns ?? []).map((c) => (
                <ApprovalCard key={c.id} campaign={c} sendingEnabled={sendingEnabled} onDone={finish} onOpen={onOpenCampaign} />
              ))}
            </div>
          )
        }
      </ResourceGate>
    </div>
  );
}

/** Exported for the render smoke test (tests/marketingDashboardRender.test.ts). */
export function ApprovalCard({
  campaign: c,
  sendingEnabled,
  onDone,
  onOpen,
}: {
  campaign: CampaignSummary;
  sendingEnabled: boolean | null;
  onDone: (id: string, message: string) => void;
  onOpen: (id: string) => void;
}) {
  const [dialog, setDialog] = useState<'approve' | 'skip' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flags = c.guardrail_flags ?? [];
  const count = approvalMessageCount(c);
  const maxCost = maxMessageCost(c);
  const p = c.projection;
  const isPoints = c.playbook_key !== null && c.playbook_key.startsWith('points_');
  const hasCoupon = c.offer.type !== 'none';

  const act = async (kind: 'approve' | 'skip') => {
    setBusy(true);
    setError(null);
    const r = await requestJson<CampaignResponse>(kind === 'approve' ? API.approve(c.id) : API.cancel(c.id), { method: 'POST' });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    setDialog(null);
    onDone(
      c.id,
      kind === 'approve'
        ? sendingEnabled === false
          ? `Approved “${c.name}”. Sending is OFF, so it will wait until you turn sending on.`
          : `Approved “${c.name}”. It sends during your send window, within your budget.`
        : `Skipped “${c.name}”. Nobody was messaged.`,
    );
  };

  return (
    <article className="rounded-md border border-line bg-cream p-5 shadow-sm" aria-label={c.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-charcoal">{c.name}</h3>
          <p className="text-sm text-muted">
            {c.playbook_key ? PLAYBOOK_LABELS[c.playbook_key] : MANUAL_CAMPAIGN_LABEL} · planned for {formatIstDate(c.planned_for)}
          </p>
        </div>
        <Pill tone={campaignTone(c.status)}>{CAMPAIGN_STATUS_LABELS[c.status]}</Pill>
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Who</dt>
          <dd className="text-charcoal">
            <span className="font-bold">{pluralize(c.treated_count || p.treated, 'person', 'people')}</span> get the message
            {c.holdout_count > 0 ? (
              <>
                , and <span className="font-bold">{pluralize(c.holdout_count, 'person', 'people')}</span> are held back on purpose so we can measure what it really achieves
              </>
            ) : null}
            .
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Offer</dt>
          <dd className="text-charcoal">
            {c.offer_text ? c.offer_text : isPoints ? 'No coupon. Their own Beanies are the offer.' : 'No offer'}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">WhatsApp template</dt>
          <dd className={c.template_name ? 'font-mono text-charcoal' : 'font-bold text-red-700'}>{c.template_name || 'Not set'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">When</dt>
          <dd className="text-charcoal">{c.send_after ? `Not before ${formatIstDateTime(c.send_after)} (IST)` : 'As soon as you approve it'}</dd>
        </div>
      </dl>

      <div className="mt-4">
        <ProjectionGrid projection={p} />
      </div>

      {flags.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-sm font-bold text-red-800">
            {flags.length === 1 ? '1 warning' : `${flags.length} warnings`}: Auto mode would not send this without you
          </p>
          <GuardrailList flags={flags} />
        </div>
      ) : null}

      <div className="mt-4">
        <p className="mb-2 text-sm font-bold text-charcoal">How the message will read</p>
        <SamplePreviews samples={c.samples ?? []} hasCoupon={hasCoupon} />
      </div>

      <div className="mt-5 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:flex-wrap sm:items-center">
        <Button
          onClick={() => {
            setError(null);
            setDialog('approve');
          }}
        >
          Approve &amp; send
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setError(null);
            setDialog('skip');
          }}
        >
          Skip
        </Button>
        <Button variant="ghost" onClick={() => onOpen(c.id)}>
          See who is in it
        </Button>
      </div>

      <ConfirmDialog
        open={dialog === 'approve'}
        title={`Send ${pluralize(count, 'message')}?`}
        confirmLabel={`Approve and send ${pluralize(count, 'message')}`}
        busy={busy}
        error={error}
        onConfirm={() => act('approve')}
        onCancel={() => setDialog(null)}
      >
        <p>
          This will send <strong>{pluralize(count, 'WhatsApp message')}</strong> to customers who opted in. The most it can cost in message fees is{' '}
          <strong>{inrExact(maxCost)}</strong> ({count.toLocaleString('en-IN')} × {inrExact(p.message_cost_inr)}).
        </p>
        <ul className="list-disc space-y-1 pl-5">
          {p.offer_spend_inr > 0 ? (
            <li>
              If the returning customers use their offer, it costs you about <strong>{inr(p.offer_spend_inr)}</strong> more.
            </li>
          ) : null}
          <li>
            Expected profit after all costs: <strong>{signedInr(p.expected_profit_inr)}</strong>. That is a forecast, not a promise.
          </li>
          <li>Anyone who opts out before their message goes out is skipped automatically.</li>
        </ul>
        {flags.length > 0 ? (
          <Notice tone="warn" title="This campaign has warnings">
            <GuardrailList flags={flags} />
          </Notice>
        ) : null}
        {sendingEnabled === false ? (
          <Notice tone="warn" title="Sending is currently OFF">
            Approving is fine, but nothing goes out until you turn sending on from the Overview.
          </Notice>
        ) : null}
        {c.send_after ? <p className="text-muted">It will not send before {formatIstDateTime(c.send_after)} (IST).</p> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'skip'}
        title="Skip this campaign?"
        confirmLabel="Yes, skip it"
        danger
        busy={busy}
        error={error}
        onConfirm={() => act('skip')}
        onCancel={() => setDialog(null)}
      >
        <p>
          The {pluralize(count, 'person', 'people')} in “{c.name}” will not be messaged, and this cannot be undone. The agent may plan a new campaign on a later day if they still qualify.
        </p>
      </ConfirmDialog>
    </article>
  );
}
