import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// Coffey wizard step tracking (docs/COFFEY-SPEC.md §10.7): what
// POST /api/suggest/steps accepts, the funnel arithmetic behind the owner's
// "Where people leave the wizard" card, and the card itself. Pure — no
// Supabase, no 'server-only' — same posture as suggestAnalytics.test.ts. The
// card is server-rendered (there is no DOM in this suite).

import { WizardFunnelCard } from '@/components/owner/suggestions/WizardFunnelWidget';
import { WIZARD_STEPS } from '@/lib/suggest/types';
import {
  WIZARD_STEPS_MIGRATION,
  summariseWizardFunnel,
  validateWizardStepRequest,
  wizardFunnelStages,
  wizardStepVisitors,
  type WizardFunnel,
  type WizardFunnelResult,
  type WizardStepSlice,
} from '@/lib/suggest/wizardSteps';

const UUID_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
// What getAnonId() makes where crypto.randomUUID is unavailable.
const FALLBACK_ID = 'anon-1763370000000-k3j2h1g0f9';

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe('validateWizardStepRequest', () => {
  it('accepts each step with a guest id', () => {
    for (const step of WIZARD_STEPS) {
      expect(validateWizardStepRequest({ anonId: UUID_ID, step })).toEqual({ anonId: UUID_ID, step });
    }
  });

  it('accepts both shapes of guest id the browser makes', () => {
    expect(validateWizardStepRequest({ anonId: UUID_ID, step: 'opened' })).toMatchObject({ anonId: UUID_ID });
    expect(validateWizardStepRequest({ anonId: FALLBACK_ID, step: 'opened' })).toMatchObject({ anonId: FALLBACK_ID });
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, undefined, 'opened', 7, [], [{ anonId: UUID_ID, step: 'opened' }]]) {
      expect(typeof validateWizardStepRequest(body), JSON.stringify(body)).toBe('string');
    }
  });

  it('refuses a guest id that is missing, too short, too long, or not just letters, digits, _ and -', () => {
    for (const anonId of [
      undefined,
      null,
      '',
      12345678,
      'short',
      'a'.repeat(65),
      'has a space in it',
      'i am feeling quite low today',
      '9876543210 call me',
      '<script>alert(1)</script>',
      'né-accents-1234',
    ]) {
      const result = validateWizardStepRequest({ anonId, step: 'opened' });
      expect(typeof result, JSON.stringify(anonId)).toBe('string');
    }
  });

  it('refuses any step outside the three, including the session events', () => {
    for (const step of [undefined, null, '', 'OPENED', 'shown', 'added_to_cart', 'dismissed', 'ordered', 'results', 3]) {
      const result = validateWizardStepRequest({ anonId: UUID_ID, step });
      expect(typeof result, JSON.stringify(step)).toBe('string');
    }
  });

  it('reads nothing but the guest id and the step: no feeling, preference, note or user id gets through', () => {
    const parsed = validateWizardStepRequest({
      anonId: UUID_ID,
      step: 'feeling_chosen',
      mood: 'comfort',
      inputs: { sweetness: 'sweet', note: 'studying late' },
      note: 'studying late',
      user_id: 'forged',
      userId: 'forged',
    });
    expect(parsed).toEqual({ anonId: UUID_ID, step: 'feeling_chosen' });
  });
});

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

const row = (anon_id: string, step: string): WizardStepSlice => ({ anon_id, step });

// Hand-computed fixture: eight visitors, each number below worked out in the
// comment next to it.
const ROWS: WizardStepSlice[] = [
  // v1 came back twice and pressed "Show my picks" three times: one visitor at every step.
  row('v1', 'opened'),
  row('v1', 'opened'),
  row('v1', 'feeling_chosen'),
  row('v1', 'picks_requested'),
  row('v1', 'picks_requested'),
  row('v1', 'picks_requested'),
  // v2 and v8 went straight through.
  row('v2', 'opened'),
  row('v2', 'feeling_chosen'),
  row('v2', 'picks_requested'),
  row('v8', 'opened'),
  row('v8', 'feeling_chosen'),
  row('v8', 'picks_requested'),
  // v3 left on the preferences step.
  row('v3', 'opened'),
  row('v3', 'feeling_chosen'),
  // v4 and v5 left on the feeling step.
  row('v4', 'opened'),
  row('v5', 'opened'),
  // v6 opened before the window began: their later steps belong to no visitor of this window.
  row('v6', 'feeling_chosen'),
  row('v6', 'picks_requested'),
  // v7's feeling tap is missing: they count as opened, and no further.
  row('v7', 'opened'),
  row('v7', 'picks_requested'),
  // Not a step, and not a visitor.
  row('v9', 'bogus'),
  row('', 'opened'),
];
// opened          = v1 v2 v3 v4 v5 v7 v8      = 7
// chose a feeling = v1 v2 v3 v8               = 4   (v6 never opened in the window)
// asked for picks = v1 v2 v8                  = 3   (v7 has no feeling; v6 never opened)

describe('wizardStepVisitors', () => {
  it('counts each visitor once per step, and only if they reached the step before', () => {
    const { opened, feelingChosen, picksRequested } = wizardStepVisitors(ROWS);
    expect([...opened].sort()).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v7', 'v8']);
    expect([...feelingChosen].sort()).toEqual(['v1', 'v2', 'v3', 'v8']);
    expect([...picksRequested].sort()).toEqual(['v1', 'v2', 'v8']);
  });
});

describe('summariseWizardFunnel', () => {
  it('matches the hand-computed fixture', () => {
    // Cart adds came from v1, and from three browsers that are not in the last
    // step (v6, v7, and one that sent no steps at all): only v1 counts.
    const cart = new Set(['v1', 'v6', 'v7', 'someone-untracked']);
    expect(summariseWizardFunnel(ROWS, cart)).toEqual<WizardFunnel>({
      opened: 7,
      feelingChosen: 4,
      picksRequested: 3,
      addedToCart: 1,
      truncated: false,
    });
  });

  it('never lets a later step exceed the one before it', () => {
    const f = summariseWizardFunnel(ROWS, new Set(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8']));
    expect(f.addedToCart).toBe(3);
    expect(f.opened).toBeGreaterThanOrEqual(f.feelingChosen);
    expect(f.feelingChosen).toBeGreaterThanOrEqual(f.picksRequested);
    expect(f.picksRequested).toBeGreaterThanOrEqual(f.addedToCart as number);
  });

  it('answers null for the cart step when the cart events could not be read, not a false 0', () => {
    expect(summariseWizardFunnel(ROWS, null)).toMatchObject({ picksRequested: 3, addedToCart: null });
  });

  it('is all zeros for an empty window', () => {
    expect(summariseWizardFunnel([], new Set())).toEqual<WizardFunnel>({
      opened: 0,
      feelingChosen: 0,
      picksRequested: 0,
      addedToCart: 0,
      truncated: false,
    });
  });

  it('carries the truncated mark through', () => {
    expect(summariseWizardFunnel(ROWS, new Set(), true).truncated).toBe(true);
  });
});

describe('wizardFunnelStages', () => {
  it('gives the four bars in order, each with its share of the step above and of those who opened', () => {
    const stages = wizardFunnelStages(summariseWizardFunnel(ROWS, new Set(['v1'])));
    expect(stages.map((s) => [s.key, s.visitors])).toEqual([
      ['opened', 7],
      ['feeling_chosen', 4],
      ['picks_requested', 3],
      ['added_to_cart', 1],
    ]);
    expect(stages[0].ofPrevious).toBeNull();
    expect(stages[1].ofPrevious).toBeCloseTo(4 / 7);
    expect(stages[2].ofPrevious).toBeCloseTo(3 / 4);
    expect(stages[3].ofPrevious).toBeCloseTo(1 / 3);
    expect(stages.map((s) => s.ofOpened)).toEqual([1, 4 / 7, 3 / 7, 1 / 7]);
  });

  it('has no percentage where the step above is empty or the cart is unknown', () => {
    const empty = wizardFunnelStages(summariseWizardFunnel([], new Set()));
    expect(empty.map((s) => s.ofPrevious)).toEqual([null, null, null, null]);
    expect(empty.map((s) => s.ofOpened)).toEqual([0, 0, 0, 0]);

    const noCart = wizardFunnelStages(summariseWizardFunnel(ROWS, null));
    expect(noCart[3]).toMatchObject({ visitors: null, ofPrevious: null, ofOpened: 0 });
  });
});

// ---------------------------------------------------------------------------
// The owner card
// ---------------------------------------------------------------------------

function renderCard(result: WizardFunnelResult): string {
  return renderToStaticMarkup(createElement(WizardFunnelCard, { result }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('WizardFunnelCard', () => {
  const ok = (funnel: WizardFunnel): WizardFunnelResult => ({ status: 'ok', funnel });

  it('shows the four steps with counts and step-to-step percentages', () => {
    const html = renderCard(ok(summariseWizardFunnel(ROWS, new Set(['v1']))));
    const body = text(html);
    expect(body).toContain('Where people leave the wizard');
    expect(body).toMatch(/Opened the wizard 7 /);
    expect(body).toMatch(/Chose a feeling 4 57% of those who opened/);
    expect(body).toMatch(/Asked for picks 3 75% of those who chose a feeling/);
    expect(body).toMatch(/Added a pick to the cart 1 33% of those who asked for picks/);
    // The bars are lengths of "those who opened": 100%, 57%, 43%, 14%.
    expect([...html.matchAll(/style="width:(\d+)%"/g)].map((m) => m[1])).toEqual(['100', '57', '43', '14']);
  });

  it('asks for the SQL file when the table is missing, and shows no numbers', () => {
    const body = text(renderCard({ status: 'missing_table' }));
    expect(body).toContain(`Apply ${WIZARD_STEPS_MIGRATION} to start measuring.`);
    expect(body).not.toMatch(/Opened the wizard/);
  });

  it('says so when the steps could not be read, rather than showing zeros', () => {
    const body = text(renderCard({ status: 'error' }));
    expect(body).toContain('could not be read');
    expect(body).not.toMatch(/Opened the wizard/);
  });

  it('has an empty state for a window nobody opened the wizard in', () => {
    const body = text(renderCard(ok(summariseWizardFunnel([], new Set()))));
    expect(body).toContain('Nobody has opened the wizard in this window yet.');
  });

  it('shows a dash for the cart step when it could not be read', () => {
    const body = text(renderCard(ok(summariseWizardFunnel(ROWS, null))));
    expect(body).toMatch(/Added a pick to the cart — Could not be read just now/);
    expect(body).toMatch(/Asked for picks 3 /);
  });

  it('leaves out a percentage of nobody', () => {
    // One visitor opened and left: the two steps below have nobody above them to be a share of.
    const body = text(renderCard(ok(summariseWizardFunnel([row('v1', 'opened')], new Set()))));
    expect(body).toMatch(/Chose a feeling 0 0% of those who opened/);
    expect(body).toMatch(/Asked for picks 0 Added a pick to the cart 0 /);
  });

  it('says the counts are a minimum when the window was too big to read whole', () => {
    expect(text(renderCard(ok(summariseWizardFunnel(ROWS, new Set(), true))))).toContain('these counts are a minimum');
    expect(text(renderCard(ok(summariseWizardFunnel(ROWS, new Set()))))).not.toContain('these counts are a minimum');
  });
});
