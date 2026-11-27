// Coffey wizard step tracking (docs/COFFEY-SPEC.md §10.7): what
// POST /api/suggest/steps accepts, and the arithmetic behind the owner's
// "Where people leave the wizard" card. Same split as pairingsValidate.ts and
// pairingStats.ts: this file is pure (no Supabase, no 'server-only', no React)
// and unit-tested; lib/suggest/wizardStepsStore.ts does the reads and writes.

import { WIZARD_STEPS } from './types';
import type { WizardStep } from './types';

export const WIZARD_STEPS_TABLE = 'suggestion_wizard_steps';
/** The file the owner applies by hand; named in the owner card and the server log. */
export const WIZARD_STEPS_MIGRATION = 'supabase/2026-11-coffey-wizard-steps.sql';

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * The browser's guest id (components/suggest/api.ts getAnonId): a UUID, or
 * `anon-<time>-<random>` where crypto.randomUUID is unavailable. Letters,
 * digits, `_` and `-` only, so the one string a browser sends can never carry a
 * sentence. Mirrors suggestion_wizard_steps_anon_id_check in
 * supabase/2026-11-coffey-wizard-steps.sql.
 */
export const WIZARD_ANON_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isWizardAnonId(value: unknown): value is string {
  return typeof value === 'string' && WIZARD_ANON_ID.test(value);
}

export function isWizardStep(value: unknown): value is WizardStep {
  return typeof value === 'string' && (WIZARD_STEPS as readonly string[]).includes(value);
}

export interface WizardStepRequest {
  anonId: string;
  step: WizardStep;
}

/**
 * POST /api/suggest/steps: `{ anonId, step }`. Returns the parsed request, or a
 * short error string for the 400. Nothing else in the body is read: there is no
 * field for a feeling, a preference or a note, and a `user_id` is taken from the
 * session by the route, never from here.
 */
export function validateWizardStepRequest(body: unknown): WizardStepRequest | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'request body must be an object';
  const { anonId, step } = body as Record<string, unknown>;
  if (!isWizardAnonId(anonId)) return 'anonId must be 8-64 letters, digits, _ or -';
  if (!isWizardStep(step)) return `step must be one of: ${WIZARD_STEPS.join(', ')}`;
  return { anonId, step };
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

/** The two columns of a suggestion_wizard_steps row the funnel reads. */
export interface WizardStepSlice {
  anon_id: string;
  step: string;
}

/**
 * Visitors at each stage of the wizard, for one window. A visitor is a browser
 * (one guest id), counted once however many times they came back, and each
 * stage counts only the visitors who also reached the stage before it, so the
 * numbers can only go down and each percentage is a real "of those, how many
 * went on".
 */
export interface WizardFunnel {
  /** Opened the wizard. */
  opened: number;
  /** …and tapped a feeling. */
  feelingChosen: number;
  /** …and pressed "Show my picks". */
  picksRequested: number;
  /** …and added a pick to the cart. Null when the cart events could not be read. */
  addedToCart: number | null;
  /** The window held more step rows than were read, so the counts are a floor. */
  truncated: boolean;
}

/** What the owner page gets back from getWizardFunnel (lib/suggest/wizardStepsStore.ts). */
export type WizardFunnelResult =
  | { status: 'ok'; funnel: WizardFunnel }
  /** supabase/2026-11-coffey-wizard-steps.sql has not been applied. */
  | { status: 'missing_table' }
  | { status: 'error' };

/** The guest ids that reached each step, each narrowed to those who reached the step before. */
export function wizardStepVisitors(rows: readonly WizardStepSlice[]): {
  opened: Set<string>;
  feelingChosen: Set<string>;
  picksRequested: Set<string>;
} {
  const reached: Record<WizardStep, Set<string>> = {
    opened: new Set(),
    feeling_chosen: new Set(),
    picks_requested: new Set(),
  };
  for (const row of rows) {
    if (isWizardStep(row.step) && row.anon_id) reached[row.step].add(row.anon_id);
  }
  const opened = reached.opened;
  const feelingChosen = new Set([...reached.feeling_chosen].filter((id) => opened.has(id)));
  const picksRequested = new Set([...reached.picks_requested].filter((id) => feelingChosen.has(id)));
  return { opened, feelingChosen, picksRequested };
}

/**
 * Adds the window's step rows up into the funnel. `cartAnonIds` is the guest ids
 * whose Coffey sessions had a pick added to the cart in the same window (from
 * suggestion_events through suggestion_sessions.anon_id); pass null when that
 * could not be read, and the last stage comes back null rather than as a false 0.
 */
export function summariseWizardFunnel(
  rows: readonly WizardStepSlice[],
  cartAnonIds: ReadonlySet<string> | null,
  truncated = false,
): WizardFunnel {
  const { opened, feelingChosen, picksRequested } = wizardStepVisitors(rows);
  let addedToCart: number | null = null;
  if (cartAnonIds !== null) {
    addedToCart = 0;
    for (const id of picksRequested) if (cartAnonIds.has(id)) addedToCart += 1;
  }
  return {
    opened: opened.size,
    feelingChosen: feelingChosen.size,
    picksRequested: picksRequested.size,
    addedToCart,
    truncated,
  };
}

/** One bar of the owner card. */
export interface WizardFunnelStage {
  key: WizardStep | 'added_to_cart';
  label: string;
  /** Null only for the cart stage when it could not be read. */
  visitors: number | null;
  /** Share of the stage before, 0–1. Null for the first stage, and when either side is unknown or the stage before is empty. */
  ofPrevious: number | null;
  /** Share of the visitors who opened, 0–1 (the bar's length). */
  ofOpened: number;
}

/** The funnel as the four bars the owner card draws, in order. */
export function wizardFunnelStages(funnel: WizardFunnel): WizardFunnelStage[] {
  const counts: { key: WizardFunnelStage['key']; label: string; visitors: number | null }[] = [
    { key: 'opened', label: 'Opened the wizard', visitors: funnel.opened },
    { key: 'feeling_chosen', label: 'Chose a feeling', visitors: funnel.feelingChosen },
    { key: 'picks_requested', label: 'Asked for picks', visitors: funnel.picksRequested },
    { key: 'added_to_cart', label: 'Added a pick to the cart', visitors: funnel.addedToCart },
  ];
  return counts.map((stage, i) => {
    const previous = i === 0 ? null : counts[i - 1].visitors;
    const ofPrevious =
      stage.visitors === null || previous === null || previous === 0 ? null : stage.visitors / previous;
    const ofOpened = stage.visitors === null || funnel.opened === 0 ? 0 : stage.visitors / funnel.opened;
    return { ...stage, ofPrevious, ofOpened };
  });
}
