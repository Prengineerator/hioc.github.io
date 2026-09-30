'use client';

// Playbooks (spec §7.3): the agent's five automated campaigns, in the order it
// considers them (a customer gets at most one agent message a day, from the
// highest-priority playbook they qualify for). Each card is a switch (Off /
// Review / Auto), the rules for who qualifies, the offer, the WhatsApp template,
// and how well it has worked so far.
//
// Nothing here saves on a keystroke: edits are drafts, and one Save sends only
// what changed (playbookForm.ts). Turning a playbook to Auto asks first.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { parseOffer } from '@/lib/marketing/parse';
import {
  PLAYBOOK_LABELS,
  type CostsResponse,
  type FreeItemCandidate,
  type PlaybookKey,
  type PlaybookMode,
  type PlaybookView,
  type PlaybooksResponse,
} from '@/lib/marketing/types';
import { API, requestJson } from './api';
import {
  CAMPAIGN_STATUS_LABELS,
  campaignTone,
  formatCount,
  formatIstDate,
  formatLiftShort,
  formatPercent,
  inr,
} from './format';
import { customerOfferText, describeOfferForOwner, draftToOfferInput } from './drafts';
import { OfferEditor, TemplateEditor } from './Editors';
import { useApi } from './hooks';
import {
  MODE_HELP,
  MODE_LABELS,
  PARAM_FIELDS,
  buildPlaybookPatch,
  describeChanges,
  paramBounds,
  playbookHasOffer,
  playbookToDraft,
  type PlaybookDraft,
} from './playbookForm';
import { TestSend } from './TestSend';
import { ConfirmDialog, Pill, ResourceGate, Segmented, TabIntro } from './ui';

export function PlaybooksTab({
  focusKey,
  onOpenCampaign,
  onChanged,
}: {
  /** An insight's "Turn on …" button lands here with that card open. */
  focusKey: PlaybookKey | null;
  onOpenCampaign: (id: string) => void;
  /** A mode changed: the Overview's insights and the tab badge may be stale. */
  onChanged: () => void;
}) {
  const list = useApi<PlaybooksResponse>(API.playbooks);
  // The free-item picker needs the cost ranking. A failure here must not hide the playbooks — the picker just falls back to "Auto".
  const costs = useApi<CostsResponse>(API.costs);
  const ranking: FreeItemCandidate[] = costs.state.status === 'ready' ? (costs.state.data.free_item_ranking ?? []) : [];
  const costsAvailable = costs.state.status === 'ready';

  return (
    <div className="flex flex-col gap-5">
      <TabIntro title="Playbooks">
        Each playbook is one kind of automatic campaign. They are listed in the order the agent considers them: a customer gets at most one message a day, from the first playbook they qualify for. All start Off.
      </TabIntro>

      <ResourceGate resource={list} label="Loading playbooks…">
        {(data) => (
          <div className="flex flex-col gap-5">
            {[...(data.playbooks ?? [])]
              .sort((a, b) => a.priority - b.priority)
              .map((view) => (
                <PlaybookCard
                  key={view.key}
                  view={view}
                  ranking={ranking}
                  costsAvailable={costsAvailable}
                  focused={focusKey === view.key}
                  onSaved={(saved) => {
                    list.update((d) => ({ playbooks: d.playbooks.map((p) => (p.key === saved.key ? saved : p)) }));
                    onChanged();
                  }}
                  onOpenCampaign={onOpenCampaign}
                />
              ))}
          </div>
        )}
      </ResourceGate>
    </div>
  );
}

/** Exported for the render smoke test (tests/marketingDashboardRender.test.ts). */
export function PlaybookCard({
  view,
  ranking,
  costsAvailable,
  focused,
  onSaved,
  onOpenCampaign,
}: {
  view: PlaybookView;
  ranking: FreeItemCandidate[];
  costsAvailable: boolean;
  focused: boolean;
  onSaved: (saved: PlaybookView) => void;
  onOpenCampaign: (id: string) => void;
}) {
  const [draft, setDraft] = useState<PlaybookDraft>(() => playbookToDraft(view));
  const [open, setOpen] = useState(focused);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // Arriving from an insight: open this card and bring it into view.
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focused]);

  const result = useMemo(() => buildPlaybookPatch(view, draft), [view, draft]);
  const hasOffer = playbookHasOffer(view.key);
  const parsedOffer = hasOffer ? parseOffer(draftToOfferInput(draft.offer)) : null;
  const offerSummary = !hasOffer
    ? 'No coupon: the customer’s own points are the offer'
    : parsedOffer && parsedOffer.ok
      ? describeOfferForOwner(parsedOffer.value, ranking)
      : 'Offer needs attention';
  const offerTextForPreview = parsedOffer && parsedOffer.ok ? customerOfferText(parsedOffer.value, ranking) : '';

  const edit = (patch: Partial<PlaybookDraft>) => {
    setSaved(false);
    setSaveError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const doSave = async () => {
    if (!result.patch) return;
    setSaving(true);
    setSaveError(null);
    const r = await requestJson<{ playbook: PlaybookView }>(API.playbook(view.key), { method: 'PATCH', body: result.patch });
    setSaving(false);
    if (!r.ok) {
      // The server's own sentence (a bound, a bad template name) — show it as it is.
      setSaveError(r.error.message);
      return;
    }
    setDraft(playbookToDraft(r.data.playbook));
    setAttempted(false);
    setSaved(true);
    onSaved(r.data.playbook);
  };

  const save = () => {
    setAttempted(true);
    if (result.error || !result.patch) return;
    // Auto sends without a look: say so before it is switched on, not after.
    if (draft.mode === 'auto' && view.mode !== 'auto') {
      setConfirmAuto(true);
      return;
    }
    void doSave();
  };

  const visibleError = saveError ?? (attempted ? (result.error ?? null) : null);

  return (
    <article ref={ref} className="rounded-md border border-line bg-cream p-5 shadow-sm" aria-label={view.label}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Priority {view.priority}</p>
          <h3 className="text-lg font-bold text-charcoal">{PLAYBOOK_LABELS[view.key] ?? view.label}</h3>
          <p className="mt-1 max-w-xl text-sm text-charcoal">{view.description}</p>
          <p className="mt-2 text-sm text-muted">
            Offer: <span className="text-charcoal">{offerSummary}</span> · Template:{' '}
            <span className={draft.template.name ? 'font-mono text-charcoal' : 'font-bold text-red-700'}>{draft.template.name || 'not set'}</span>
          </p>
          <p className="mt-1 text-sm text-muted">
            <ConversionSummary view={view} />
          </p>
        </div>

        <div className="flex flex-col gap-2 lg:items-end">
          <Segmented<PlaybookMode>
            label={`${view.label} mode`}
            value={draft.mode}
            onChange={(mode) => edit({ mode })}
            options={(['off', 'review', 'auto'] as const).map((m) => ({ value: m, label: MODE_LABELS[m] }))}
          />
          <p className="max-w-sm text-sm text-charcoal lg:text-right">{MODE_HELP[draft.mode]}</p>
          {draft.mode !== view.mode ? <Pill tone="warn">Not saved yet: press Save below</Pill> : null}
        </div>
      </div>

      <div className="mt-4">
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide settings ▴' : 'Edit who, offer and message ▾'}
        </Button>
      </div>

      {open ? (
        <div className="mt-2 flex flex-col gap-6 border-t border-line pt-5">
          <Section title="Who qualifies">
            <div className="grid gap-3 sm:grid-cols-2">
              {PARAM_FIELDS[view.key].map((f) => {
                const b = paramBounds(view.key, f.name);
                return (
                  <Input
                    key={f.name}
                    label={`${f.label} (${f.unit})`}
                    type="number"
                    inputMode="decimal"
                    step={f.step}
                    min={b.min}
                    max={b.max}
                    value={draft.params[f.name] ?? ''}
                    onChange={(e) => edit({ params: { ...draft.params, [f.name]: e.target.value } })}
                    hint={`${f.help} Allowed: ${b.min} to ${b.max}.`}
                  />
                );
              })}
            </div>
          </Section>

          <Section title="Offer">
            {hasOffer ? (
              <OfferEditor
                draft={draft.offer}
                onChange={(offer) => edit({ offer })}
                ranking={ranking}
                costsAvailable={costsAvailable}
              />
            ) : (
              <p className="text-sm text-charcoal">
                Points reminders carry no coupon. The customer’s own points are the offer, so there is nothing to set here.
              </p>
            )}
          </Section>

          <Section title="WhatsApp message">
            <TemplateEditor
              draft={draft.template}
              onChange={(template) => edit({ template })}
              allowHeadline={false}
              offerTextValue={hasOffer ? offerTextForPreview : ''}
            />
            <TestSend template={draft.template} />
          </Section>

          <Section title="Expected conversion">
            <p className="text-sm text-charcoal">
              <ConversionSummary view={view} long />
            </p>
            <div className="mt-3 max-w-xs">
              <Input
                label="Starting guess (% who come back)"
                type="number"
                inputMode="decimal"
                step={0.5}
                min={0}
                max={100}
                value={draft.prior}
                onChange={(e) => edit({ prior: e.target.value })}
                hint="Research suggests this figure. The agent blends in what really happens in your cafe as campaigns finish."
              />
            </div>
          </Section>

          <Section title="Recent runs">
            {(view.last_runs ?? []).length === 0 ? (
              <p className="text-sm text-muted">This playbook has not run yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-[#f2efe9]">
                {(view.last_runs ?? []).map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-semibold text-charcoal">{formatIstDate(c.planned_for)}</span>{' '}
                      <Pill tone={campaignTone(c.status)}>{CAMPAIGN_STATUS_LABELS[c.status]}</Pill>
                    </span>
                    <span className="text-muted">
                      {formatCount(c.totals.sent)} sent · {formatCount(c.totals.returned)} returned · {inr(c.totals.revenue_inr)} · lift {formatLiftShort(c.lift_pp)}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => onOpenCampaign(c.id)}>
                      Details
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button onClick={save} loading={saving} disabled={result.changed.length === 0 || saving}>
          Save
        </Button>
        <span className="text-sm text-muted">{describeChanges(result.changed)}</span>
        {result.changed.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(playbookToDraft(view));
              setAttempted(false);
              setSaveError(null);
            }}
          >
            Undo changes
          </Button>
        ) : null}
        {saved ? (
          <span role="status" className="text-sm font-semibold text-green-800">
            ✓ Saved
          </span>
        ) : null}
      </div>
      {visibleError ? (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
          {visibleError}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmAuto}
        title={`Turn on Auto for “${view.label}”?`}
        confirmLabel="Yes, let it send on its own"
        busy={saving}
        error={saveError}
        onConfirm={async () => {
          await doSave();
          setConfirmAuto(false);
        }}
        onCancel={() => setConfirmAuto(false)}
      >
        <p>
          On Auto, when this playbook finds customers and <strong>every safety check passes</strong>, the agent sends the messages without asking you first. Each message costs money.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Anything with a warning (thin margin, over budget, costs missing…) still comes to Approvals.</li>
          <li>Nothing is sent while the master Sending switch is off.</li>
        </ul>
        <p className="text-muted">A good rule: stay on Review for about two campaigns, and move to Auto once they showed a positive measured lift and no warnings.</p>
      </ConfirmDialog>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-3 text-sm font-bold uppercase tracking-wide text-charcoal">{title}</h4>
      {children}
    </section>
  );
}

/** "Starts at 15%, learning 12.4% from 240 delivered messages (30 came back)". */
function ConversionSummary({ view, long = false }: { view: PlaybookView; long?: boolean }) {
  const prior = Number(view.prior_conversion_pct);
  if (view.observed_treated === 0) {
    return (
      <>
        Expected to bring back <strong>{formatPercent(prior, prior % 1 ? 1 : 0)}</strong>
        {long ? ' of the people messaged (a starting guess from research). No campaign has finished yet, so nothing has been learned.' : ' (starting guess, nothing learned yet)'}
      </>
    );
  }
  return (
    <>
      Starting guess <strong>{formatPercent(prior, prior % 1 ? 1 : 0)}</strong>, now learning <strong>{formatPercent(view.learned_conversion_pct, 1)}</strong> from{' '}
      {formatCount(view.observed_treated)} delivered messages ({formatCount(view.observed_conversions)} came back)
      {long ? '. Forecasts use the learned figure.' : ''}
    </>
  );
}
