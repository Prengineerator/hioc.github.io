// WhatsApp template variables (spec §5). Pure and client-safe: the dashboard uses
// it to preview a message; the sender uses it to fill the real one.
//
// Marketing copy is a Meta-approved template with numbered slots {{1}}…{{n}}. The
// owner lists, in order, which value fills each slot (a "token"). This file turns
// tokens into the strings Meta will accept. Meta REJECTS a parameter that has a
// newline or tab, runs of spaces, is empty, or is too long — and a rejected
// message is a failed, wasted send — so every value goes through sanitizeParam.
//
// Two stages, because some values are known at plan time and some only at send:
//   templateValues(ctx)      formats the plan-time facts (name, points, expiry
//                            date) into strings. Store the result on the recipient
//                            (marketing_recipients.vars) so the message is frozen.
//   buildVars(tokens, vals)  at send time: merge in what only exists then (the
//                            coupon `code`, `valid_till`) and produce the ordered,
//                            sanitised string[] for the API call.

import {
  CLICK_TOKEN_ALPHABET,
  CLICK_TOKEN_LENGTH,
  FIRST_NAME_MAX,
  HEADLINE_MAX,
  TEMPLATE_PARAM_MAX,
  TEMPLATE_TOKENS,
} from './types';
import type { TemplateToken } from './types';
import { istDate, toMs, type Instant } from './ist';

export { TEMPLATE_TOKENS };

/** A token → string map: what buildVars reads and what a recipient's frozen `vars` holds. */
export type TemplateValues = Partial<Record<TemplateToken, string>>;

/** The raw, typed facts templateValues formats. Anything omitted becomes '-' at build time. */
export interface TemplateContext {
  /** The profile name; the first word becomes {{first_name}}. */
  name?: string | null;
  points?: number;
  points_value_inr?: number;
  expiring_points?: number;
  expiring_value_inr?: number;
  /** When the oldest expiring points go. */
  expiry_date?: Instant | null;
  offer_text?: string;
  code?: string;
  /** Last day the coupon works. */
  valid_till?: Instant | null;
  days_since_visit?: number | null;
  headline?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "5 Oct" — the IST calendar day of `instant`, no year, English month names
 * hard-coded so the result never depends on the host's locale or ICU build.
 */
export function formatShortDate(instant: Instant): string {
  if (!Number.isFinite(toMs(instant))) return '';
  const [, month, day] = istDate(instant).split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

/** Cuts to at most `max` characters without splitting an emoji or other surrogate pair. */
function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

/**
 * The first word of a customer's name for "Hi {{1}}": at most 20 characters,
 * "there" when there is nothing usable. A name that is really a phone number
 * (counter customers are sometimes saved that way) also becomes "there" — "Hi
 * 9876543210" reads as a mistake.
 */
export function firstName(name: string | null | undefined): string {
  const first = (name ?? '').replace(/[\r\n\t]/g, ' ').trim().split(/\s+/)[0] ?? '';
  if (!first || /^\+?\d[\d-]*$/.test(first)) return 'there';
  return clip(first, FIRST_NAME_MAX);
}

/**
 * Makes one value acceptable to Meta as a template parameter (spec §5):
 *   1. newlines and tabs are removed — replaced by a space, so "Hello\nWorld" reads
 *      "Hello World" rather than "HelloWorld";
 *   2. runs of spaces collapse to one;
 *   3. the result is trimmed;
 *   4. capped at 100 characters (and re-trimmed, so the cut can't leave a trailing space);
 *   5. an empty result becomes '-', because an empty parameter is rejected.
 */
export function sanitizeParam(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  const capped = clip(cleaned, TEMPLATE_PARAM_MAX).trim();
  return capped === '' ? '-' : capped;
}

function wholeNumber(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? String(Math.max(0, Math.round(n))) : '';
}

/**
 * Formats the plan-time facts into token strings. Store the result on the
 * recipient; it is what the message will say, frozen. Values not supplied are
 * left out (buildVars turns a missing token into '-').
 */
export function templateValues(ctx: TemplateContext): TemplateValues {
  const out: TemplateValues = {};
  if (ctx.name !== undefined) out.first_name = firstName(ctx.name);
  if (ctx.points !== undefined) out.points = wholeNumber(ctx.points);
  if (ctx.points_value_inr !== undefined) out.points_value_inr = wholeNumber(ctx.points_value_inr);
  if (ctx.expiring_points !== undefined) out.expiring_points = wholeNumber(ctx.expiring_points);
  if (ctx.expiring_value_inr !== undefined) out.expiring_value_inr = wholeNumber(ctx.expiring_value_inr);
  if (ctx.expiry_date) out.expiry_date = formatShortDate(ctx.expiry_date);
  if (ctx.offer_text !== undefined) out.offer_text = ctx.offer_text;
  if (ctx.code !== undefined) out.code = ctx.code;
  if (ctx.valid_till) out.valid_till = formatShortDate(ctx.valid_till);
  if (ctx.days_since_visit !== undefined && ctx.days_since_visit !== null) {
    out.days_since_visit = wholeNumber(ctx.days_since_visit);
  }
  if (ctx.headline !== undefined) out.headline = clip(ctx.headline.replace(/[\r\n\t]+/g, ' ').trim(), HEADLINE_MAX);
  return out;
}

/**
 * The ordered parameter list for the API call: one sanitised string per token,
 * in the owner's order. A token with no value becomes '-' rather than being
 * dropped — dropping would shift every later {{n}} into the wrong slot.
 */
export function buildVars(tokens: readonly TemplateToken[], values: TemplateValues): string[] {
  return tokens.map((token) => sanitizeParam(values[token]));
}

/**
 * Substitutes {{n}} (1-based) in the owner's body copy with the parameter list.
 * A placeholder with no matching parameter is left as written so a mismatch is
 * visible in the preview instead of silently vanishing.
 */
export function renderPreview(bodyPreview: string, vars: readonly string[]): string {
  return bodyPreview.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n: string) => {
    const value = vars[Number(n) - 1];
    return value === undefined ? whole : value;
  });
}

/**
 * A random 12-character base64url token for the URL button (/r/<token>). The RNG
 * is injected — pass a crypto-backed one in production, a seeded one in tests.
 * `rng` must return a number in [0, 1).
 */
export function generateClickToken(rng: () => number): string {
  let token = '';
  for (let i = 0; i < CLICK_TOKEN_LENGTH; i++) {
    const idx = Math.min(CLICK_TOKEN_ALPHABET.length - 1, Math.floor(rng() * CLICK_TOKEN_ALPHABET.length));
    token += CLICK_TOKEN_ALPHABET[idx];
  }
  return token;
}
