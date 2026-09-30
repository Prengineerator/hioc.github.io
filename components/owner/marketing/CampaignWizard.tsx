'use client';

// "New campaign" (spec §7.4): the owner's own push — a new item, a slow-day offer —
// in five steps, with a live forecast beside it (POST /campaigns/preview, debounced
// 400 ms) so the price of every choice is visible while it is being made. The end
// of the wizard is "Create draft": a draft appears in Approvals and NOTHING is sent
// until it is approved there.
//
// Every step is validated by the same parsers the server uses (wizard.ts), so a
// step never passes something "Create draft" would refuse.

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { parseAudienceFilter, parseOffer } from '@/lib/marketing/parse';
import {
  AUDIENCE_BOUNDS,
  CAMPAIGN_NAME_MAX,
  HEADLINE_MAX,
  LIFECYCLE_STAGES,
  LIFECYCLE_STAGE_LABELS,
  type CampaignPreview,
  type CampaignResponse,
  type CostsResponse,
  type FreeItemCandidate,
  type LifecycleStage,
} from '@/lib/marketing/types';
import { API, isAborted, requestJson, type ApiFailure } from './api';
import { GuardrailList, ProjectionGrid, SamplePreviews } from './CampaignParts';
import { customerOfferText, describeOfferForOwner, draftToOfferInput } from './drafts';
import { OfferEditor, TemplateEditor } from './Editors';
import { formatCount, formatIstDateTime, inr, signedInr } from './format';
import { useApi, useDebounced } from './hooks';
import { TestSend } from './TestSend';
import { CheckRow, ErrorNote, Notice, Panel, Segmented } from './ui';
import {
  LAST_WIZARD_STEP,
  WIZARD_STEPS,
  audienceToInput,
  describeAudience,
  emptyWizard,
  firstInvalidStep,
  istLocalToIso,
  nowAsIstLocal,
  offerTemplateMismatch,
  toManualInput,
  validateStep,
  wizardWarnings,
  type WizardState,
  type WizardStepId,
} from './wizard';

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; last?: CampaignPreview }
  | { status: 'ready'; data: CampaignPreview }
  | { status: 'error'; error: ApiFailure };

export function CampaignWizard({
  onClose,
  onCreated,
  onGoToApprovals,
}: {
  onClose: () => void;
  /** A draft was created: refresh the Approvals badge. */
  onCreated: () => void;
  onGoToApprovals: () => void;
}) {
  const [state, setState] = useState<WizardState>(() => emptyWizard());
  const [step, setStep] = useState<WizardStepId>(1);
  const [stepError, setStepError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);

  const costs = useApi<CostsResponse>(API.costs);
  const ranking: FreeItemCandidate[] = costs.state.status === 'ready' ? (costs.state.data.free_item_ranking ?? []) : [];
  const costsAvailable = costs.state.status === 'ready';

  const set = (patch: Partial<WizardState>) => {
    setStepError(null);
    setCreateError(null);
    setState((s) => ({ ...s, ...patch }));
  };

  // ---- live forecast --------------------------------------------------------
  // The request body is the parsed, normalised campaign (or null while something is
  // invalid). Debouncing the SERIALISED body means typing in a box that doesn't
  // change the body (or a keystroke that undoes the last) sends nothing.
  const parsed = useMemo(() => toManualInput(state, { preview: true }), [state]);
  // The forecast does not depend on the campaign's name or schedule, so blank them: typing a name must not
  // re-price the audience (the preview endpoint walks every customer and order).
  const body = useMemo(() => (parsed.ok ? JSON.stringify({ ...parsed.value, name: '', send_after: null }) : 'null'), [parsed]);
  const debouncedBody = useDebounced(body, 400);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });

  useEffect(() => {
    if (debouncedBody === 'null') return;
    const ac = new AbortController();
    setPreview((p) => ({ status: 'loading', last: p.status === 'ready' ? p.data : p.status === 'loading' ? p.last : undefined }));
    requestJson<CampaignPreview>(API.campaignPreview, { method: 'POST', body: JSON.parse(debouncedBody), signal: ac.signal }).then((r) => {
      if (ac.signal.aborted) return;
      if (r.ok) setPreview({ status: 'ready', data: r.data });
      else if (!isAborted(r.error)) setPreview({ status: 'error', error: r.error });
    });
    return () => ac.abort();
  }, [debouncedBody]);

  const shownPreview = preview.status === 'ready' ? preview.data : preview.status === 'loading' ? preview.last : undefined;
  const refreshing = preview.status === 'loading' || body !== debouncedBody;

  // ---- navigation -----------------------------------------------------------
  const goNext = () => {
    const err = validateStep(step, state);
    if (err) {
      setStepError(err);
      return;
    }
    setStepError(null);
    setStep((s) => (s < LAST_WIZARD_STEP ? ((s + 1) as WizardStepId) : s));
  };

  const create = async () => {
    const bad = firstInvalidStep(state);
    if (bad) {
      setStep(bad.step);
      setStepError(bad.error);
      return;
    }
    const final = toManualInput(state);
    if (!final.ok) {
      setStepError(final.error);
      return;
    }
    setCreating(true);
    setCreateError(null);
    const r = await requestJson<CampaignResponse>(API.campaigns(), { method: 'POST', body: final.value });
    setCreating(false);
    if (!r.ok) {
      setCreateError(r.error.message);
      return;
    }
    setCreatedName(r.data.campaign?.name ?? final.value.name);
    onCreated();
  };

  if (createdName !== null) {
    return (
      <Panel title="Draft created">
        <Notice tone="good" role="status" title={`“${createdName}” is waiting in Approvals`}>
          Nothing has been sent. Check the cost and the sample messages there, then approve it when you are happy.
        </Notice>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={onGoToApprovals}>Go to Approvals</Button>
          <Button
            variant="secondary"
            onClick={() => {
              setState(emptyWizard());
              setStep(1);
              setCreatedName(null);
            }}
          >
            Make another
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </Panel>
    );
  }

  const offerParsed = parseOffer(draftToOfferInput(state.offer));
  const offerText = offerParsed.ok ? describeOfferForOwner(offerParsed.value, ranking) : '';
  const previewOfferText = offerParsed.ok ? customerOfferText(offerParsed.value, ranking) : '';

  return (
    <Panel
      title="New campaign"
      subtitle="Five short steps. Nothing is sent when you finish: it becomes a draft you approve in Approvals."
      action={
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <ol className="mb-5 flex flex-wrap gap-2" aria-label="Steps">
        {WIZARD_STEPS.map((s) => {
          const done = s.id < step;
          const current = s.id === step;
          return (
            <li key={s.id}>
              <button
                type="button"
                disabled={s.id > step}
                aria-current={current ? 'step' : undefined}
                onClick={() => {
                  setStepError(null);
                  setStep(s.id);
                }}
                className={
                  'flex min-h-[44px] items-center gap-2 rounded-md border px-3 text-sm font-bold disabled:cursor-default ' +
                  (current ? 'border-charcoal bg-charcoal text-cream' : done ? 'border-tan text-tan-dark hover:bg-surface' : 'border-line text-muted')
                }
              >
                <span aria-hidden="true">{done ? '✓' : s.id}</span>
                {s.title}
                {done ? <span className="sr-only"> (done)</span> : null}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <div className="flex min-w-0 flex-col gap-4">
          <p className="text-sm text-muted">
            Step {step} of {LAST_WIZARD_STEP}: {WIZARD_STEPS[step - 1].blurb}
          </p>

          {step === 1 ? (
            <div className="flex flex-col gap-3">
              <Input
                label="Campaign name"
                value={state.name}
                maxLength={CAMPAIGN_NAME_MAX}
                onChange={(e) => set({ name: e.target.value })}
                hint="Only you see this. For example “Monsoon latte push”."
              />
              <Input
                label="Headline (optional)"
                value={state.headline}
                maxLength={HEADLINE_MAX}
                onChange={(e) => set({ headline: e.target.value })}
                hint={`Fills the “headline” blank in the message, like “New hazelnut latte”. Customers read this. Up to ${HEADLINE_MAX} characters.`}
              />
            </div>
          ) : null}

          {step === 2 ? (
            <AudienceStep state={state} onChange={set} eligible={shownPreview?.eligible ?? null} refreshing={refreshing} />
          ) : null}

          {step === 3 ? (
            <OfferEditor draft={state.offer} onChange={(offer) => set({ offer })} ranking={ranking} costsAvailable={costsAvailable} />
          ) : null}

          {step === 4 ? (
            <div className="flex flex-col gap-3">
              <TemplateEditor
                draft={state.template}
                onChange={(template) => set({ template })}
                allowHeadline
                offerTextValue={previewOfferText}
                headline={state.headline}
              />
              {offerTemplateMismatch(state) ? (
                <Notice tone="bad" role="alert">
                  {offerTemplateMismatch(state)}
                </Notice>
              ) : null}
              <TestSend template={state.template} allowHeadline />
            </div>
          ) : null}

          {step === 5 ? <ScheduleStep state={state} onChange={set} offerText={offerText} /> : null}

          {stepError ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
              {stepError}
            </p>
          ) : null}
          {createError ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
              {createError}
            </p>
          ) : null}

          <ForecastStrip preview={shownPreview} refreshing={refreshing} problem={parsed.ok ? null : parsed.error} />

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
            <Button
              variant="ghost"
              disabled={step === 1 || creating}
              onClick={() => {
                setStepError(null);
                setStep((s) => (s > 1 ? ((s - 1) as WizardStepId) : s));
              }}
            >
              ← Back
            </Button>
            {step < LAST_WIZARD_STEP ? (
              <Button onClick={goNext}>Next →</Button>
            ) : (
              <Button onClick={create} loading={creating}>
                Create draft
              </Button>
            )}
          </div>
        </div>

        <aside aria-label="Live forecast" className="min-w-0 rounded-md border border-line bg-white p-4 lg:sticky lg:top-24 lg:self-start">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold uppercase tracking-wide text-charcoal">Live forecast</h3>
            {refreshing ? <span className="text-xs text-muted">Updating…</span> : null}
          </div>
          <PreviewBody preview={preview} shown={shownPreview} problem={parsed.ok ? null : parsed.error} hasCoupon={state.offer.type !== 'none'} />
        </aside>
      </div>
    </Panel>
  );
}

export function PreviewBody({
  preview,
  shown,
  problem,
  hasCoupon,
}: {
  preview: PreviewState;
  shown: CampaignPreview | undefined;
  problem: string | null;
  hasCoupon: boolean;
}) {
  if (preview.status === 'error') return <ErrorNote error={preview.error} />;
  if (!shown) {
    return (
      <p className="text-sm text-muted">
        {problem ? `Forecast paused: ${problem}` : 'Working out who would get this and what it would cost…'}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {problem ? <p className="text-xs font-semibold text-amber-800">Forecast paused while a field needs fixing: {problem}</p> : null}
      <p className="text-sm text-charcoal">
        <span className="font-bold">{formatCount(shown.eligible)}</span> {shown.eligible === 1 ? 'customer matches' : 'customers match'} right now.
      </p>
      <ProjectionGrid projection={shown.projection} />
      <GuardrailList flags={shown.guardrail_flags} />
      <div>
        <p className="mb-2 text-sm font-bold text-charcoal">Sample messages</p>
        <div className="grid gap-3">
          <SamplePreviews samples={shown.samples.slice(0, 2)} hasCoupon={hasCoupon} />
        </div>
      </div>
    </div>
  );
}

/** One line under the form so the price of each choice stays in view on a phone, where the panel is far below. */
function ForecastStrip({ preview, refreshing, problem }: { preview: CampaignPreview | undefined; refreshing: boolean; problem: string | null }) {
  if (!preview) return null;
  const p = preview.projection;
  return (
    <p className="rounded-md bg-surface p-3 text-sm text-charcoal" aria-live="polite">
      <span className="font-semibold">Right now:</span> {formatCount(p.treated)} messaged · cost {inr(p.message_spend_inr)} · expected profit{' '}
      <span className={p.expected_profit_inr <= 0 ? 'font-bold text-red-700' : 'font-bold'}>{signedInr(p.expected_profit_inr)}</span>
      {refreshing ? ' (updating…)' : ''}
      {problem ? ' (paused: fix the field above)' : ''}
    </p>
  );
}

export function AudienceStep({
  state,
  onChange,
  eligible,
  refreshing,
}: {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
  eligible: number | null;
  refreshing: boolean;
}) {
  const a = state.audience;
  const set = (patch: Partial<WizardState['audience']>) => onChange({ audience: { ...a, ...patch } });
  const toggleStage = (stage: LifecycleStage, on: boolean) =>
    set({ stages: on ? [...a.stages, stage] : a.stages.filter((s) => s !== stage) });

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        Only customers who opted in are ever counted. People messaged too recently, or who hit a frequency limit, are left out automatically.
      </Notice>
      <fieldset>
        <legend className="text-sm font-bold text-charcoal">Which kind of customer?</legend>
        <p className="text-xs text-muted">Tick none to include everyone who opted in.</p>
        <div className="mt-1 grid gap-x-4 sm:grid-cols-2">
          {LIFECYCLE_STAGES.map((s) => (
            <CheckRow key={s} checked={a.stages.includes(s)} onChange={(on) => toggleStage(s, on)}>
              {LIFECYCLE_STAGE_LABELS[s]}
            </CheckRow>
          ))}
        </div>
      </fieldset>
      <CheckRow checked={a.vip_only} onChange={(vip_only) => set({ vip_only })}>
        Best customers only (VIPs: the top 20% by spend among regulars with 3+ orders)
      </CheckRow>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="At least this many orders"
          type="number"
          inputMode="numeric"
          min={AUDIENCE_BOUNDS.min_orders.min}
          max={AUDIENCE_BOUNDS.min_orders.max}
          value={a.min_orders}
          onChange={(e) => set({ min_orders: e.target.value })}
          hint="Leave empty for no rule."
        />
        <Input
          label="Spent at least (₹, in total)"
          type="number"
          inputMode="numeric"
          min={AUDIENCE_BOUNDS.min_spend_inr.min}
          max={AUDIENCE_BOUNDS.min_spend_inr.max}
          value={a.min_spend_inr}
          onChange={(e) => set({ min_spend_inr: e.target.value })}
          hint="Leave empty for no rule."
        />
        <Input
          label="Last order at least this many days ago"
          type="number"
          inputMode="numeric"
          min={AUDIENCE_BOUNDS.last_order_days.min}
          max={AUDIENCE_BOUNDS.last_order_days.max}
          value={a.last_order_from_days}
          onChange={(e) => set({ last_order_from_days: e.target.value })}
          hint="For example 30 = haven't ordered in a month."
        />
        <Input
          label="…but no more than this many days ago"
          type="number"
          inputMode="numeric"
          min={AUDIENCE_BOUNDS.last_order_days.min}
          max={AUDIENCE_BOUNDS.last_order_days.max}
          value={a.last_order_to_days}
          onChange={(e) => set({ last_order_to_days: e.target.value })}
          hint="Leave empty for no upper limit."
        />
        <Input
          label="At least this many points"
          type="number"
          inputMode="numeric"
          min={AUDIENCE_BOUNDS.min_points.min}
          max={AUDIENCE_BOUNDS.min_points.max}
          value={a.min_points}
          onChange={(e) => set({ min_points: e.target.value })}
          hint="Leave empty for no rule."
        />
      </div>
      <p className="rounded-md bg-surface p-3 text-sm text-charcoal" aria-live="polite">
        {eligible === null ? (
          'Counting who matches…'
        ) : (
          <>
            <span className="font-bold">{formatCount(eligible)}</span> {eligible === 1 ? 'customer matches' : 'customers match'} right now{refreshing ? ' (updating…)' : ''}.
          </>
        )}
      </p>
    </div>
  );
}

export function ScheduleStep({ state, onChange, offerText }: { state: WizardState; onChange: (patch: Partial<WizardState>) => void; offerText: string }) {
  const audience = parseAudienceFilter(audienceToInput(state.audience));
  const warnings = wizardWarnings(state);
  const min = nowAsIstLocal(Date.now());
  const sendAfterIso = istLocalToIso(state.send_after_local);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-sm font-bold text-charcoal">When should it go out?</p>
        <Segmented
          label="When to send"
          value={state.send}
          onChange={(send) => onChange({ send })}
          options={[
            { value: 'now', label: 'As soon as approved' },
            { value: 'later', label: 'Pick a time' },
          ]}
        />
        <p className="mt-2 text-xs text-muted">Either way it only goes out inside your send window, once you have approved it and sending is on.</p>
      </div>
      {state.send === 'later' ? (
        <div className="max-w-xs">
          <Input
            label="Send no earlier than (India time)"
            type="datetime-local"
            min={min}
            value={state.send_after_local}
            onChange={(e) => onChange({ send_after_local: e.target.value })}
          />
        </div>
      ) : null}

      <div className="rounded-md border border-line bg-white p-4">
        <h4 className="text-sm font-bold uppercase tracking-wide text-charcoal">Check it over</h4>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <ReviewRow label="Name">{state.name.trim() || '—'}</ReviewRow>
          <ReviewRow label="Headline">{state.headline.trim() || '—'}</ReviewRow>
          <ReviewRow label="Audience">{audience.ok ? describeAudience(audience.value) : 'Needs attention (step 2)'}</ReviewRow>
          <ReviewRow label="Offer">{state.offer.type === 'none' ? 'No offer' : offerText || 'Needs attention (step 3)'}</ReviewRow>
          <ReviewRow label="Template">
            <span className="font-mono">{state.template.name || 'not set'}</span>
          </ReviewRow>
          <ReviewRow label="Send">
            {state.send === 'now' ? 'As soon as approved' : sendAfterIso ? `Not before ${formatIstDateTime(sendAfterIso)} (IST)` : 'Pick a time'}
          </ReviewRow>
        </dl>
      </div>

      {warnings.length > 0 ? (
        <Notice tone="warn" title="Worth a second look">
          <ul className="list-disc space-y-1 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}

function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-charcoal">{children}</dd>
    </div>
  );
}
