// COFFEY-SPEC §10.7 — the "Where people leave the wizard" card on the owner
// Suggestions Overview tab: opened → chose a feeling → asked for picks → added
// a pick to the cart, as visitors, with the share that went on at each step.
// Pure (no hooks), like the rest of OverviewWidgets, so it renders inside the
// async server page. The numbers come from lib/suggest/wizardStepsStore.ts;
// the arithmetic is lib/suggest/wizardSteps.ts.
//
// One bar per step, all in the one decoration colour (the same bar the mood mix
// draws): the steps are one series, and every figure is printed beside its bar,
// so nothing is read from colour or from hovering.

import { Card } from '@/components/owner/dashboard';
import {
  WIZARD_STEPS_MIGRATION,
  wizardFunnelStages,
  type WizardFunnelResult,
  type WizardFunnelStage,
} from '@/lib/suggest/wizardSteps';

const TITLE = 'Where people leave the wizard';

/** What each step's percentage is a share of: the step above it. */
const OF_PREVIOUS: Record<WizardFunnelStage['key'], string | null> = {
  opened: null,
  feeling_chosen: 'of those who opened',
  picks_requested: 'of those who chose a feeling',
  added_to_cart: 'of those who asked for picks',
};

function stageDetail(stage: WizardFunnelStage): string | null {
  const of = OF_PREVIOUS[stage.key];
  if (of === null) return null;
  if (stage.visitors === null) return 'Could not be read just now';
  // The step above is empty: there is nobody to take a share of.
  if (stage.ofPrevious === null) return null;
  return `${Math.round(stage.ofPrevious * 100)}% ${of}`;
}

export function WizardFunnelCard({ result }: { result: WizardFunnelResult }) {
  if (result.status === 'missing_table') {
    return (
      <Card title={TITLE}>
        <p className="text-sm text-muted">Apply {WIZARD_STEPS_MIGRATION} to start measuring.</p>
      </Card>
    );
  }
  if (result.status === 'error') {
    return (
      <Card title={TITLE}>
        <p className="text-sm text-muted">The wizard steps could not be read just now. Reload the page to try again.</p>
      </Card>
    );
  }

  const { funnel } = result;
  if (funnel.opened === 0) {
    return (
      <Card title={TITLE}>
        <p className="py-6 text-center text-sm text-muted">Nobody has opened the wizard in this window yet.</p>
      </Card>
    );
  }

  const stages = wizardFunnelStages(funnel);
  return (
    <Card title={TITLE}>
      <ol className="flex flex-col gap-3">
        {stages.map((stage) => {
          const detail = stageDetail(stage);
          return (
            <li key={stage.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-charcoal">{stage.label}</span>
                <span className="shrink-0 text-base font-bold tabular-nums text-charcoal">
                  {stage.visitors === null ? '—' : stage.visitors}
                </span>
              </div>
              {detail ? <p className="text-xs text-muted">{detail}</p> : null}
              <div className="mt-1 h-4 rounded bg-[#f2efe9]" aria-hidden="true">
                <div className="h-4 rounded bg-tan" style={{ width: `${Math.round(stage.ofOpened * 100)}%` }} />
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-xs text-muted">
        Visitors in this window, each counted once however often they came back. A step counts only the visitors who
        also reached the step above it. Crawlers, and browsers that ask not to be tracked, are not counted.
      </p>
      {funnel.truncated ? (
        <p className="mt-1 text-xs text-muted">
          This window holds more wizard activity than the page reads at once, so these counts are a minimum.
        </p>
      ) : null}
    </Card>
  );
}
