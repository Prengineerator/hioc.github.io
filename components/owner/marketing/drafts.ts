// Form drafts for the two things a playbook card and the new-campaign wizard both
// edit: an OFFER and a WhatsApp TEMPLATE mapping.
//
// A form field holds what the owner TYPED (a string), not what the API takes (a
// number): a number input that can't be empty or half-typed is a fight with the
// keyboard, and Number('') === 0 would silently turn a blank required field into
// a zero. So drafts are strings, and draftToOfferInput() converts them to the
// unknown-typed object lib/marketing/parse.ts validates — which then produces the
// SAME error sentences the server would ("Discount % must be a whole number
// between 1 and 50."). The dashboard never re-invents a bound or a message.
//
// Pure (no React): unit-tested in tests/marketingDashboardForms.test.ts.

import { offerText } from '@/lib/marketing/offers';
import { buildVars, renderPreview } from '@/lib/marketing/templates';
import {
  TEMPLATE_BODY_PREVIEW_MAX,
  TEMPLATE_MAX_VARS,
  TEMPLATE_TOKENS,
  TEMPLATE_TOKEN_SAMPLES,
  type FreeItemCandidate,
  type Offer,
  type OfferType,
  type TemplateConfig,
  type TemplateToken,
} from '@/lib/marketing/types';

// ---------------------------------------------------------------------------
// Numbers typed into a box
// ---------------------------------------------------------------------------

/**
 * A typed value as a number for the parsers. A blank box becomes `blank` (a
 * default such as 0 for an optional field) or NaN for a required one, which the
 * parser then reports as "must be a whole number between …". Commas and ₹ are
 * tolerated ("1,200" pasted from a message).
 */
export function typedNumber(raw: string, blank: number = NaN): number {
  const t = raw.replace(/[₹,\s]/g, '');
  if (t === '') return blank;
  return Number(t);
}

/** A number as it goes back into a box: '' for null/NaN, otherwise plain digits. */
export function numberToField(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '' : String(n);
}

// ---------------------------------------------------------------------------
// Offer draft
// ---------------------------------------------------------------------------

export interface OfferDraft {
  type: OfferType;
  percent: string;
  cap_inr: string;
  amount_inr: string;
  min_order_inr: string;
  validity_days: string;
  /** '' = Auto (best value): both ids null on the wire. */
  variant_id: string;
  item_id: string;
  max_item_price: string;
}

/** What each offer type starts with when the owner switches to it — the spec's own defaults. */
export const OFFER_TYPE_DEFAULTS: Record<Exclude<OfferType, 'none'>, Partial<OfferDraft>> = {
  percent: { percent: '10', cap_inr: '60', min_order_inr: '150', validity_days: '10' },
  flat: { amount_inr: '50', min_order_inr: '150', validity_days: '10' },
  free_item: { max_item_price: '250', min_order_inr: '200', validity_days: '10', variant_id: '', item_id: '' },
};

export const OFFER_TYPE_LABELS: Record<OfferType, string> = {
  none: 'No offer',
  percent: 'Percent off',
  flat: 'Flat amount off',
  free_item: 'Free item',
};

export function emptyOfferDraft(): OfferDraft {
  return {
    type: 'none',
    percent: '',
    cap_inr: '',
    amount_inr: '',
    min_order_inr: '',
    validity_days: '',
    variant_id: '',
    item_id: '',
    max_item_price: '',
  };
}

export function offerToDraft(offer: Offer): OfferDraft {
  const d = emptyOfferDraft();
  d.type = offer.type;
  switch (offer.type) {
    case 'percent':
      d.percent = numberToField(offer.percent);
      d.cap_inr = numberToField(offer.cap_inr);
      d.min_order_inr = numberToField(offer.min_order_inr);
      d.validity_days = numberToField(offer.validity_days);
      break;
    case 'flat':
      d.amount_inr = numberToField(offer.amount_inr);
      d.min_order_inr = numberToField(offer.min_order_inr);
      d.validity_days = numberToField(offer.validity_days);
      break;
    case 'free_item':
      d.item_id = offer.item_id ?? '';
      d.variant_id = offer.variant_id ?? '';
      d.max_item_price = numberToField(offer.max_item_price);
      d.min_order_inr = numberToField(offer.min_order_inr);
      d.validity_days = numberToField(offer.validity_days);
      break;
    default:
      break;
  }
  return d;
}

/** Switching type keeps nothing from the old type (a ₹50-flat draft must not leak into a 50%-off one) and loads the defaults. */
export function switchOfferType(type: OfferType): OfferDraft {
  return { ...emptyOfferDraft(), type, ...(type === 'none' ? {} : OFFER_TYPE_DEFAULTS[type]) };
}

/**
 * The draft as the raw object parseOffer() takes. Optional fields (cap, minimum
 * order) default to 0 when blank; required ones stay NaN so the parser names them.
 */
export function draftToOfferInput(d: OfferDraft): Record<string, unknown> {
  switch (d.type) {
    case 'none':
      return { type: 'none' };
    case 'percent':
      return {
        type: 'percent',
        percent: typedNumber(d.percent),
        cap_inr: typedNumber(d.cap_inr, 0),
        min_order_inr: typedNumber(d.min_order_inr, 0),
        validity_days: typedNumber(d.validity_days),
      };
    case 'flat':
      return {
        type: 'flat',
        amount_inr: typedNumber(d.amount_inr),
        min_order_inr: typedNumber(d.min_order_inr, 0),
        validity_days: typedNumber(d.validity_days),
      };
    case 'free_item':
      return {
        type: 'free_item',
        item_id: d.item_id === '' ? null : d.item_id,
        variant_id: d.variant_id === '' ? null : d.variant_id,
        max_item_price: typedNumber(d.max_item_price, 250),
        min_order_inr: typedNumber(d.min_order_inr, 0),
        validity_days: typedNumber(d.validity_days),
      };
  }
}

// ---------------------------------------------------------------------------
// Free-item variant picker (fed by GET /costs → free_item_ranking)
// ---------------------------------------------------------------------------

export const AUTO_VARIANT_LABEL = 'Auto (best value)';

/** "Cold Coffee (Large)"; the plain "Regular" size needs no label of its own. */
export function candidateName(c: FreeItemCandidate): string {
  return c.variant_label && c.variant_label.trim().toLowerCase() !== 'regular' ? `${c.item_name} (${c.variant_label})` : c.item_name;
}

/** "Cold Coffee (Large) · worth ₹180, costs ₹45 · 4.0× value" */
export function candidateLabel(c: FreeItemCandidate): string {
  const name = candidateName(c);
  return `${name} · worth ₹${Math.round(c.price_inr)}, costs ₹${Math.round(c.cost_inr * 100) / 100} · ${c.value_per_rupee.toFixed(1)}× value`;
}

export interface VariantOption {
  value: string;
  label: string;
  item_id: string;
}

/**
 * The select options: Auto first, then the ranking best-first. If the saved
 * choice is no longer ranked (its cost was deleted, or it is now over the price
 * cap) it stays selectable as "current choice" — silently swapping it to Auto
 * would change an offer the owner set on purpose.
 */
export function variantOptions(ranking: readonly FreeItemCandidate[], currentVariantId: string): VariantOption[] {
  const options: VariantOption[] = [{ value: '', label: AUTO_VARIANT_LABEL, item_id: '' }];
  for (const c of ranking) options.push({ value: c.variant_id, label: candidateLabel(c), item_id: c.item_id });
  if (currentVariantId && !ranking.some((c) => c.variant_id === currentVariantId)) {
    options.push({ value: currentVariantId, label: 'Current choice (no longer ranked)', item_id: '' });
  }
  return options;
}

/** Applies a picked variant to the draft (both ids together — the parser rejects one without the other). */
export function pickVariant(draft: OfferDraft, variantId: string, ranking: readonly FreeItemCandidate[]): OfferDraft {
  if (variantId === '') return { ...draft, variant_id: '', item_id: '' };
  const c = ranking.find((r) => r.variant_id === variantId);
  // Keep the item id we already hold for a variant that is no longer ranked.
  return { ...draft, variant_id: variantId, item_id: c ? c.item_id : draft.item_id };
}

/**
 * The offer as the customer's message would word it ({{offer_text}}): '' for no
 * offer. A free item is named from the ranking when a variant is picked; on Auto
 * the item is only chosen when the campaign is planned, so the plain "a FREE item"
 * wording stands in — good enough for a preview, and never a claim about which item.
 */
export function customerOfferText(offer: Offer, ranking: readonly FreeItemCandidate[]): string {
  if (offer.type === 'free_item' && offer.variant_id) {
    const c = ranking.find((r) => r.variant_id === offer.variant_id);
    if (c) {
      return offerText({ ...offer, item_name: c.item_name, variant_label: c.variant_label, price_inr: c.price_inr, cost_inr: c.cost_inr });
    }
  }
  return offerText(offer);
}

/**
 * The same offer for the OWNER'S eyes (the editor's "Customers will read" line and
 * the review step): identical, except that Auto says out loud that the item is
 * picked later.
 */
export function describeOfferForOwner(offer: Offer, ranking: readonly FreeItemCandidate[]): string {
  if (offer.type === 'none') return 'No offer';
  if (offer.type === 'free_item' && !ranking.some((r) => r.variant_id === offer.variant_id)) {
    const order = offer.min_order_inr > 0 ? ` above ₹${Math.round(offer.min_order_inr)}` : '';
    return offer.variant_id
      ? `a FREE item with any order${order} (your saved choice, which is no longer in the ranking)`
      : `a FREE item with any order${order} (the best-value pick, chosen when the campaign is planned)`;
  }
  return customerOfferText(offer, ranking);
}

// ---------------------------------------------------------------------------
// Template draft
// ---------------------------------------------------------------------------

export interface TemplateDraft {
  name: string;
  lang: string;
  vars: TemplateToken[];
  url_button: boolean;
  body_preview: string;
}

export function templateToDraft(t: TemplateConfig): TemplateDraft {
  return { name: t.name, lang: t.lang, vars: [...t.vars], url_button: t.url_button, body_preview: t.body_preview };
}

/** The raw object parseTemplate() takes (and the API accepts). */
export function draftToTemplateInput(d: TemplateDraft): TemplateConfig {
  return { name: d.name.trim(), lang: d.lang.trim(), vars: [...d.vars], url_button: d.url_button, body_preview: d.body_preview };
}

/** Tokens an owner can add to this template: none already used twice is fine, but `headline` is manual-only. */
export function addableTokens(allowHeadline: boolean): TemplateToken[] {
  return TEMPLATE_TOKENS.filter((t) => allowHeadline || t !== 'headline');
}

export function addToken(vars: readonly TemplateToken[], token: TemplateToken): TemplateToken[] {
  return vars.length >= TEMPLATE_MAX_VARS ? [...vars] : [...vars, token];
}

export function removeToken(vars: readonly TemplateToken[], index: number): TemplateToken[] {
  return vars.filter((_, i) => i !== index);
}

/** Moves a token one place up (-1) or down (+1); out-of-range moves are a no-op. */
export function moveToken(vars: readonly TemplateToken[], index: number, delta: -1 | 1): TemplateToken[] {
  const to = index + delta;
  if (index < 0 || index >= vars.length || to < 0 || to >= vars.length) return [...vars];
  const next = [...vars];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/**
 * The sample values a preview uses. offer_text shows the REAL offer wording when
 * there is one — a preview that says "10% off" while the owner is editing a 20%
 * offer would be a small lie about a message that costs money.
 */
export function previewValues(offerTextValue: string, headline?: string): Record<TemplateToken, string> {
  const values: Record<TemplateToken, string> = { ...TEMPLATE_TOKEN_SAMPLES };
  if (offerTextValue.trim()) values.offer_text = offerTextValue.trim();
  if (headline && headline.trim()) values.headline = headline.trim();
  return values;
}

/** The message as the customer would see it, with sample values. '' when there is no body copy yet. */
export function renderTemplatePreview(
  draft: Pick<TemplateDraft, 'vars' | 'body_preview'>,
  offerTextValue = '',
  headline?: string,
): string {
  if (!draft.body_preview.trim()) return '';
  return renderPreview(draft.body_preview, buildVars(draft.vars, previewValues(offerTextValue, headline)));
}

/**
 * Mistakes worth flagging while the owner edits, before Meta or a real send finds
 * them. All advisory: Meta's copy rules are checked by Meta, but the ones below
 * are the usual reasons a template is rejected or a send fails, and catching them
 * here is free.
 */
export function templateProblems(draft: Pick<TemplateDraft, 'vars' | 'body_preview'>): string[] {
  const problems: string[] = [];
  const body = draft.body_preview;
  if (body.length > TEMPLATE_BODY_PREVIEW_MAX) {
    problems.push(`The message copy is longer than WhatsApp's ${TEMPLATE_BODY_PREVIEW_MAX} characters.`);
  }
  if (!body.trim()) return problems;

  const used = new Set<number>();
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) used.add(Number(m[1]));

  const tooHigh = [...used].filter((n) => n > draft.vars.length || n < 1).sort((a, b) => a - b);
  if (tooHigh.length > 0) {
    problems.push(
      `The message uses ${tooHigh.map((n) => `{{${n}}}`).join(', ')} but only ${draft.vars.length} variable${draft.vars.length === 1 ? ' is' : 's are'} listed. WhatsApp will reject the send.`,
    );
  }
  const unused: number[] = [];
  for (let n = 1; n <= draft.vars.length; n++) if (!used.has(n)) unused.push(n);
  if (unused.length > 0 && used.size > 0) {
    problems.push(
      `Variable ${unused.map((n) => `{{${n}}}`).join(', ')} is listed but the message never uses it. The count must match the approved template exactly.`,
    );
  }
  const trimmed = body.trim();
  if (/^\{\{\s*\d+\s*\}\}/.test(trimmed)) problems.push('The message starts with a variable. WhatsApp does not allow that.');
  if (/\{\{\s*\d+\s*\}\}$/.test(trimmed)) problems.push('The message ends with a variable. WhatsApp does not allow that.');
  if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(body)) {
    problems.push('Two variables sit next to each other. WhatsApp needs words between them.');
  }
  return problems;
}
