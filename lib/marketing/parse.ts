// Strict request-body validators for the owner marketing APIs (spec §6). Pure and
// client-safe — the route handlers call them, and the dashboard can call the same
// ones to validate a form before it ever posts.
//
// Every validator takes `unknown` (a parsed JSON body), returns
// {ok:true, value} | {ok:false, error}, and never throws. `error` is a sentence
// the owner can act on ("Monthly budget must be a whole number between 0 and
// 1000000."), not a code. Rules shared with the database — the settings bounds —
// come from types.ts, and a test pins them to the CHECKs in
// supabase/2026-10-marketing-agent.sql so the two can't drift.
//
// Unknown keys in a body are ignored (an older client can't write a newer column)
// EXCEPT inside playbook `params`, where a misspelt parameter would otherwise
// save silently and do nothing.

import { normalizeIndianMobile } from '@/lib/phone';
import {
  AUDIENCE_BOUNDS,
  CAMPAIGN_NAME_MAX,
  COST_BOUNDS,
  COSTS_PUT_MAX_ROWS,
  HEADLINE_MAX,
  LIFECYCLE_STAGES,
  MESSAGE_COST_BOUNDS,
  OFFER_BOUNDS,
  PARAM_BOUNDS,
  PLAYBOOK_MODES,
  SETTINGS_BOUNDS,
  TEMPLATE_BODY_PREVIEW_MAX,
  TEMPLATE_LANG_PATTERN,
  TEMPLATE_MAX_VARS,
  TEMPLATE_NAME_PATTERN,
  TEMPLATE_TOKENS,
} from './types';
import type {
  AudienceFilter,
  CostInput,
  CostsPutBody,
  IntSettingKey,
  LifecycleStage,
  ManualCampaignInput,
  MarketingSettings,
  MarketingSettingsPatch,
  Offer,
  ParseResult,
  PlaybookKey,
  PlaybookMode,
  PlaybookParams,
  PlaybookPatch,
  TemplateConfig,
  TemplateToken,
} from './types';

type Obj = Record<string, unknown>;

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const bad = <T = never>(error: string): ParseResult<T> => ({ ok: false, error });
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Is `k` supplied? An explicit `undefined` counts as absent — it is what JSON.stringify would have dropped. */
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A finite number in [min, max]; whole unless `decimals` says how many places are allowed (extra places are rounded off). */
function readNumber(v: unknown, label: string, min: number, max: number, decimals = 0): ParseResult<number> {
  const range = `between ${min} and ${max}`;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return bad(`${label} must be ${decimals ? 'a number' : 'a whole number'} ${range}.`);
  }
  if (decimals === 0) {
    if (!Number.isInteger(v)) return bad(`${label} must be a whole number ${range}.`);
    if (v < min || v > max) return bad(`${label} must be ${range}.`);
    return ok(v);
  }
  const factor = 10 ** decimals;
  const rounded = Math.round(v * factor) / factor;
  if (rounded < min || rounded > max) return bad(`${label} must be ${range}.`);
  return ok(rounded);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTING_LABELS: Record<IntSettingKey, string> = {
  monthly_budget_inr: 'Monthly budget (₹)',
  send_window_start_hour: 'Send window start hour',
  send_window_end_hour: 'Send window end hour',
  daily_send_cap: 'Daily send cap',
  min_days_between: 'Days between messages',
  max_per_30_days: 'Messages per 30 days',
  holdout_pct: 'Holdout %',
  attribution_days: 'Attribution window (days)',
  min_margin_pct: 'Minimum margin %',
  default_food_cost_pct: 'Default food cost %',
  drop_alert_pct: 'Drop alert %',
  pause_after_unread: 'Pause after unread messages',
};

/**
 * Normalises what an owner might type for the business number into E.164:
 * '+91 98765 43210', '098765 43210', '919876543210' and '9876543210' all become
 * '+919876543210'; any other international number must already start with '+'.
 * '' clears it.
 */
function normalizeBusinessNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const compact = trimmed.replace(/[\s\-().]/g, '');
  if (/^\+[1-9][0-9]{7,14}$/.test(compact)) return compact;
  const indian = normalizeIndianMobile(compact);
  return indian ? `+91${indian}` : null;
}

/**
 * Cross-field rule that a partial patch cannot see: the send window must end
 * after it starts. Run it on the MERGED settings (existing row + patch) before
 * saving; the database has the same CHECK. null = fine.
 */
export function validateMergedSettings(s: Pick<MarketingSettings, 'send_window_start_hour' | 'send_window_end_hour'>): string | null {
  return s.send_window_end_hour > s.send_window_start_hour ? null : 'The send window must end after it starts.';
}

/**
 * PATCH /api/owner/marketing/settings. Any subset of the editable settings;
 * integer bounds are the SQL CHECKs. When the patch carries both window hours it
 * also checks end > start (a patch with only one is checked by the caller after
 * merging — see validateMergedSettings).
 */
export function parseSettingsPatch(body: unknown): ParseResult<MarketingSettingsPatch> {
  if (!isObj(body)) return bad('Request body must be a JSON object.');
  const patch: MarketingSettingsPatch = {};

  if (has(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') return bad('enabled must be true or false.');
    patch.enabled = body.enabled;
  }

  for (const key of Object.keys(SETTINGS_BOUNDS) as IntSettingKey[]) {
    if (!has(body, key)) continue;
    const { min, max } = SETTINGS_BOUNDS[key];
    const r = readNumber(body[key], SETTING_LABELS[key], min, max);
    if (!r.ok) return r;
    patch[key] = r.value;
  }

  if (has(body, 'message_cost_inr')) {
    const r = readNumber(body.message_cost_inr, 'Message cost (₹)', MESSAGE_COST_BOUNDS.min, MESSAGE_COST_BOUNDS.max, MESSAGE_COST_BOUNDS.decimals);
    if (!r.ok) return r;
    patch.message_cost_inr = r.value;
  }

  if (has(body, 'whatsapp_business_number')) {
    if (typeof body.whatsapp_business_number !== 'string') return bad('The WhatsApp business number must be text.');
    const n = normalizeBusinessNumber(body.whatsapp_business_number);
    if (n === null) return bad('The WhatsApp business number must be a valid phone number, like +919876543210.');
    patch.whatsapp_business_number = n;
  }

  if (patch.send_window_start_hour !== undefined && patch.send_window_end_hour !== undefined) {
    const e = validateMergedSettings({
      send_window_start_hour: patch.send_window_start_hour,
      send_window_end_hour: patch.send_window_end_hour,
    });
    if (e) return bad(e);
  }

  if (Object.keys(patch).length === 0) return bad('Nothing to update.');
  return ok(patch);
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/** The default price ceiling for an auto-picked free item, ₹. */
const DEFAULT_MAX_ITEM_PRICE = 250;

function readNullableUuid(v: unknown, label: string): ParseResult<string | null> {
  if (v === null || v === undefined) return ok(null);
  if (typeof v !== 'string' || !UUID.test(v)) return bad(`${label} must be an id or null.`);
  return ok(v.toLowerCase());
}

/**
 * A stored offer. Required per type: percent → percent, validity_days; flat →
 * amount_inr, validity_days; free_item → validity_days. Optional with defaults:
 * cap_inr 0 (no cap), min_order_inr 0, max_item_price 250, item_id/variant_id
 * null (auto-pick). The frozen fields a planner adds to a campaign's free item
 * (item_name, variant_label, price_inr, cost_inr) are DROPPED if a client sends
 * them: a cost supplied by the browser is not a cost.
 */
export function parseOffer(raw: unknown): ParseResult<Offer> {
  if (!isObj(raw)) return bad('offer must be an object.');
  const type = raw.type;

  if (type === 'none') return ok({ type: 'none' });

  const minOrder = has(raw, 'min_order_inr')
    ? readNumber(raw.min_order_inr, 'Minimum order (₹)', OFFER_BOUNDS.min_order_inr.min, OFFER_BOUNDS.min_order_inr.max)
    : ok(0);
  if (!minOrder.ok) return minOrder;
  const validity = readNumber(raw.validity_days, 'Offer validity (days)', OFFER_BOUNDS.validity_days.min, OFFER_BOUNDS.validity_days.max);
  if (!validity.ok) return validity;

  if (type === 'percent') {
    const percent = readNumber(raw.percent, 'Discount %', OFFER_BOUNDS.percent.min, OFFER_BOUNDS.percent.max);
    if (!percent.ok) return percent;
    const cap = has(raw, 'cap_inr')
      ? readNumber(raw.cap_inr, 'Maximum discount (₹)', OFFER_BOUNDS.cap_inr.min, OFFER_BOUNDS.cap_inr.max)
      : ok(0);
    if (!cap.ok) return cap;
    return ok({ type: 'percent', percent: percent.value, cap_inr: cap.value, min_order_inr: minOrder.value, validity_days: validity.value });
  }

  if (type === 'flat') {
    const amount = readNumber(raw.amount_inr, 'Discount amount (₹)', OFFER_BOUNDS.amount_inr.min, OFFER_BOUNDS.amount_inr.max);
    if (!amount.ok) return amount;
    return ok({ type: 'flat', amount_inr: amount.value, min_order_inr: minOrder.value, validity_days: validity.value });
  }

  if (type === 'free_item') {
    const itemId = readNullableUuid(raw.item_id, 'item_id');
    if (!itemId.ok) return itemId;
    const variantId = readNullableUuid(raw.variant_id, 'variant_id');
    if (!variantId.ok) return variantId;
    if ((itemId.value === null) !== (variantId.value === null)) {
      return bad('A free item needs both an item and a size, or neither (the best-value pick).');
    }
    const maxPrice = has(raw, 'max_item_price')
      ? readNumber(raw.max_item_price, 'Free item price limit (₹)', OFFER_BOUNDS.max_item_price.min, OFFER_BOUNDS.max_item_price.max)
      : ok(DEFAULT_MAX_ITEM_PRICE);
    if (!maxPrice.ok) return maxPrice;
    return ok({
      type: 'free_item',
      item_id: itemId.value,
      variant_id: variantId.value,
      max_item_price: maxPrice.value,
      min_order_inr: minOrder.value,
      validity_days: validity.value,
    });
  }

  return bad("offer.type must be 'none', 'percent', 'flat' or 'free_item'.");
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TOKEN_SET: ReadonlySet<string> = new Set(TEMPLATE_TOKENS);

/**
 * A template mapping: name (`^[a-z0-9_]{1,512}$`), lang (`en` or `en_US`), 1–10
 * variable tokens from the known list, url_button, and an optional body copy of at
 * most 1024 characters. `allowEmptyName` accepts name '' (a wizard that hasn't
 * picked a template yet, so its live projection can show the no_template flag).
 * `allowHeadline` permits the `headline` token — manual campaigns only.
 */
export function parseTemplate(
  raw: unknown,
  opts: { allowEmptyName?: boolean; allowHeadline?: boolean } = {},
): ParseResult<TemplateConfig> {
  if (!isObj(raw)) return bad('template must be an object.');

  if (typeof raw.name !== 'string') return bad('The template name must be text.');
  const name = raw.name.trim();
  if (!(opts.allowEmptyName && name === '') && !TEMPLATE_NAME_PATTERN.test(name)) {
    return bad('The template name must be lowercase letters, numbers and underscores, exactly as it appears in WhatsApp Manager.');
  }

  if (typeof raw.lang !== 'string' || !TEMPLATE_LANG_PATTERN.test(raw.lang.trim())) {
    return bad("The template language must look like 'en' or 'en_US'.");
  }

  if (!Array.isArray(raw.vars) || raw.vars.length < 1 || raw.vars.length > TEMPLATE_MAX_VARS) {
    return bad(`A template needs between 1 and ${TEMPLATE_MAX_VARS} variables.`);
  }
  for (const v of raw.vars) {
    if (typeof v !== 'string' || !TOKEN_SET.has(v)) return bad(`"${String(v)}" is not a known template variable.`);
    if (v === 'headline' && !opts.allowHeadline) return bad('The headline variable is only available in manual campaigns.');
  }

  if (typeof raw.url_button !== 'boolean') return bad('url_button must be true or false.');

  let bodyPreview = '';
  if (has(raw, 'body_preview') && raw.body_preview !== null) {
    if (typeof raw.body_preview !== 'string') return bad('The template body must be text.');
    if (raw.body_preview.length > TEMPLATE_BODY_PREVIEW_MAX) {
      return bad(`The template body can be at most ${TEMPLATE_BODY_PREVIEW_MAX} characters.`);
    }
    bodyPreview = raw.body_preview;
  }

  return ok({
    name,
    lang: raw.lang.trim(),
    vars: raw.vars as TemplateToken[],
    url_button: raw.url_button,
    body_preview: bodyPreview,
  });
}

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

/** Params that take decimals; everything else is a whole number. */
const DECIMAL_PARAMS: ReadonlySet<string> = new Set(['gap_multiplier']);

/**
 * Cross-field rules inside one playbook's params — run on the MERGED params
 * (stored + patch) because a patch may carry only one side.
 *   winback_1: min_days ≤ max_days
 *   winback_3: max_days (the "lost" line) must come after offset_days
 * null = fine.
 */
export function validatePlaybookParams(key: PlaybookKey, params: Partial<PlaybookParams>): string | null {
  if (key === 'winback_1') {
    const p = params as Partial<{ min_days: number; max_days: number }>;
    if (p.min_days !== undefined && p.max_days !== undefined && p.min_days > p.max_days) {
      return 'The shortest lapse threshold cannot be longer than the longest.';
    }
  }
  if (key === 'winback_3') {
    const p = params as Partial<{ offset_days: number; max_days: number }>;
    if (p.offset_days !== undefined && p.max_days !== undefined && p.max_days <= p.offset_days) {
      return 'The "lost after" days must be more than the stage 3 offset.';
    }
  }
  return null;
}

function parseParams<K extends PlaybookKey>(key: K, raw: unknown): ParseResult<Partial<PlaybookParams>> {
  if (!isObj(raw)) return bad('params must be an object.');
  const bounds = PARAM_BOUNDS[key] as Record<string, { min: number; max: number }>;
  const out: Record<string, number> = {};
  for (const name of Object.keys(raw)) {
    const b = bounds[name];
    if (!b) return bad(`"${name}" is not a setting of this playbook.`);
    const label = name.replace(/_/g, ' ');
    const r = readNumber(raw[name], `${label.charAt(0).toUpperCase()}${label.slice(1)}`, b.min, b.max, DECIMAL_PARAMS.has(name) ? 2 : 0);
    if (!r.ok) return r;
    out[name] = r.value;
  }
  const cross = validatePlaybookParams(key, out as Partial<PlaybookParams>);
  if (cross) return bad(cross);
  return ok(out as Partial<PlaybookParams>);
}

/**
 * PATCH /api/owner/marketing/playbooks/[key]. Any subset of mode, params (itself
 * partial), offer, template and prior_conversion_pct. Points playbooks can only
 * carry the 'none' offer — the customer's own points are the offer, and a coupon
 * on top would be priced wrongly. `headline` is not a playbook variable.
 */
export function parsePlaybookPatch<K extends PlaybookKey>(key: K, body: unknown): ParseResult<PlaybookPatch<K>> {
  if (!isObj(body)) return bad('Request body must be a JSON object.');
  const patch: PlaybookPatch<K> = {};

  if (has(body, 'mode')) {
    if (typeof body.mode !== 'string' || !(PLAYBOOK_MODES as readonly string[]).includes(body.mode)) {
      return bad("mode must be 'off', 'review' or 'auto'.");
    }
    patch.mode = body.mode as PlaybookMode;
  }

  if (has(body, 'params')) {
    const r = parseParams(key, body.params);
    if (!r.ok) return r;
    patch.params = r.value as Partial<PlaybookParams> as PlaybookPatch<K>['params'];
  }

  if (has(body, 'offer')) {
    const r = parseOffer(body.offer);
    if (!r.ok) return r;
    if (key.startsWith('points_') && r.value.type !== 'none') {
      return bad('Points reminders cannot carry an offer: the customer’s own points are the offer.');
    }
    patch.offer = r.value;
  }

  if (has(body, 'template')) {
    const r = parseTemplate(body.template);
    if (!r.ok) return r;
    patch.template = r.value;
  }

  if (has(body, 'prior_conversion_pct')) {
    const r = readNumber(body.prior_conversion_pct, 'Expected conversion %', 0, 100, 2);
    if (!r.ok) return r;
    patch.prior_conversion_pct = r.value;
  }

  if (Object.keys(patch).length === 0) return bad('Nothing to update.');
  return ok(patch);
}

// ---------------------------------------------------------------------------
// Manual campaigns
// ---------------------------------------------------------------------------

/** Audience filter. Every field optional; unknown keys are ignored; an empty object means all opted-in contacts. */
export function parseAudienceFilter(raw: unknown): ParseResult<AudienceFilter> {
  if (raw === undefined || raw === null) return ok({});
  if (!isObj(raw)) return bad('audience must be an object.');
  const out: AudienceFilter = {};

  if (has(raw, 'stages')) {
    if (!Array.isArray(raw.stages)) return bad('audience.stages must be a list.');
    const stages: LifecycleStage[] = [];
    for (const s of raw.stages) {
      if (typeof s !== 'string' || !(LIFECYCLE_STAGES as readonly string[]).includes(s)) {
        return bad(`"${String(s)}" is not a customer stage.`);
      }
      if (!stages.includes(s as LifecycleStage)) stages.push(s as LifecycleStage);
    }
    if (stages.length > 0) out.stages = stages;
  }

  if (has(raw, 'vip_only')) {
    if (typeof raw.vip_only !== 'boolean') return bad('vip_only must be true or false.');
    if (raw.vip_only) out.vip_only = true;
  }

  const ints: [keyof AudienceFilter, string, { min: number; max: number }][] = [
    ['min_orders', 'Minimum orders', AUDIENCE_BOUNDS.min_orders],
    ['min_spend_inr', 'Minimum spend (₹)', AUDIENCE_BOUNDS.min_spend_inr],
    ['last_order_from_days', 'Last order from (days ago)', AUDIENCE_BOUNDS.last_order_days],
    ['last_order_to_days', 'Last order to (days ago)', AUDIENCE_BOUNDS.last_order_days],
    ['min_points', 'Minimum points', AUDIENCE_BOUNDS.min_points],
  ];
  for (const [key, label, b] of ints) {
    if (!has(raw, key) || raw[key] === null) continue;
    const r = readNumber(raw[key], label, b.min, b.max);
    if (!r.ok) return r;
    (out as Record<string, number>)[key] = r.value;
  }

  if (
    out.last_order_from_days !== undefined &&
    out.last_order_to_days !== undefined &&
    out.last_order_from_days > out.last_order_to_days
  ) {
    return bad('"Last order from" cannot be later than "last order to".');
  }
  return ok(out);
}

/**
 * POST /api/owner/marketing/campaigns and /campaigns/preview body.
 *
 *   name       1–80 characters after trimming
 *   audience   AudienceFilter (omitted = everyone opted in)
 *   offer      parseOffer
 *   template   parseTemplate, headline allowed; if it uses {headline} the headline is required
 *   headline   ≤ 60 characters, newlines flattened
 *   send_after ISO timestamp or null; returned normalised to ISO, null when absent
 *
 * `preview: true` is for the wizard's live projection: an unnamed campaign or an
 * unset template name is accepted (the projection then shows the no_template
 * flag) and a missing headline is tolerated. Anything else is still strict.
 */
export function parseManualCampaign(
  body: unknown,
  opts: { preview?: boolean } = {},
): ParseResult<ManualCampaignInput & { send_after: string | null }> {
  if (!isObj(body)) return bad('Request body must be a JSON object.');
  const preview = opts.preview === true;

  if (typeof body.name !== 'string') return bad('The campaign needs a name.');
  const name = body.name.trim();
  if (name.length > CAMPAIGN_NAME_MAX) return bad(`The campaign name can be at most ${CAMPAIGN_NAME_MAX} characters.`);
  if (name.length < 1 && !preview) return bad('The campaign needs a name.');

  const audience = parseAudienceFilter(body.audience);
  if (!audience.ok) return audience;

  const offer = parseOffer(body.offer);
  if (!offer.ok) return offer;

  const template = parseTemplate(body.template, { allowEmptyName: preview, allowHeadline: true });
  if (!template.ok) return template;

  let headline: string | undefined;
  if (has(body, 'headline') && body.headline !== null) {
    if (typeof body.headline !== 'string') return bad('The headline must be text.');
    headline = body.headline.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    if (Array.from(headline).length > HEADLINE_MAX) return bad(`The headline can be at most ${HEADLINE_MAX} characters.`);
  }
  if (template.value.vars.includes('headline') && !headline && !preview) {
    return bad('This template uses the headline, so please type one.');
  }

  let sendAfter: string | null = null;
  if (has(body, 'send_after') && body.send_after !== null) {
    if (typeof body.send_after !== 'string' || Number.isNaN(Date.parse(body.send_after))) {
      return bad('send_after must be a date and time, or empty to send as soon as approved.');
    }
    sendAfter = new Date(body.send_after).toISOString();
  }

  const value: ManualCampaignInput & { send_after: string | null } = {
    name,
    audience: audience.value,
    offer: offer.value,
    template: template.value,
    send_after: sendAfter,
  };
  if (headline !== undefined && headline !== '') value.headline = headline;
  return ok(value);
}

// ---------------------------------------------------------------------------
// Product costs
// ---------------------------------------------------------------------------

/**
 * PUT /api/owner/marketing/costs body: {costs: [{variant_id, cost_inr}]}. A
 * variant_id is a uuid, appearing once; cost_inr is null (delete the cost) or ₹
 * 0–100000, kept to 2 decimals. At most 500 rows per request; an empty list is a
 * valid no-op.
 */
export function parseCostsPut(body: unknown): ParseResult<CostsPutBody> {
  if (!isObj(body)) return bad('Request body must be a JSON object.');
  if (!Array.isArray(body.costs)) return bad('costs must be a list.');
  if (body.costs.length > COSTS_PUT_MAX_ROWS) return bad(`At most ${COSTS_PUT_MAX_ROWS} costs can be saved at once.`);

  const seen = new Set<string>();
  const costs: CostInput[] = [];
  for (const row of body.costs) {
    if (!isObj(row)) return bad('Each cost must be an object with a variant_id and cost_inr.');
    if (typeof row.variant_id !== 'string' || !UUID.test(row.variant_id)) return bad('Each cost needs a valid variant_id.');
    const id = row.variant_id.toLowerCase();
    if (seen.has(id)) return bad('The same item size appears more than once.');
    seen.add(id);

    if (row.cost_inr === null) {
      costs.push({ variant_id: id, cost_inr: null });
      continue;
    }
    const cost = readNumber(row.cost_inr, 'Cost (₹)', COST_BOUNDS.min, COST_BOUNDS.max, 2);
    if (!cost.ok) return cost;
    costs.push({ variant_id: id, cost_inr: cost.value });
  }
  return ok({ costs });
}
