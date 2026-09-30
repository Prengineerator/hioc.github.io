// The "New campaign" wizard's state and rules (spec §7.4): five steps, each
// validated by the SAME parsers the server runs (lib/marketing/parse.ts), so a
// step never says "OK" to something the create call would refuse.
//
// Pure: unit-tested in tests/marketingDashboardWizard.test.ts.

import { LOYALTY_UNIT } from '@/lib/loyalty/brand';
import { parseAudienceFilter, parseManualCampaign, parseOffer, parseTemplate } from '@/lib/marketing/parse';
import { IST_OFFSET_MS } from '@/lib/marketing/ist';
import {
  CAMPAIGN_NAME_MAX,
  DEFAULT_TEMPLATES,
  HEADLINE_MAX,
  LIFECYCLE_STAGE_LABELS,
  type AudienceFilter,
  type LifecycleStage,
  type ManualCampaignInput,
  type ParseResult,
} from '@/lib/marketing/types';
import {
  draftToOfferInput,
  draftToTemplateInput,
  switchOfferType,
  templateToDraft,
  typedNumber,
  type OfferDraft,
  type TemplateDraft,
} from './drafts';

export const WIZARD_STEPS = [
  { id: 1, title: 'Name', blurb: 'What is this campaign called?' },
  { id: 2, title: 'Audience', blurb: 'Who should get it?' },
  { id: 3, title: 'Offer', blurb: 'What do they get?' },
  { id: 4, title: 'Message', blurb: 'Which approved WhatsApp template?' },
  { id: 5, title: 'When', blurb: 'Send as soon as approved, or later.' },
] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];
export const LAST_WIZARD_STEP: WizardStepId = 5;

/** Audience boxes as typed. Blank = "no rule". */
export interface AudienceDraft {
  stages: LifecycleStage[];
  vip_only: boolean;
  min_orders: string;
  min_spend_inr: string;
  last_order_from_days: string;
  last_order_to_days: string;
  min_points: string;
}

export interface WizardState {
  name: string;
  headline: string;
  audience: AudienceDraft;
  offer: OfferDraft;
  template: TemplateDraft;
  send: 'now' | 'later';
  /** <input type="datetime-local"> value, read as India time. */
  send_after_local: string;
}

export function emptyAudience(): AudienceDraft {
  return { stages: [], vip_only: false, min_orders: '', min_spend_inr: '', last_order_from_days: '', last_order_to_days: '', min_points: '' };
}

/**
 * A fresh wizard. The message starts on the manual template and the offer on 10%
 * off, because the manual template shows an offer and a code — a "No offer"
 * default would put "-" where the code goes.
 */
export function emptyWizard(): WizardState {
  return {
    name: '',
    headline: '',
    audience: emptyAudience(),
    offer: switchOfferType('percent'),
    template: templateToDraft({ ...DEFAULT_TEMPLATES.manual, vars: [...DEFAULT_TEMPLATES.manual.vars] }),
    send: 'now',
    send_after_local: '',
  };
}

// ---------------------------------------------------------------------------
// Input building
// ---------------------------------------------------------------------------

/** A blank box means "no rule"; anything else goes to the parser (which names a bad one). */
function optionalNumber(raw: string): number | undefined {
  return raw.trim() === '' ? undefined : typedNumber(raw);
}

/** The audience draft as the raw object parseAudienceFilter() takes; blanks are left out. */
export function audienceToInput(a: AudienceDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (a.stages.length > 0) out.stages = [...a.stages];
  if (a.vip_only) out.vip_only = true;
  const ints: [keyof AudienceDraft, string][] = [
    ['min_orders', 'min_orders'],
    ['min_spend_inr', 'min_spend_inr'],
    ['last_order_from_days', 'last_order_from_days'],
    ['last_order_to_days', 'last_order_to_days'],
    ['min_points', 'min_points'],
  ];
  for (const [field, key] of ints) {
    const n = optionalNumber(a[field] as string);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

/** Reads a datetime-local value as India time. null when it isn't a date. */
export function istLocalToIso(local: string): string | null {
  const t = local.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(t)) return null;
  const withSeconds = t.length === 16 ? `${t}:00` : t;
  const ms = Date.parse(`${withSeconds}+05:30`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The earliest value the date box should allow: right now, as India-time wall clock 'YYYY-MM-DDTHH:mm'. */
export function nowAsIstLocal(now: number): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * The wizard as the ManualCampaignInput the API takes, run through the shared
 * strict parser. `preview: true` (the live projection) tolerates an unnamed
 * campaign, an unmapped template name and a missing headline — the projection
 * then shows the "no template" flag instead of refusing to price anything.
 */
export function toManualInput(
  s: WizardState,
  opts: { preview?: boolean } = {},
): ParseResult<ManualCampaignInput & { send_after: string | null }> {
  let sendAfter: string | null = null;
  if (s.send === 'later') {
    sendAfter = istLocalToIso(s.send_after_local);
    if (sendAfter === null) return { ok: false, error: 'Pick the date and time to send, or choose "As soon as approved".' };
  }
  return parseManualCampaign(
    {
      name: s.name,
      headline: s.headline,
      audience: audienceToInput(s.audience),
      offer: draftToOfferInput(s.offer),
      template: draftToTemplateInput(s.template),
      send_after: sendAfter,
    },
    { preview: opts.preview === true },
  );
}

// ---------------------------------------------------------------------------
// Step validation
// ---------------------------------------------------------------------------

const USES_OFFER = new Set(['offer_text', 'code', 'valid_till']);

/**
 * A message that prints the offer or code while the campaign has no offer would
 * send "-" to customers. Blocking it is cheaper than one wasted, embarrassing send.
 */
export function offerTemplateMismatch(s: Pick<WizardState, 'offer' | 'template'>): string | null {
  const uses = s.template.vars.filter((v) => USES_OFFER.has(v));
  if (s.offer.type === 'none' && uses.length > 0) {
    return `Your message shows the offer (${uses.join(', ')}), but this campaign has no offer, so customers would see "-". Choose an offer, or use a message without those variables.`;
  }
  return null;
}

/** Non-blocking heads-ups for the review step. */
export function wizardWarnings(s: WizardState): string[] {
  const warnings: string[] = [];
  if (s.offer.type !== 'none' && !s.template.vars.includes('code')) {
    warnings.push('Customers get a personal code with this offer, but your message does not include the code variable, so they will not see it.');
  }
  if (s.offer.type !== 'none' && !s.template.vars.includes('offer_text')) {
    warnings.push('Your message does not say what the offer is (the offer text variable is missing).');
  }
  return warnings;
}

/**
 * The problem with one step, in words, or null when it is fine. `now` (ms) is a
 * parameter so "in the future" is testable.
 */
export function validateStep(step: WizardStepId, s: WizardState, now: number = Date.now()): string | null {
  switch (step) {
    case 1: {
      const name = s.name.trim();
      if (name.length < 1) return 'Give the campaign a name, like “Monsoon latte push”.';
      if (name.length > CAMPAIGN_NAME_MAX) return `The name can be at most ${CAMPAIGN_NAME_MAX} characters.`;
      if (Array.from(s.headline.replace(/[\r\n\t]+/g, ' ').trim()).length > HEADLINE_MAX) {
        return `The headline can be at most ${HEADLINE_MAX} characters.`;
      }
      return null;
    }
    case 2: {
      const r = parseAudienceFilter(audienceToInput(s.audience));
      return r.ok ? null : r.error;
    }
    case 3: {
      const r = parseOffer(draftToOfferInput(s.offer));
      return r.ok ? null : r.error;
    }
    case 4: {
      // Checked before the parser so an empty box gets a friendly sentence, not the pattern rule.
      if (s.template.name.trim() === '') return 'Type the template name exactly as it appears in WhatsApp Manager.';
      const r = parseTemplate(draftToTemplateInput(s.template), { allowHeadline: true });
      if (!r.ok) return r.error;
      if (r.value.vars.includes('headline') && s.headline.trim() === '') {
        return 'Your message uses the headline, so please type one in step 1.';
      }
      return offerTemplateMismatch(s);
    }
    case 5: {
      if (s.send === 'now') return null;
      const iso = istLocalToIso(s.send_after_local);
      if (iso === null) return 'Pick the date and time to send, or choose "As soon as approved".';
      if (Date.parse(iso) <= now) return 'Pick a time in the future.';
      return null;
    }
  }
}

/** The first step (and its problem) that blocks creating the draft; null when the whole wizard is valid. */
export function firstInvalidStep(s: WizardState, now: number = Date.now()): { step: WizardStepId; error: string } | null {
  for (const { id } of WIZARD_STEPS) {
    const error = validateStep(id, s, now);
    if (error) return { step: id, error };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Words for the review
// ---------------------------------------------------------------------------

/** "Everyone who opted in" or "Opted-in customers · Lapsed stage 1, Lapsed stage 2 · VIPs only · 3+ orders". */
export function describeAudience(f: AudienceFilter): string {
  const parts: string[] = [];
  if (f.stages && f.stages.length > 0) parts.push(f.stages.map((s) => LIFECYCLE_STAGE_LABELS[s]).join(', '));
  if (f.vip_only) parts.push('VIPs only');
  if (f.min_orders) parts.push(`${f.min_orders}+ orders`);
  if (f.min_spend_inr) parts.push(`₹${f.min_spend_inr.toLocaleString('en-IN')}+ spent in total`);
  if (f.last_order_from_days !== undefined || f.last_order_to_days !== undefined) {
    const from = f.last_order_from_days ?? 0;
    const to = f.last_order_to_days;
    parts.push(to === undefined ? `last order ${from}+ days ago` : `last order ${from}–${to} days ago`);
  }
  if (f.min_points) parts.push(`${f.min_points}+ ${LOYALTY_UNIT.many}`);
  return parts.length === 0 ? 'Everyone who opted in' : `Opted-in customers · ${parts.join(' · ')}`;
}
