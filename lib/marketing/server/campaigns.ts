// Campaigns — pricing, creation, approval, cancellation and the read models the
// dashboard shows (spec §1.6, §4, §6). The planner (playbook campaigns) and the owner
// API (manual campaigns) both create campaigns through insertCampaign(), and both
// price them through priceCampaign(), so the two can never disagree about what a
// campaign costs or how its holdout is drawn.
//
// What is FROZEN on a campaign the moment it is planned: the offer (a free item is
// resolved to a real variant), the template, the projection and the guardrail flags,
// and every recipient's message variables. What the owner approved is exactly what
// sends, even if the playbook, the menu or a price is edited in between.

import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  basketValue,
  blendedRate,
  computeLift,
  guardrailFlags,
  project,
  resolveFreeItemOffer,
  splitHoldout,
} from '@/lib/marketing/economics';
import { evaluateContact } from '@/lib/marketing/eligibility';
import { DAY_MS, istDate, istMonthStart } from '@/lib/marketing/ist';
import { couponPrefixFor, needsCoupon, offerText, validTill, validityDays, secureRng } from '@/lib/marketing/offers';
import { matchesAudience } from '@/lib/marketing/segments';
import {
  buildVars,
  formatShortDate,
  generateClickToken,
  renderPreview,
  templateValues,
  type TemplateValues,
} from '@/lib/marketing/templates';
import {
  APPROVAL_EXPIRY_DAYS,
  CAMPAIGN_LIST_STATUSES,
  DRAFT_EXPIRY_DAYS,
  MANUAL_PRIOR_PCT,
  RECIPIENT_PAGE_SIZE,
  TERMINAL_CAMPAIGN_STATUSES,
} from '@/lib/marketing/types';
import type {
  AudienceFilter,
  CampaignAudienceJson,
  CampaignDetail,
  CampaignListFilter,
  CampaignPreview,
  CampaignResults,
  CampaignStatus,
  CampaignSummary,
  CampaignTotals,
  ContactStats,
  FreeItemOffer,
  GuardrailFlag,
  ManualCampaignInput,
  Offer,
  PlaybookKey,
  PointsOffer,
  Projection,
  RecipientPreview,
  RecipientRow,
  TemplateConfig,
} from '@/lib/marketing/types';
import type { AudienceSnapshot } from './audience';
import { buildContacts } from './audience';
import {
  IN_CHUNK,
  PAGE_ROWS,
  assertOk,
  chunk,
  countCommittedSends,
  isUniqueViolation,
  loadCampaign,
  marketingAdmin,
  pageAll,
  sumSpendSince,
  toCampaignRow,
  toRecipientRow,
  type Admin,
  type CampaignRow,
  type RecipientDbRow,
} from './repo';

/** Priority of a manual campaign in the sender's queue (playbooks use their own 1–5; lower goes first). */
export const MANUAL_PRIORITY = 10;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Median of the finite values; 0 for none. */
export function median(values: readonly number[]): number {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function hashSeed(seed: string): number {
  // FNV-1a — a stable 32-bit string hash; no dependency, identical on every runtime.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A Fisher–Yates shuffle seeded by a string (the campaign id). Deterministic: the same
 * campaign id and the same input order give the same order on every run, so tests are
 * stable and a retried insert would draw the identical holdout. Returns a new array.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const rng = mulberry32(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface PriceCampaignInput {
  snapshot: AudienceSnapshot;
  /** The contacts that passed eligibility — N. */
  eligible: readonly ContactStats[];
  /** The stored offer (a free item may still be unresolved). */
  offer: Offer;
  template_name: string;
  /** Points playbooks price the customer's own points instead of a coupon. */
  points_offer?: 'expiring' | 'balance';
  prior_conversion_pct: number;
  observed_treated: number;
  observed_conversions: number;
  /** ₹ of monthly budget still free for THIS campaign's messages (may be ≤ 0). */
  budget_remaining_inr: number;
}

export interface PricedCampaign {
  /** The offer to store: a free item resolved to a real variant, or left unresolved (then flagged no_free_item). */
  offer: Offer;
  projection: Projection;
  guardrail_flags: GuardrailFlag[];
}

/** Freezes an offer: a free item is resolved to a variant (auto-pick or the owner's pin); anything else is unchanged. */
export function freezeOffer(offer: Offer, snapshot: AudienceSnapshot): Offer {
  if (offer.type !== 'free_item') return offer;
  const stored: FreeItemOffer = offer;
  const resolved = resolveFreeItemOffer(stored, snapshot.economics.variants, snapshot.settings.default_food_cost_pct);
  return resolved ?? stored;
}

/**
 * Prices one campaign: the frozen offer, the spec §1.6 projection and the guardrail
 * flags. The one place a campaign's economics are computed.
 */
export function priceCampaign(input: PriceCampaignInput): PricedCampaign {
  const { snapshot, eligible } = input;
  const { settings, economics, loyalty } = snapshot;

  const offer = freezeOffer(input.offer, snapshot);

  let economicOffer: Offer | PointsOffer = offer;
  if (input.points_offer) {
    const values = eligible.map((c) => (input.points_offer === 'expiring' ? c.expiring_value_inr : c.points_value_inr));
    economicOffer = { type: 'points', points_value_inr: median(values) };
  }

  const basket = basketValue(eligible.map((c) => c.aov_inr), economics.store_aov_inr);
  const rate = blendedRate(input.prior_conversion_pct, input.observed_treated, input.observed_conversions);

  const projection = project({
    eligible: eligible.length,
    holdout_pct: settings.holdout_pct,
    message_cost_inr: settings.message_cost_inr,
    deliverability: economics.deliverability,
    conversion_rate: rate,
    basket_inr: basket,
    food_cost_ratio: economics.food_cost.ratio,
    offer: economicOffer,
    max_redeem_pct: loyalty.max_redeem_pct,
  });

  const flags = guardrailFlags({
    projection,
    min_margin_pct: settings.min_margin_pct,
    budget_remaining_inr: input.budget_remaining_inr,
    cost_coverage_pct: economics.food_cost.coverage_pct,
    template_name: input.template_name,
    offer: economicOffer,
  });

  return { offer, projection, guardrail_flags: flags };
}

/**
 * What is left of this month's budget for NEW commitments: the monthly budget, minus
 * what was already spent this IST month, minus messages already approved and queued
 * but not yet sent (spend already promised). A campaign is flagged over_budget against
 * this, so two campaigns planned the same morning do not each see the whole budget.
 */
export async function remainingBudget(admin: Admin, snapshotSettings: { monthly_budget_inr: number; message_cost_inr: number }, now: Date): Promise<number> {
  const [spent, committed] = await Promise.all([
    sumSpendSince(admin, istMonthStart(now).toISOString()),
    countCommittedSends(admin),
  ]);
  return snapshotSettings.monthly_budget_inr - spent - committed * snapshotSettings.message_cost_inr;
}

// ---------------------------------------------------------------------------
// Recipient variables and previews
// ---------------------------------------------------------------------------

/**
 * The plan-time message values for one contact (stored on the recipient, so the
 * message is frozen). `code` and `valid_till` are NOT here: they only exist once the
 * coupon is issued at send time.
 */
export function recipientVars(stats: ContactStats, offer: Offer, headline?: string): TemplateValues {
  return templateValues({
    name: stats.first_name,
    points: stats.points_balance,
    points_value_inr: stats.points_value_inr,
    expiring_points: stats.expiring_points,
    expiring_value_inr: stats.expiring_value_inr,
    expiry_date: stats.expiry_date,
    offer_text: offerText(offer),
    days_since_visit: stats.days_since_last_order,
    ...(headline ? { headline } : {}),
  });
}

/** Up to 3 rendered messages. The coupon code is a visible placeholder (codes are issued at send). */
export function renderSamples(
  template: TemplateConfig,
  offer: Offer,
  rows: readonly { first_name: string; vars: TemplateValues }[],
  now: Date,
  playbookKey: PlaybookKey | null,
): RecipientPreview[] {
  return rows.slice(0, 3).map((row) => {
    const values: TemplateValues = { ...row.vars };
    if (needsCoupon(offer)) {
      values.code = `${couponPrefixFor(playbookKey)}XXXXXX`;
      values.valid_till = formatShortDate(validTill(now, validityDays(offer)));
    }
    const vars = buildVars(template.vars, values);
    return { first_name: row.first_name, text: renderPreview(template.body_preview, vars), vars, coupon_code: '' };
  });
}

// ---------------------------------------------------------------------------
// Creating a campaign (shared by the planner and manual drafts)
// ---------------------------------------------------------------------------

export interface NewCampaign {
  id: string;
  kind: 'playbook' | 'manual';
  playbook_key: PlaybookKey | null;
  name: string;
  status: 'draft' | 'pending_approval' | 'approved';
  planned_for: string;
  send_after: string | null;
  audience: CampaignAudienceJson;
  offer: Offer;
  template: TemplateConfig;
  projection: Projection;
  guardrail_flags: GuardrailFlag[];
  priority: number;
  created_by: string | null;
  approved_at?: string | null;
}

export interface NewRecipient {
  stats: ContactStats;
  vars: TemplateValues;
}

export type InsertCampaignResult =
  /** `status` is what the campaign ended up as: an 'approved' one whose final flip failed stays 'pending_approval'. */
  | { ok: true; treated: number; holdout: number; status: 'draft' | 'pending_approval' | 'approved' }
  /** (playbook_key, planned_for) already exists — the planner already ran today. */
  | { ok: false; duplicate: true }
  | { ok: false; duplicate: false; error: string };

const RECIPIENT_INSERT_CHUNK = 500;

/**
 * Removes a campaign whose recipients did not all land; the FK cascades the ones that did. If even
 * that delete fails, the campaign is CANCELLED instead (and its unsent rows with it), so at the very
 * least nobody can approve it with a partial audience. Never throws: the caller is already reporting
 * the failure that got us here.
 */
async function discardCampaign(admin: Admin, id: string): Promise<void> {
  const { error } = await admin.from('marketing_campaigns').delete().eq('id', id);
  if (!error) return;
  console.error('marketing campaign: could not remove a half-made campaign — cancelling it', id, error.message);
  const { error: cancelError } = await admin.from('marketing_campaigns').update({ status: 'cancelled' }).eq('id', id);
  if (cancelError) console.error('marketing campaign: could not cancel a half-made campaign', id, cancelError.message);
  const { error: rowsError } = await admin
    .from('marketing_recipients')
    .update({ status: 'cancelled' })
    .eq('campaign_id', id)
    .in('status', ['pending', 'queued']);
  if (rowsError) console.error('marketing campaign: could not cancel the recipients of a half-made campaign', id, rowsError.message);
}

/**
 * Inserts a campaign and its recipients.
 *
 *   * The holdout is drawn here: `splitHoldout(N, holdout_pct)` people, chosen by a
 *     shuffle seeded with the campaign id (stable across runs and tests). The same
 *     splitHoldout the projection used, so the projected and the real arms agree.
 *   * A treated recipient gets a fresh click token and its frozen variables; a
 *     holdout recipient is stored with status 'holdout' and is never messaged.
 *   * `recipientStatus` is 'queued' when the campaign is born approved (Auto mode
 *     with every guardrail passing), otherwise 'pending' until the owner approves.
 *
 * The campaign row goes in FIRST. A unique violation on (playbook_key, planned_for)
 * means today's run already happened: reported as `duplicate`, nothing else written.
 * If any recipient insert then fails, the campaign is deleted (cascading), so a
 * half-made campaign can neither be approved with a partial audience nor hold the
 * (playbook, day) slot that a re-run needs. Once every insert has succeeded the stored
 * treated_count / holdout_count are set from the rows that actually landed, so the
 * numbers an owner approves are the numbers that exist.
 *
 * A campaign born 'approved' (Auto) is inserted as 'pending_approval' and only flipped to
 * 'approved' once ALL its recipients are in. Otherwise the sender — which completes any
 * approved campaign with nothing in flight — could, in the gap between the two inserts,
 * see an approved campaign with no recipients yet and close it; its recipients would then
 * be queued under a completed campaign and never sent. If the final flip fails the
 * campaign simply stays in Approvals for the owner.
 */
export async function insertCampaign(
  admin: Admin,
  campaign: NewCampaign,
  recipients: readonly NewRecipient[],
  recipientStatus: 'pending' | 'queued',
  holdoutPct: number,
): Promise<InsertCampaignResult> {
  const ordered = [...recipients].sort((a, b) => a.stats.phone.localeCompare(b.stats.phone));
  const { holdout: holdoutN } = splitHoldout(ordered.length, holdoutPct);
  const shuffled = seededShuffle(ordered, campaign.id);
  const holdoutPhones = new Set(shuffled.slice(0, holdoutN).map((r) => r.stats.phone));
  const treatedN = ordered.length - holdoutN;

  const { error: campaignError } = await admin.from('marketing_campaigns').insert({
    id: campaign.id,
    kind: campaign.kind,
    playbook_key: campaign.playbook_key,
    name: campaign.name,
    status: campaign.status === 'approved' ? 'pending_approval' : campaign.status,
    planned_for: campaign.planned_for,
    send_after: campaign.send_after,
    audience: campaign.audience,
    offer: campaign.offer,
    template: campaign.template,
    projection: campaign.projection,
    guardrail_flags: campaign.guardrail_flags,
    priority: campaign.priority,
    treated_count: treatedN,
    holdout_count: holdoutN,
    created_by: campaign.created_by,
  });
  if (campaignError) {
    if (isUniqueViolation(campaignError)) return { ok: false, duplicate: true };
    assertOk('marketing_campaigns write', campaignError);
  }

  const tokens = new Set<string>();
  const rows = ordered.map((r) => {
    const isHoldout = holdoutPhones.has(r.stats.phone);
    let token: string | null = null;
    if (!isHoldout) {
      do token = generateClickToken(secureRng);
      while (tokens.has(token));
      tokens.add(token);
    }
    return {
      campaign_id: campaign.id,
      phone: r.stats.phone,
      user_id: r.stats.user_id,
      first_name: r.stats.first_name,
      arm: isHoldout ? 'holdout' : 'treatment',
      status: isHoldout ? 'holdout' : recipientStatus,
      vars: isHoldout ? {} : r.vars,
      click_token: token,
    };
  });

  let treatedLanded = 0;
  let holdoutLanded = 0;
  try {
    for (const part of chunk(rows, RECIPIENT_INSERT_CHUNK)) {
      const { data, error } = await admin.from('marketing_recipients').insert(part).select('arm');
      assertOk('marketing_recipients write', error);
      // The rows the write says it stored; a client that does not echo them back is taken at its acknowledged word.
      for (const r of (Array.isArray(data) ? data : part) as { arm: string }[]) {
        if (r.arm === 'holdout') holdoutLanded += 1;
        else treatedLanded += 1;
      }
    }
  } catch (err) {
    await discardCampaign(admin, campaign.id);
    return { ok: false, duplicate: false, error: err instanceof Error ? err.message : 'recipients insert failed' };
  }

  if (treatedLanded !== treatedN || holdoutLanded !== holdoutN) {
    const { error: countError } = await admin
      .from('marketing_campaigns')
      .update({ treated_count: treatedLanded, holdout_count: holdoutLanded })
      .eq('id', campaign.id);
    if (countError) console.error('marketing campaign: could not correct the recipient counts', campaign.id, countError.message);
  }

  let status: 'draft' | 'pending_approval' | 'approved' = campaign.status === 'approved' ? 'pending_approval' : campaign.status;
  if (campaign.status === 'approved') {
    const { data: flipped, error: flipError } = await admin
      .from('marketing_campaigns')
      .update({ status: 'approved', approved_at: campaign.approved_at ?? new Date().toISOString() })
      .eq('id', campaign.id)
      .eq('status', 'pending_approval')
      .select('id');
    if (flipError || !flipped || flipped.length === 0) {
      // Not a failure of the plan: the campaign is complete, it just waits in Approvals for a human.
      console.error('marketing campaign: could not mark it approved — left in Approvals', campaign.id, flipError?.message ?? 'no row moved');
    } else {
      status = 'approved';
    }
  }
  return { ok: true, treated: treatedLanded, holdout: holdoutLanded, status };
}

// ---------------------------------------------------------------------------
// Manual campaigns
// ---------------------------------------------------------------------------

/** Contacts a manual campaign would message: they match the owner's filter AND pass every plan-time eligibility rule. */
export function eligibleForManual(snapshot: AudienceSnapshot, filter: AudienceFilter): ContactStats[] {
  const ctx = { now: snapshot.now, settings: snapshot.settings, receipts_connected: snapshot.receipts_connected };
  const out: ContactStats[] = [];
  for (const { stats, history } of snapshot.contacts) {
    if (!matchesAudience(stats, filter)) continue;
    if (!evaluateContact(stats, history, ctx).eligible) continue;
    out.push(stats);
  }
  return out.sort((a, b) => a.phone.localeCompare(b.phone));
}

export type ManualInput = ManualCampaignInput & { send_after?: string | null };

async function priceManual(admin: Admin, snapshot: AudienceSnapshot, input: ManualInput, now: Date) {
  const eligible = eligibleForManual(snapshot, input.audience);
  const budget = await remainingBudget(admin, snapshot.settings, now);
  const priced = priceCampaign({
    snapshot,
    eligible,
    offer: input.offer,
    template_name: input.template.name,
    prior_conversion_pct: MANUAL_PRIOR_PCT,
    observed_treated: 0,
    observed_conversions: 0,
    budget_remaining_inr: budget,
  });
  return { eligible, priced };
}

/** POST /campaigns/preview — the wizard's live projection. Nothing is saved. */
export async function previewManual(input: ManualInput, now: Date = new Date()): Promise<CampaignPreview> {
  const admin = marketingAdmin();
  const snapshot = await buildContacts(now, admin);
  const { eligible, priced } = await priceManual(admin, snapshot, input, now);
  const rows = eligible.slice(0, 3).map((s) => ({ first_name: s.first_name, vars: recipientVars(s, priced.offer, input.headline) }));
  return {
    eligible: eligible.length,
    projection: priced.projection,
    guardrail_flags: priced.guardrail_flags,
    samples: renderSamples(input.template, priced.offer, rows, now, null),
  };
}

export type CampaignActionResult<T> =
  | { ok: true; campaign: T }
  | { ok: false; code: 'not_found' | 'invalid_state' | 'invalid' | 'error'; message: string; status?: CampaignStatus };

/**
 * POST /campaigns — saves a manual campaign as a DRAFT with its frozen projection.
 * Recipients are created now (status 'pending') and only become 'queued' when the
 * owner approves; nothing can send from a draft.
 */
export async function createManualDraft(
  input: ManualInput,
  userId: string | null,
  now: Date = new Date(),
): Promise<CampaignActionResult<CampaignDetail>> {
  const admin = marketingAdmin();
  const snapshot = await buildContacts(now, admin);
  const { eligible, priced } = await priceManual(admin, snapshot, input, now);
  if (eligible.length === 0) {
    return { ok: false, code: 'invalid', message: 'No opted-in customers match this audience right now, so there is nobody to message.' };
  }

  const id = randomUUID();
  const audience: CampaignAudienceJson = { filter: input.audience, ...(input.headline ? { headline: input.headline } : {}) };
  const result = await insertCampaign(
    admin,
    {
      id,
      kind: 'manual',
      playbook_key: null,
      name: input.name,
      status: 'draft',
      planned_for: istDate(now),
      send_after: input.send_after ?? null,
      audience,
      offer: priced.offer,
      template: input.template,
      projection: priced.projection,
      guardrail_flags: priced.guardrail_flags,
      priority: MANUAL_PRIORITY,
      created_by: userId,
    },
    eligible.map((stats) => ({ stats, vars: recipientVars(stats, priced.offer, input.headline) })),
    'pending',
    snapshot.settings.holdout_pct,
  );
  if (!result.ok) return { ok: false, code: 'error', message: result.duplicate ? 'A campaign with this id already exists.' : result.error };

  const detail = await getCampaignDetail(id, 1, now);
  if (!detail) return { ok: false, code: 'error', message: 'The campaign was created but could not be read back.' };
  return { ok: true, campaign: detail };
}

// ---------------------------------------------------------------------------
// Approve / cancel / expire
// ---------------------------------------------------------------------------

/**
 * Approve: only a draft or pending_approval campaign. The status change is a guarded
 * UPDATE (…where status in ('draft','pending_approval')), so two taps of the button, or
 * an approve racing a cancel, cannot both win. Then its pending recipients become
 * queued — the sender picks them up on its next tick, still re-checking consent, caps
 * and the send window for every single message.
 */
export async function approveCampaign(id: string, userId: string, now: Date = new Date()): Promise<CampaignActionResult<CampaignDetail>> {
  const admin = marketingAdmin();
  const current = await loadCampaign(admin, id);
  if (!current) return { ok: false, code: 'not_found', message: 'Campaign not found.' };

  const { data: moved, error } = await admin
    .from('marketing_campaigns')
    .update({ status: 'approved', approved_by: userId, approved_at: now.toISOString() })
    .eq('id', id)
    .in('status', ['draft', 'pending_approval'])
    .select('id');
  assertOk('marketing_campaigns write', error);
  if (!moved || moved.length === 0) {
    const fresh = await loadCampaign(admin, id);
    return {
      ok: false,
      code: 'invalid_state',
      message: `This campaign is already ${fresh?.status ?? current.status}, so it can't be approved.`,
      status: fresh?.status ?? current.status,
    };
  }

  const { error: queueError } = await admin
    .from('marketing_recipients')
    .update({ status: 'queued' })
    .eq('campaign_id', id)
    .eq('status', 'pending');
  if (queueError) {
    // Put the campaign back so the owner can retry, rather than leave it approved with nothing queued.
    await admin
      .from('marketing_campaigns')
      .update({ status: current.status, approved_by: null, approved_at: null })
      .eq('id', id)
      .eq('status', 'approved');
    assertOk('marketing_recipients write', queueError);
  }

  const detail = await getCampaignDetail(id, 1, now);
  return detail ? { ok: true, campaign: detail } : { ok: false, code: 'error', message: 'Approved, but the campaign could not be read back.' };
}

/**
 * Cancel: any non-terminal campaign. Its pending and queued recipients become
 * cancelled; a message already handed to the sender ('sending') is past recall, and
 * one already sent stays sent. The sender re-reads the campaign's status before every
 * message, so a cancel takes effect within the batch.
 */
export async function cancelCampaign(id: string, now: Date = new Date()): Promise<CampaignActionResult<CampaignDetail>> {
  const admin = marketingAdmin();
  const current = await loadCampaign(admin, id);
  if (!current) return { ok: false, code: 'not_found', message: 'Campaign not found.' };

  const { data: moved, error } = await admin
    .from('marketing_campaigns')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .in('status', ['draft', 'pending_approval', 'approved', 'sending'])
    .select('id');
  assertOk('marketing_campaigns write', error);
  if (!moved || moved.length === 0) {
    const fresh = await loadCampaign(admin, id);
    return {
      ok: false,
      code: 'invalid_state',
      message: `This campaign is already ${fresh?.status ?? current.status}.`,
      status: fresh?.status ?? current.status,
    };
  }

  const { error: recipientsError } = await admin
    .from('marketing_recipients')
    .update({ status: 'cancelled' })
    .eq('campaign_id', id)
    .in('status', ['pending', 'queued']);
  assertOk('marketing_recipients write', recipientsError);

  const detail = await getCampaignDetail(id, 1, now);
  return detail ? { ok: true, campaign: detail } : { ok: false, code: 'error', message: 'Cancelled, but the campaign could not be read back.' };
}

/**
 * Campaigns still awaiting approval after APPROVAL_EXPIRY_DAYS are expired, and their
 * unsent recipients cancelled: a two-day-old "send it" decision is a decision about a
 * customer list that has since changed. A forgotten manual DRAFT goes the same way after
 * DRAFT_EXPIRY_DAYS (it is not a pending decision, so it gets longer): approved a month later
 * it would message an audience that has long since changed. Returns how many campaigns were expired.
 */
export async function expireStale(now: Date = new Date(), admin: Admin = marketingAdmin()): Promise<number> {
  const ids: string[] = [];
  for (const [status, days] of [
    ['pending_approval', APPROVAL_EXPIRY_DAYS],
    ['draft', DRAFT_EXPIRY_DAYS],
  ] as const) {
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    const { data, error } = await admin
      .from('marketing_campaigns')
      .update({ status: 'expired' })
      .eq('status', status)
      .lt('created_at', cutoff)
      .select('id');
    assertOk('marketing_campaigns write', error);
    ids.push(...((data ?? []) as { id: string }[]).map((r) => r.id));
  }
  for (const part of chunk(ids, IN_CHUNK)) {
    const { error: recipientsError } = await admin
      .from('marketing_recipients')
      .update({ status: 'cancelled' })
      .in('campaign_id', part)
      .in('status', ['pending', 'queued']);
    assertOk('marketing_recipients write', recipientsError);
  }
  return ids.length;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** What one campaign's recipients add up to. */
export interface RecipientAggregate {
  sent: number;
  delivered: number;
  read: number;
  clicked: number;
  failed: number;
  skipped: number;
  returned: number;
  revenue_inr: number;
  spend_inr: number;
  /** Treated recipients still pending / queued / sending. */
  in_flight: number;
  /** Treated recipients that were sent / delivered / read AND converted (the lift numerator). */
  treated_converted: number;
  holdout_n: number;
  holdout_converted: number;
  /** Latest sent_at among treated recipients, ms; null before the first send. */
  last_sent_ms: number | null;
}

type AggRow = Pick<
  RecipientDbRow,
  'arm' | 'status' | 'clicked_at' | 'converted_at' | 'conversion_revenue_inr' | 'cost_inr' | 'sent_at'
>;

export function emptyAggregate(): RecipientAggregate {
  return {
    sent: 0,
    delivered: 0,
    read: 0,
    clicked: 0,
    failed: 0,
    skipped: 0,
    returned: 0,
    revenue_inr: 0,
    spend_inr: 0,
    in_flight: 0,
    treated_converted: 0,
    holdout_n: 0,
    holdout_converted: 0,
    last_sent_ms: null,
  };
}

/**
 * Folds recipient rows into the totals the dashboard shows. Counts are CUMULATIVE along
 * the forward-only path (sent ⊇ delivered ⊇ read); holdout recipients never count as
 * sent, returned or spent — they are only the control group.
 */
export function aggregateRecipients(rows: readonly AggRow[]): RecipientAggregate {
  const a = emptyAggregate();
  for (const r of rows) {
    if (r.arm === 'holdout') {
      if (r.status === 'holdout') {
        a.holdout_n += 1;
        if (r.converted_at) a.holdout_converted += 1;
      }
      continue;
    }
    const isSent = r.status === 'sent' || r.status === 'delivered' || r.status === 'read';
    if (isSent) {
      a.sent += 1;
      if (r.sent_at) {
        const ms = Date.parse(r.sent_at);
        if (Number.isFinite(ms) && (a.last_sent_ms === null || ms > a.last_sent_ms)) a.last_sent_ms = ms;
      }
      if (r.converted_at) a.treated_converted += 1;
    }
    if (r.status === 'delivered' || r.status === 'read') a.delivered += 1;
    if (r.status === 'read') a.read += 1;
    if (r.clicked_at) a.clicked += 1;
    if (r.status === 'failed') a.failed += 1;
    if (r.status === 'skipped') a.skipped += 1;
    if (r.status === 'pending' || r.status === 'queued' || r.status === 'sending') a.in_flight += 1;
    if (r.converted_at) {
      a.returned += 1;
      a.revenue_inr += Number(r.conversion_revenue_inr) || 0;
    }
    a.spend_inr += Number(r.cost_inr) || 0;
  }
  return a;
}

/** Recipient aggregates for a set of campaigns (one paged read per ~100 campaigns). */
export async function loadAggregates(admin: Admin, campaignIds: readonly string[]): Promise<Map<string, RecipientAggregate>> {
  const out = new Map<string, RecipientAggregate>();
  const byCampaign = new Map<string, AggRow[]>();
  for (const part of chunk([...new Set(campaignIds)], IN_CHUNK)) {
    const rows = await pageAll<AggRow & { campaign_id: string }>('marketing_recipients read', (from, to) =>
      admin
        .from('marketing_recipients')
        .select('campaign_id, arm, status, clicked_at, converted_at, conversion_revenue_inr, cost_inr, sent_at')
        .in('campaign_id', part)
        .order('campaign_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const r of rows) {
      const list = byCampaign.get(r.campaign_id);
      if (list) list.push(r);
      else byCampaign.set(r.campaign_id, [r]);
    }
  }
  for (const id of campaignIds) out.set(id, aggregateRecipients(byCampaign.get(id) ?? []));
  return out;
}

const zeroProjection: Projection = project({
  eligible: 0,
  holdout_pct: 0,
  message_cost_inr: 0,
  deliverability: 0,
  conversion_rate: 0,
  basket_inr: 0,
  food_cost_ratio: 0,
  offer: { type: 'none' },
});

/** The stored projection over a zeroed one, so a row that predates the column still satisfies the contract. */
export function projectionOf(row: CampaignRow): Projection {
  return { ...zeroProjection, ...row.projection };
}

export function totalsOf(a: RecipientAggregate): CampaignTotals {
  return {
    sent: a.sent,
    delivered: a.delivered,
    read: a.read,
    clicked: a.clicked,
    failed: a.failed,
    skipped: a.skipped,
    returned: a.returned,
    revenue_inr: a.revenue_inr,
    spend_inr: Math.round(a.spend_inr * 1000) / 1000,
  };
}

/** The first three treated recipients of an unsent campaign, rendered. Empty for a campaign that is already running. */
async function loadSamples(admin: Admin, row: CampaignRow, now: Date): Promise<RecipientPreview[]> {
  if (row.status !== 'draft' && row.status !== 'pending_approval') return [];
  const { data, error } = await admin
    .from('marketing_recipients')
    .select('first_name, vars')
    .eq('campaign_id', row.id)
    .eq('arm', 'treatment')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(3);
  assertOk('marketing_recipients read', error);
  const rows = ((data ?? []) as { first_name: string; vars: TemplateValues }[]).map((r) => ({
    first_name: r.first_name,
    vars: (r.vars ?? {}) as TemplateValues,
  }));
  return renderSamples(row.template, row.offer, rows, now, row.playbook_key);
}

function liftOf(a: RecipientAggregate) {
  return computeLift({
    treated_delivered: a.sent,
    treated_converted: a.treated_converted,
    holdout_n: a.holdout_n,
    holdout_converted: a.holdout_converted,
  });
}

export function toSummary(row: CampaignRow, a: RecipientAggregate, samples: RecipientPreview[]): CampaignSummary {
  const lift = liftOf(a);
  return {
    id: row.id,
    kind: row.kind,
    playbook_key: row.playbook_key,
    name: row.name,
    status: row.status,
    planned_for: row.planned_for,
    send_after: row.send_after,
    created_at: row.created_at,
    approved_at: row.approved_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    treated_count: row.treated_count,
    holdout_count: row.holdout_count,
    offer_text: offerText(row.offer),
    offer: row.offer,
    template_name: row.template.name,
    guardrail_flags: row.guardrail_flags,
    projection: projectionOf(row),
    samples,
    totals: totalsOf(a),
    // Lift is only meaningful once messages have actually gone out.
    lift_pp: row.started_at ? lift.lift_pp : null,
  };
}

/** CampaignSummary for each row, in the same order. */
export async function summarizeCampaigns(admin: Admin, rows: readonly CampaignRow[], now: Date): Promise<CampaignSummary[]> {
  const aggregates = await loadAggregates(admin, rows.map((r) => r.id));
  const out: CampaignSummary[] = [];
  for (const row of rows) {
    const samples = await loadSamples(admin, row, now);
    out.push(toSummary(row, aggregates.get(row.id) ?? emptyAggregate(), samples));
  }
  return out;
}

/** GET /campaigns?status= */
export async function listCampaigns(filter: CampaignListFilter, now: Date = new Date()): Promise<CampaignSummary[]> {
  const admin = marketingAdmin();
  const statuses = CAMPAIGN_LIST_STATUSES[filter];
  const { data, error } = await admin
    .from('marketing_campaigns')
    .select('*')
    .in('status', [...statuses])
    .order('created_at', { ascending: false })
    .limit(filter === 'history' ? 50 : PAGE_ROWS);
  assertOk('marketing_campaigns read', error);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(toCampaignRow);
  return summarizeCampaigns(admin, rows, now);
}

/** The latest campaigns of any status, newest first. */
export async function recentCampaigns(admin: Admin, limit: number, now: Date, playbookKey?: PlaybookKey): Promise<CampaignSummary[]> {
  let query = admin.from('marketing_campaigns').select('*');
  if (playbookKey) query = query.eq('playbook_key', playbookKey);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
  assertOk('marketing_campaigns read', error);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(toCampaignRow);
  return summarizeCampaigns(admin, rows, now);
}

const toRecipientView = (r: RecipientDbRow): RecipientRow => ({
  id: r.id,
  phone: r.phone,
  first_name: r.first_name,
  arm: r.arm,
  status: r.status,
  skip_reason: r.skip_reason,
  coupon_code: r.coupon_code,
  error: r.error,
  error_code: r.error_code,
  cost_inr: r.cost_inr,
  sent_at: r.sent_at,
  delivered_at: r.delivered_at,
  read_at: r.read_at,
  clicked_at: r.clicked_at,
  converted_at: r.converted_at,
  conversion_revenue_inr: r.conversion_revenue_inr,
  attributed_via: r.attributed_via,
});

/**
 * GET /campaigns/[id]?page= — the summary, the recipients page (50 rows) and the
 * measured results. null when the campaign does not exist. `attribution_days` is read
 * from the settings to say when returns stop being counted.
 */
export async function getCampaignDetail(id: string, page = 1, now: Date = new Date()): Promise<CampaignDetail | null> {
  const admin = marketingAdmin();
  const row = await loadCampaign(admin, id);
  if (!row) return null;

  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  const from = (safePage - 1) * RECIPIENT_PAGE_SIZE;
  const { data, error, count } = await admin
    .from('marketing_recipients')
    .select('*', { count: 'exact' })
    .eq('campaign_id', id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + RECIPIENT_PAGE_SIZE - 1);
  assertOk('marketing_recipients read', error);

  const [aggregates, settingsRow] = await Promise.all([
    loadAggregates(admin, [id]),
    admin.from('marketing_settings').select('attribution_days').eq('is_singleton', true).maybeSingle(),
  ]);
  const agg = aggregates.get(id) ?? emptyAggregate();
  const attributionDays = Number((settingsRow.data as { attribution_days?: number } | null)?.attribution_days) || 7;
  const samples = await loadSamples(admin, row, now);
  const summary = toSummary(row, agg, samples);
  const lift = liftOf(agg);

  // A campaign that sends over several days closes its window after the LAST message went out.
  const lastActivityMs = agg.last_sent_ms ?? (row.started_at ? Date.parse(row.started_at) : null);
  const closesMs = lastActivityMs !== null ? lastActivityMs + attributionDays * DAY_MS : null;
  const results: CampaignResults = {
    treated_delivered: agg.sent,
    treated_converted: agg.treated_converted,
    holdout_n: agg.holdout_n,
    holdout_converted: agg.holdout_converted,
    treated_rate: lift.treated_rate,
    holdout_rate: lift.holdout_rate,
    lift_pp: lift.lift_pp,
    incremental_orders: lift.incremental_orders,
    holdout_big_enough: lift.holdout_big_enough,
    window_closes_at: closesMs !== null ? new Date(closesMs).toISOString() : null,
    attribution_open: closesMs !== null ? now.getTime() < closesMs || agg.in_flight > 0 : false,
  };

  return {
    ...summary,
    lift_pp: row.started_at ? lift.lift_pp : null,
    template: row.template,
    audience: row.audience,
    recipients: ((data ?? []) as Record<string, unknown>[]).map((r) => toRecipientView(toRecipientRow(r))),
    page: safePage,
    recipients_total: count ?? 0,
    results,
  };
}

/** True for a status nothing more will happen to. */
export function isTerminalStatus(status: CampaignStatus): boolean {
  return (TERMINAL_CAMPAIGN_STATUSES as readonly string[]).includes(status);
}
