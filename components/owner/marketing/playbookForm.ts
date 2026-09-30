// The playbook card's form model: what the owner can edit, in words, and how an
// edited card becomes a PATCH /api/owner/marketing/playbooks/[key] body.
//
// Only what CHANGED is sent. Re-sending an untouched offer would rewrite a value
// the owner never looked at, and (for a free item) could clobber a choice made
// from another device. Validation is the shared parser (parsePlaybookPatch), so
// the sentence shown on a bad value is the one the server would have returned.
//
// Pure: unit-tested in tests/marketingDashboardForms.test.ts.

import { LOYALTY_UNIT, beaniesLabel } from '@/lib/loyalty/brand';
import { parsePlaybookPatch, validatePlaybookParams } from '@/lib/marketing/parse';
import {
  PARAM_BOUNDS,
  type PlaybookKey,
  type PlaybookMode,
  type PlaybookPatch,
  type PlaybookView,
} from '@/lib/marketing/types';
import {
  draftToOfferInput,
  draftToTemplateInput,
  numberToField,
  offerToDraft,
  templateToDraft,
  typedNumber,
  type OfferDraft,
  type TemplateDraft,
} from './drafts';

export interface ParamField {
  name: string;
  label: string;
  unit: string;
  help: string;
  /** <input step>; whole numbers unless the parameter takes decimals. */
  step: number;
}

/** Every editable parameter of every playbook, in the order the card shows them. Bounds come from PARAM_BOUNDS. */
export const PARAM_FIELDS: Record<PlaybookKey, ParamField[]> = {
  points_expiring: [
    {
      name: 'min_points',
      label: 'Smallest expiring balance worth a message',
      unit: LOYALTY_UNIT.many,
      help: `Below the minimum redemption (${beaniesLabel(20)}) they can’t be used anyway.`,
      step: 1,
    },
    { name: 'days_ahead', label: 'Warn this many days before Beanies expire', unit: 'days', help: 'The look-ahead window.', step: 1 },
    {
      name: 'recent_order_days',
      label: 'Skip customers who ordered in the last',
      unit: 'days',
      help: 'They are already coming back. 0 turns this rule off.',
      step: 1,
    },
    {
      name: 'cooldown_days',
      label: 'Don’t send this to the same person again within',
      unit: 'days',
      help: 'Stops the same reminder repeating.',
      step: 1,
    },
  ],
  points_balance: [
    { name: 'min_points', label: 'Smallest balance worth a message', unit: LOYALTY_UNIT.many, help: 'Customers with fewer Beanies are left alone.', step: 1 },
    {
      name: 'min_days_since_order',
      label: 'Only customers who haven’t ordered for at least',
      unit: 'days',
      help: 'Keeps this from nudging people who visited yesterday.',
      step: 1,
    },
    {
      name: 'cooldown_days',
      label: 'Don’t send this to the same person again within',
      unit: 'days',
      help: 'Stops the same reminder repeating.',
      step: 1,
    },
  ],
  winback_1: [
    {
      name: 'gap_multiplier',
      label: 'Count someone as lapsed after this many of their usual gaps',
      unit: '× their gap',
      help: 'Someone who usually visits every 10 days and has been away 25 days is 2.5× their gap. A daily regular is flagged sooner than a monthly visitor.',
      step: 0.1,
    },
    { name: 'min_days', label: 'Never flag someone sooner than', unit: 'days', help: 'A floor, so a very frequent visitor isn’t nagged after a short break.', step: 1 },
    { name: 'max_days', label: 'Never wait longer than', unit: 'days', help: 'A ceiling, so an occasional visitor is still caught.', step: 1 },
    {
      name: 'default_days',
      label: 'For customers with fewer than 3 orders, lapsed after',
      unit: 'days',
      help: 'They have no visit pattern yet, so a fixed number is used.',
      step: 1,
    },
  ],
  winback_2: [
    {
      name: 'offset_days',
      label: 'Stage 2 starts this many days after stage 1',
      unit: 'days',
      help: 'Someone still away this long after the first message gets the stronger offer.',
      step: 1,
    },
  ],
  winback_3: [
    { name: 'offset_days', label: 'Stage 3 starts this many days after stage 1', unit: 'days', help: 'The last-chance message.', step: 1 },
    {
      name: 'max_days',
      label: 'Treat as lost after',
      unit: 'days',
      help: 'Beyond this since their last order, the agent stops messaging them automatically.',
      step: 1,
    },
  ],
};

/** The bound of one parameter, for min/max attributes and the "Allowed 1 to 30" hint. */
export function paramBounds(key: PlaybookKey, name: string): { min: number; max: number } {
  return (PARAM_BOUNDS[key] as Record<string, { min: number; max: number }>)[name] ?? { min: 0, max: 1_000_000 };
}

export const MODE_LABELS: Record<PlaybookMode, string> = { off: 'Off', review: 'Review', auto: 'Auto' };

/** What each mode does, in the words the owner needs before they pick one (spec §7.3). */
export const MODE_HELP: Record<PlaybookMode, string> = {
  off: 'The agent does not plan this campaign. Nothing is prepared and nothing is sent.',
  review:
    'Each morning the agent prepares this campaign and puts it in Approvals with the cost and expected profit. Nothing is sent until you tap Approve.',
  auto: 'Sends automatically only when every guardrail passes. If any guardrail is flagged (thin margin, over budget, missing costs…) it still goes to Approvals for you to decide.',
};

/** Points reminders can't carry an offer (parsePlaybookPatch enforces it): the customer's own points ARE the offer. */
export function playbookHasOffer(key: PlaybookKey): boolean {
  return !key.startsWith('points_');
}

export interface PlaybookDraft {
  mode: PlaybookMode;
  params: Record<string, string>;
  offer: OfferDraft;
  template: TemplateDraft;
  prior: string;
}

export function playbookToDraft(view: PlaybookView): PlaybookDraft {
  const params: Record<string, string> = {};
  const stored = view.params as unknown as Record<string, number>;
  for (const f of PARAM_FIELDS[view.key]) params[f.name] = numberToField(stored[f.name]);
  return {
    mode: view.mode,
    params,
    offer: offerToDraft(view.offer),
    template: templateToDraft(view.template),
    prior: numberToField(Number(view.prior_conversion_pct)),
  };
}

export interface PlaybookPatchResult {
  /** Which sections changed, for "3 changes" and to disable Save when there are none. */
  changed: ('mode' | 'params' | 'offer' | 'template' | 'prior')[];
  /** Ready to send; only present when every changed value is valid. */
  patch?: PlaybookPatch;
  /** The sentence to show when a changed value is not valid. */
  error?: string;
}

/** Same offer or template? Compared as the wire object, so key order and blank-vs-0 quirks don't create false "changes". */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diffs an edited card against the saved playbook and validates the result with
 * the shared parser. `changed` is empty when nothing differs; `error` is set
 * when something differs but isn't valid (Save then shows it instead of sending).
 */
export function buildPlaybookPatch(view: PlaybookView, draft: PlaybookDraft): PlaybookPatchResult {
  const changed: PlaybookPatchResult['changed'] = [];
  const body: Record<string, unknown> = {};

  if (draft.mode !== view.mode) {
    changed.push('mode');
    body.mode = draft.mode;
  }

  const stored = view.params as unknown as Record<string, number>;
  const params: Record<string, number> = {};
  for (const f of PARAM_FIELDS[view.key]) {
    const typed = typedNumber(draft.params[f.name] ?? '');
    // NaN (a blank box) always counts as a change so the parser can name the field.
    if (Number.isNaN(typed) || typed !== stored[f.name]) params[f.name] = typed;
  }
  if (Object.keys(params).length > 0) {
    changed.push('params');
    body.params = params;
  }

  if (playbookHasOffer(view.key)) {
    const savedOffer = draftToOfferInput(offerToDraft(view.offer));
    const nextOffer = draftToOfferInput(draft.offer);
    // NaN doesn't survive JSON.stringify (→ null), so a blank required field would look "unchanged" when the saved value is null too; compare with a NaN marker.
    const marker = (o: Record<string, unknown>) => JSON.stringify(o, (_k, v) => (typeof v === 'number' && Number.isNaN(v) ? '__blank__' : v));
    if (marker(savedOffer) !== marker(nextOffer)) {
      changed.push('offer');
      body.offer = nextOffer;
    }
  }

  const savedTemplate = draftToTemplateInput(templateToDraft(view.template));
  const nextTemplate = draftToTemplateInput(draft.template);
  if (!sameJson(savedTemplate, nextTemplate)) {
    changed.push('template');
    body.template = nextTemplate;
  }

  const prior = typedNumber(draft.prior);
  if (Number.isNaN(prior) || prior !== Number(view.prior_conversion_pct)) {
    changed.push('prior');
    body.prior_conversion_pct = prior;
  }

  if (changed.length === 0) return { changed };

  const parsed = parsePlaybookPatch(view.key, body);
  if (!parsed.ok) return { changed, error: parsed.error };

  // A patch may carry only one side of a rule that spans two params (winback_1's shortest ≤ longest
  // threshold, winback_3's "lost after" beyond its offset), and the parser can only judge what it is given.
  // Judge the MERGED values, as the server does, so the owner hears about it here and not from a 400.
  if (parsed.value.params) {
    const cross = validatePlaybookParams(view.key, { ...view.params, ...parsed.value.params });
    if (cross) return { changed, error: cross };
  }
  return { changed, patch: parsed.value };
}

/** "3 changes" / "No changes" for the Save button caption. */
export function describeChanges(changed: PlaybookPatchResult['changed']): string {
  if (changed.length === 0) return 'No changes';
  const names: Record<PlaybookPatchResult['changed'][number], string> = {
    mode: 'mode',
    params: 'who qualifies',
    offer: 'offer',
    template: 'message',
    prior: 'expected conversion',
  };
  return `Changed: ${changed.map((c) => names[c]).join(', ')}`;
}
