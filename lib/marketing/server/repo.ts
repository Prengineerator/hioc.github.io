// Marketing agent — data access (docs/MARKETING-AGENT-SPEC.md §4). Every read and
// write of a marketing table that more than one server module needs lives here;
// the engine modules (audience, planner, sender, attribution, overview) never
// build a PostgREST query for shared data themselves, so a column or a paging
// rule changes in ONE place.
//
// Three rules run through this file:
//
//  1. DEGRADE, DON'T CRASH. Every helper turns "the migration isn't applied" —
//     Postgres 42P01 / 42703 / 42883, PostgREST PGRST205 / PGRST204 / PGRST202 —
//     into ONE typed error, MigrationMissingError, via isMigrationMissing(). The
//     owner routes answer 409 {error:'migration_missing'} for it, the crons return
//     {enabled:false, migration_missing:true}, and the webhook falls through to its
//     old behaviour. Nothing else in the engine inspects Postgres error codes.
//
//  2. PAGE EVERYTHING. PostgREST silently caps a response at max_rows (1000), so a
//     bare .select() over consent, ledger, profiles or recipients returns a
//     TRUNCATED list that looks complete — and a truncated consent list would treat
//     an opted-out customer as "unknown". Every list read goes through pageAll(),
//     and any failure aborts the whole run rather than continuing on partial data.
//
//  3. NO MONEY OR CONSENT DECISIONS HERE. This file loads and normalises; it does
//     not decide who is eligible or what a campaign costs (that is lib/marketing/*).

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { fetchValidOrdersSince } from '@/lib/analytics/queries';
import { isMissingColumnError, type PostgrestLikeError } from '@/lib/api/postgrest';
import { normalizeIndianMobile } from '@/lib/phone';
import type { ExpiryRow } from '@/lib/loyalty/expiry';
import type { FoodCostLine, FreeItemVariantInput } from '@/lib/marketing/economics';
import {
  DEFAULT_SETTINGS,
  PLAYBOOK_KEYS,
  TEMPLATE_TOKENS,
  defaultPlaybook,
} from '@/lib/marketing/types';
import type {
  CampaignAudienceJson,
  CampaignKind,
  CampaignStatus,
  ConsentStatus,
  GuardrailFlag,
  MarketingSettings,
  Offer,
  PlaybookKey,
  PlaybookMode,
  PlaybookRow,
  Projection,
  RecipientArm,
  RecipientStatus,
  SendHistoryEntry,
  TemplateConfig,
  TemplateToken,
} from '@/lib/marketing/types';
import type { TemplateValues } from '@/lib/marketing/templates';

export type Admin = ReturnType<typeof createAdminSupabaseClient>;

/** The service-role client. Every marketing table is RLS-on with no policy: this is the only way in. */
export function marketingAdmin(): Admin {
  return createAdminSupabaseClient();
}

// ---------------------------------------------------------------------------
// Migration-missing detection
// ---------------------------------------------------------------------------

/** Postgres / PostgREST codes that mean "an object this deploy expects is not in the database yet". */
const MIGRATION_MISSING_CODES: ReadonlySet<string> = new Set([
  '42P01', // undefined_table
  'PGRST205', // PostgREST: table not in the schema cache
  '42703', // undefined_column (a read naming a column the migration adds)
  'PGRST204', // PostgREST: column not in the schema cache (the write-side twin of 42703)
  '42883', // undefined_function (claim_marketing_recipients)
  'PGRST202', // PostgREST: function not in the schema cache
]);

/**
 * True when the failure is "the marketing migration isn't applied" (a missing
 * table, column or function). The ONE place that knows the codes; callers ask this
 * instead of comparing `error.code` themselves. The message is a fallback for a
 * response that carried no code.
 */
export function isMigrationMissing(error: PostgrestLikeError | null | undefined): boolean {
  if (!error) return false;
  if (error.code && MIGRATION_MISSING_CODES.has(error.code)) return true;
  if (isMissingColumnError(error)) return true;
  return /relation .* does not exist|could not find the table|could not find the function|function .* does not exist/i.test(
    error.message ?? '',
  );
}

/** Thrown by every repo helper when the marketing migration is not applied. Routes turn it into 409. */
export class MigrationMissingError extends Error {
  readonly migration_missing = true as const;
  constructor(context: string) {
    super(`marketing migration not applied (${context})`);
    this.name = 'MigrationMissingError';
  }
}

export function isMigrationMissingError(err: unknown): err is MigrationMissingError {
  return err instanceof MigrationMissingError;
}

/**
 * Throws if a PostgREST call failed: MigrationMissingError when the migration is
 * absent, a plain Error (with the context named) for anything else. Returns
 * silently on success.
 */
export function assertOk(context: string, error: PostgrestLikeError | null | undefined): void {
  if (!error) return;
  if (isMigrationMissing(error)) throw new MigrationMissingError(context);
  throw new Error(`${context}: ${error.message ?? error.code ?? 'unknown error'}`);
}

/** Postgres unique_violation. */
export function isUniqueViolation(error: PostgrestLikeError | null | undefined): boolean {
  return error?.code === '23505';
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** PostgREST's default max_rows. A page of exactly this size means "there may be more". */
export const PAGE_ROWS = 1000;

type PageResult = { data: unknown[] | null; error: PostgrestLikeError | null };

/**
 * Reads every row of a query, page by page. `query(from, to)` must return the
 * builder with a TOTAL order and `.range(from, to)` applied, or pages can overlap
 * or skip. Aborts (throws) on any failure: continuing on a partial list is how a
 * consent check silently passes.
 */
export async function pageAll<T>(
  context: string,
  query: (from: number, to: number) => PromiseLike<PageResult>,
  opts: { max?: number } = {},
): Promise<T[]> {
  const max = opts.max ?? 1_000_000;
  const rows: T[] = [];
  for (let from = 0; from < max; from += PAGE_ROWS) {
    const { data, error } = await query(from, Math.min(from + PAGE_ROWS, max) - 1);
    assertOk(context, error);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_ROWS) break;
  }
  return rows;
}

/** Splits a list into chunks (PostgREST `.in()` lists ride in the URL, so keep them short). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Ids per `.in()` request: 100 uuids ≈ 3.7 KB of URL, comfortably under every proxy limit. */
export const IN_CHUNK = 100;

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

/**
 * Any phone → the E.164 form the ledger, recipients and opt-outs use. Indian
 * mobiles in any recognisable form become '+91XXXXXXXXXX'; another international
 * number passes through only if it already is '+<7-14 digits>'. null otherwise.
 */
export function toE164(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const indian = normalizeIndianMobile(trimmed);
  if (indian) return `+91${indian}`;
  const compact = trimmed.replace(/[\s\-().]/g, '');
  return /^\+[1-9][0-9]{7,14}$/.test(compact) ? compact : null;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface CampaignRow {
  id: string;
  kind: CampaignKind;
  playbook_key: PlaybookKey | null;
  name: string;
  status: CampaignStatus;
  planned_for: string;
  send_after: string | null;
  audience: CampaignAudienceJson;
  offer: Offer;
  template: TemplateConfig;
  /** The frozen Projection; `{}` on a row that predates it. */
  projection: Partial<Projection>;
  guardrail_flags: GuardrailFlag[];
  priority: number;
  treated_count: number;
  holdout_count: number;
  started_at: string | null;
  completed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecipientDbRow {
  id: string;
  campaign_id: string;
  phone: string;
  user_id: string | null;
  first_name: string;
  arm: RecipientArm;
  status: RecipientStatus;
  skip_reason: string;
  vars: TemplateValues;
  coupon_id: string | null;
  coupon_code: string;
  click_token: string | null;
  provider_ref: string;
  error: string;
  error_code: string;
  cost_inr: number;
  attempts: number;
  claimed_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  clicked_at: string | null;
  reference_at: string | null;
  converted_order_id: string | null;
  converted_at: string | null;
  conversion_revenue_inr: number;
  attributed_via: '' | 'coupon' | 'order';
  created_at: string;
}

export interface OrderRow {
  id: string;
  created_at: string;
  total_inr: number;
  status: string;
  user_id: string | null;
  customer_user_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
}

export interface ConsentRow {
  phone: string;
  user_id: string | null;
  status: ConsentStatus;
  source: string;
  consented_at: string | null;
  withdrawn_at: string | null;
  updated_at: string;
}

export interface ProfileLite {
  id: string;
  name: string | null;
  phone: string | null;
  role: string | null;
  phone_verified: boolean | null;
}

export interface MenuVariantRow {
  variant_id: string;
  item_id: string;
  item_name: string;
  category: string;
  variant_label: string;
  price_inr: number;
  is_available: boolean;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

function toSettings(raw: Record<string, unknown>): MarketingSettings {
  const d = DEFAULT_SETTINGS;
  return {
    enabled: raw.enabled === true,
    monthly_budget_inr: num(raw.monthly_budget_inr, d.monthly_budget_inr),
    // numeric(6,3) — supabase-js returns a JSON number, but a string is coerced just in case.
    message_cost_inr: num(raw.message_cost_inr, d.message_cost_inr),
    send_window_start_hour: num(raw.send_window_start_hour, d.send_window_start_hour),
    send_window_end_hour: num(raw.send_window_end_hour, d.send_window_end_hour),
    daily_send_cap: num(raw.daily_send_cap, d.daily_send_cap),
    min_days_between: num(raw.min_days_between, d.min_days_between),
    max_per_30_days: num(raw.max_per_30_days, d.max_per_30_days),
    holdout_pct: num(raw.holdout_pct, d.holdout_pct),
    attribution_days: num(raw.attribution_days, d.attribution_days),
    min_margin_pct: num(raw.min_margin_pct, d.min_margin_pct),
    default_food_cost_pct: num(raw.default_food_cost_pct, d.default_food_cost_pct),
    drop_alert_pct: num(raw.drop_alert_pct, d.drop_alert_pct),
    pause_after_unread: num(raw.pause_after_unread, d.pause_after_unread),
    whatsapp_business_number: typeof raw.whatsapp_business_number === 'string' ? raw.whatsapp_business_number : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  };
}

/** The settings singleton, or null when its row is absent. Throws MigrationMissingError when the table is. */
export async function loadSettings(admin: Admin = marketingAdmin()): Promise<MarketingSettings | null> {
  const { data, error } = await admin.from('marketing_settings').select('*').eq('is_singleton', true).maybeSingle();
  assertOk('marketing_settings read', error);
  return data ? toSettings(data as Record<string, unknown>) : null;
}

/** Saves the merged settings (upsert: a database whose seed insert was skipped still ends up with its one row). */
export async function saveSettings(
  admin: Admin,
  patch: Partial<Omit<MarketingSettings, 'updated_at'>>,
  userId: string | null,
): Promise<MarketingSettings> {
  const { data, error } = await admin
    .from('marketing_settings')
    .upsert({ is_singleton: true, ...patch, updated_by: userId }, { onConflict: 'is_singleton' })
    .select('*')
    .single();
  assertOk('marketing_settings write', error);
  return toSettings(data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

const TOKEN_SET: ReadonlySet<string> = new Set(TEMPLATE_TOKENS);
const OFFER_TYPES = new Set(['none', 'percent', 'flat', 'free_item']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stored template merged over the defaults, so a half-empty jsonb still yields a usable config. */
export function toTemplate(raw: unknown, fallback: TemplateConfig): TemplateConfig {
  if (!isObj(raw)) return { ...fallback, vars: [...fallback.vars] };
  const vars = Array.isArray(raw.vars) ? (raw.vars.filter((v) => typeof v === 'string' && TOKEN_SET.has(v)) as TemplateToken[]) : fallback.vars;
  return {
    name: typeof raw.name === 'string' ? raw.name : fallback.name,
    lang: typeof raw.lang === 'string' && raw.lang ? raw.lang : fallback.lang,
    vars: [...vars],
    url_button: typeof raw.url_button === 'boolean' ? raw.url_button : fallback.url_button,
    body_preview: typeof raw.body_preview === 'string' ? raw.body_preview : fallback.body_preview,
  };
}

/** A stored offer, or `fallback` when the jsonb is not a recognisable offer. */
export function toOffer(raw: unknown, fallback: Offer): Offer {
  if (!isObj(raw) || typeof raw.type !== 'string' || !OFFER_TYPES.has(raw.type)) return fallback;
  return raw as unknown as Offer;
}

function toPlaybookRow(raw: Record<string, unknown>): PlaybookRow | null {
  const key = raw.key as PlaybookKey;
  if (!(PLAYBOOK_KEYS as readonly string[]).includes(key)) return null;
  const d = defaultPlaybook(key);
  const mode = raw.mode === 'review' || raw.mode === 'auto' ? (raw.mode as PlaybookMode) : 'off';
  const row = {
    key,
    mode,
    priority: num(raw.priority, d.priority),
    // Defaults underneath, so a params object missing a newer key still has every field the rules read.
    params: { ...d.params, ...(isObj(raw.params) ? raw.params : {}) },
    offer: toOffer(raw.offer, d.offer),
    template: toTemplate(raw.template, d.template),
    prior_conversion_pct: num(raw.prior_conversion_pct, d.prior_conversion_pct),
    observed_treated: num(raw.observed_treated, 0),
    observed_conversions: num(raw.observed_conversions, 0),
    last_planned_at: typeof raw.last_planned_at === 'string' ? raw.last_planned_at : null,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  };
  return row as unknown as PlaybookRow;
}

/**
 * All five playbooks, highest priority first. A playbook whose row is missing
 * (never seeded) is returned as its defaults in mode 'off', so the dashboard and the
 * planner always see five.
 */
export async function loadPlaybooks(admin: Admin = marketingAdmin()): Promise<PlaybookRow[]> {
  const { data, error } = await admin.from('marketing_playbooks').select('*');
  assertOk('marketing_playbooks read', error);
  const byKey = new Map<PlaybookKey, PlaybookRow>();
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const row = toPlaybookRow(raw);
    if (row) byKey.set(row.key, row);
  }
  for (const key of PLAYBOOK_KEYS) {
    if (byKey.has(key)) continue;
    const d = defaultPlaybook(key);
    byKey.set(key, toPlaybookRow({ ...d, mode: 'off' })!);
  }
  return [...byKey.values()].sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

/** Writes one playbook (upsert: works even if its seed row was never inserted). */
export async function savePlaybook(admin: Admin, row: PlaybookRow, userId: string | null): Promise<PlaybookRow> {
  const { data, error } = await admin
    .from('marketing_playbooks')
    .upsert(
      {
        key: row.key,
        mode: row.mode,
        priority: row.priority,
        params: row.params,
        offer: row.offer,
        template: row.template,
        prior_conversion_pct: row.prior_conversion_pct,
        updated_by: userId,
      },
      { onConflict: 'key' },
    )
    .select('*')
    .single();
  assertOk('marketing_playbooks write', error);
  return toPlaybookRow(data as Record<string, unknown>) ?? row;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export function toCampaignRow(raw: Record<string, unknown>): CampaignRow {
  const key = raw.playbook_key as PlaybookKey | null;
  return {
    id: String(raw.id),
    kind: raw.kind === 'manual' ? 'manual' : 'playbook',
    playbook_key: key && (PLAYBOOK_KEYS as readonly string[]).includes(key) ? key : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    status: raw.status as CampaignStatus,
    planned_for: typeof raw.planned_for === 'string' ? raw.planned_for : '',
    send_after: typeof raw.send_after === 'string' ? raw.send_after : null,
    audience: (isObj(raw.audience) ? raw.audience : {}) as CampaignAudienceJson,
    offer: toOffer(raw.offer, { type: 'none' }),
    template: toTemplate(raw.template, { name: '', lang: 'en', vars: [], url_button: false, body_preview: '' }),
    projection: (isObj(raw.projection) ? raw.projection : {}) as Partial<Projection>,
    guardrail_flags: Array.isArray(raw.guardrail_flags) ? (raw.guardrail_flags as GuardrailFlag[]) : [],
    priority: num(raw.priority, 10),
    treated_count: num(raw.treated_count, 0),
    holdout_count: num(raw.holdout_count, 0),
    started_at: typeof raw.started_at === 'string' ? raw.started_at : null,
    completed_at: typeof raw.completed_at === 'string' ? raw.completed_at : null,
    approved_by: typeof raw.approved_by === 'string' ? raw.approved_by : null,
    approved_at: typeof raw.approved_at === 'string' ? raw.approved_at : null,
    created_by: typeof raw.created_by === 'string' ? raw.created_by : null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  };
}

export async function loadCampaign(admin: Admin, id: string): Promise<CampaignRow | null> {
  const { data, error } = await admin.from('marketing_campaigns').select('*').eq('id', id).maybeSingle();
  assertOk('marketing_campaigns read', error);
  return data ? toCampaignRow(data as Record<string, unknown>) : null;
}

export async function loadCampaignsByIds(admin: Admin, ids: readonly string[]): Promise<Map<string, CampaignRow>> {
  const out = new Map<string, CampaignRow>();
  for (const part of chunk([...new Set(ids)], IN_CHUNK)) {
    const { data, error } = await admin.from('marketing_campaigns').select('*').in('id', part);
    assertOk('marketing_campaigns read', error);
    for (const raw of (data ?? []) as Record<string, unknown>[]) {
      const row = toCampaignRow(raw);
      out.set(row.id, row);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export function toRecipientRow(raw: Record<string, unknown>): RecipientDbRow {
  return {
    id: String(raw.id),
    campaign_id: String(raw.campaign_id),
    phone: String(raw.phone),
    user_id: typeof raw.user_id === 'string' ? raw.user_id : null,
    first_name: typeof raw.first_name === 'string' ? raw.first_name : '',
    arm: raw.arm === 'holdout' ? 'holdout' : 'treatment',
    status: raw.status as RecipientStatus,
    skip_reason: typeof raw.skip_reason === 'string' ? raw.skip_reason : '',
    vars: (isObj(raw.vars) ? raw.vars : {}) as TemplateValues,
    coupon_id: typeof raw.coupon_id === 'string' ? raw.coupon_id : null,
    coupon_code: typeof raw.coupon_code === 'string' ? raw.coupon_code : '',
    click_token: typeof raw.click_token === 'string' ? raw.click_token : null,
    provider_ref: typeof raw.provider_ref === 'string' ? raw.provider_ref : '',
    error: typeof raw.error === 'string' ? raw.error : '',
    error_code: typeof raw.error_code === 'string' ? raw.error_code : '',
    cost_inr: num(raw.cost_inr, 0),
    attempts: num(raw.attempts, 0),
    claimed_at: typeof raw.claimed_at === 'string' ? raw.claimed_at : null,
    sent_at: typeof raw.sent_at === 'string' ? raw.sent_at : null,
    delivered_at: typeof raw.delivered_at === 'string' ? raw.delivered_at : null,
    read_at: typeof raw.read_at === 'string' ? raw.read_at : null,
    clicked_at: typeof raw.clicked_at === 'string' ? raw.clicked_at : null,
    reference_at: typeof raw.reference_at === 'string' ? raw.reference_at : null,
    converted_order_id: typeof raw.converted_order_id === 'string' ? raw.converted_order_id : null,
    converted_at: typeof raw.converted_at === 'string' ? raw.converted_at : null,
    conversion_revenue_inr: num(raw.conversion_revenue_inr, 0),
    attributed_via: raw.attributed_via === 'coupon' || raw.attributed_via === 'order' ? raw.attributed_via : '',
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
  };
}

/**
 * The marketing history of every phone, as SendHistoryEntry rows: everything
 * created in the last 365 days (win-back's "since the last order" reaches back as
 * far as the orders do) plus anything still in flight however old.
 *
 * A HOLDOUT row of a campaign that was cancelled or expired is dropped: that person
 * was never held out of anything — the campaign never ran — and counting it would
 * make the playbook treat them as "already handled" (a win-back stage is once per
 * lapse, so they would never be offered it).
 */
export async function loadSendHistory(
  admin: Admin,
  now: Date,
): Promise<{ byPhone: Map<string, SendHistoryEntry[]>; all: SendHistoryEntry[] }> {
  const since = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();

  const campaigns = await pageAll<{ id: string; playbook_key: string | null; status: string }>(
    'marketing_campaigns read',
    (from, to) =>
      admin
        .from('marketing_campaigns')
        .select('id, playbook_key, status')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
  );
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));

  const cols = 'id, campaign_id, phone, arm, status, created_at, sent_at, read_at, reference_at';
  type HistRow = {
    id: string;
    campaign_id: string;
    phone: string;
    arm: RecipientArm;
    status: RecipientStatus;
    created_at: string;
    sent_at: string | null;
    read_at: string | null;
    reference_at: string | null;
  };
  const recent = await pageAll<HistRow>('marketing_recipients read', (from, to) =>
    admin
      .from('marketing_recipients')
      .select(cols)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  const inFlight = await pageAll<HistRow>('marketing_recipients read', (from, to) =>
    admin
      .from('marketing_recipients')
      .select(cols)
      .in('status', ['pending', 'queued', 'sending'])
      .lt('created_at', since)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );

  const byPhone = new Map<string, SendHistoryEntry[]>();
  const all: SendHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const r of [...recent, ...inFlight]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const campaign = campaignById.get(r.campaign_id);
    if (r.status === 'holdout' && campaign && (campaign.status === 'cancelled' || campaign.status === 'expired')) continue;
    const entry: SendHistoryEntry = {
      campaign_id: r.campaign_id,
      playbook_key: (campaign?.playbook_key as PlaybookKey | null) ?? null,
      arm: r.arm,
      status: r.status,
      created_at: r.created_at,
      // `?? null`: receiptsConnected() tests `read_at !== null`, so an absent value must not read as "read".
      sent_at: r.sent_at ?? null,
      read_at: r.read_at ?? null,
      reference_at: r.reference_at ?? null,
    };
    all.push(entry);
    const list = byPhone.get(r.phone);
    if (list) list.push(entry);
    else byPhone.set(r.phone, [entry]);
  }
  return { byPhone, all };
}

/**
 * ONE phone's recent sends, for the send-time re-check (rules 4 and 5 only need
 * messages that actually left in the last 30 days). Excludes `exceptRecipientId`
 * — the row being sent — and always reads fresh, because a message sent a moment
 * ago in this same batch must count.
 */
export async function loadRecentSendsForPhone(
  admin: Admin,
  phone: string,
  now: Date,
  exceptRecipientId: string,
): Promise<SendHistoryEntry[]> {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('marketing_recipients')
    .select('id, campaign_id, arm, status, created_at, sent_at, read_at, reference_at')
    .eq('phone', phone)
    .in('status', ['sent', 'delivered', 'read'])
    .gte('sent_at', since);
  assertOk('marketing_recipients read', error);
  return ((data ?? []) as Record<string, unknown>[])
    .filter((r) => r.id !== exceptRecipientId)
    .map((r) => ({
      campaign_id: String(r.campaign_id),
      playbook_key: null,
      arm: (r.arm === 'holdout' ? 'holdout' : 'treatment') as RecipientArm,
      status: r.status as RecipientStatus,
      created_at: String(r.created_at),
      sent_at: (r.sent_at as string | null) ?? null,
      read_at: (r.read_at as string | null) ?? null,
      reference_at: (r.reference_at as string | null) ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Consent, opt-outs, profiles
// ---------------------------------------------------------------------------

export async function loadConsentRows(admin: Admin): Promise<ConsentRow[]> {
  return pageAll<ConsentRow>('marketing_consent read', (from, to) =>
    admin.from('marketing_consent').select('*').order('phone', { ascending: true }).range(from, to),
  );
}

/** Every phone in whatsapp_opt_outs (STOP, in any product), normalised to E.164 where it can be. */
export async function loadOptOutPhones(admin: Admin): Promise<Set<string>> {
  const rows = await pageAll<{ phone: string }>('whatsapp_opt_outs read', (from, to) =>
    admin.from('whatsapp_opt_outs').select('phone').order('phone', { ascending: true }).range(from, to),
  );
  const out = new Set<string>();
  for (const r of rows) {
    out.add(r.phone);
    const norm = toE164(r.phone);
    if (norm) out.add(norm);
  }
  return out;
}

/** Verified-phone profiles (role included, so staff phones can be excluded). */
export async function loadVerifiedProfiles(admin: Admin): Promise<ProfileLite[]> {
  return pageAll<ProfileLite>('profiles read', (from, to) =>
    admin
      .from('profiles')
      .select('id, name, phone, role, phone_verified')
      .eq('phone_verified', true)
      .order('id', { ascending: true })
      .range(from, to),
  );
}

// ---------------------------------------------------------------------------
// Orders, ledger, menu, costs
// ---------------------------------------------------------------------------

const ORDER_COLUMNS = 'id, created_at, total_inr, status, user_id, customer_user_id, customer_name, customer_phone';

/**
 * Valid (not cancelled/rejected) orders since `sinceIso`, paged past the 1000-row
 * cap by the analytics loader this reuses. An orders read that fails aborts the
 * caller: planning on an empty order list would call every customer "no orders".
 */
export async function loadValidOrders(sinceIso: string, max = 100_000): Promise<OrderRow[]> {
  const rows = await fetchValidOrdersSince<OrderRow>(ORDER_COLUMNS, sinceIso, max);
  if (!rows) throw new Error('orders read failed');
  return rows.map((r) => ({ ...r, total_inr: num(r.total_inr, 0) }));
}

/** The whole points ledger grouped by user — the same paged read expireLoyaltyPoints uses. */
export async function loadLedger(admin: Admin): Promise<Map<string, ExpiryRow[]>> {
  const rows = await pageAll<{ user_id: string; points: number; created_at: string }>(
    'loyalty_transactions read',
    (from, to) =>
      admin
        .from('loyalty_transactions')
        .select('user_id, points, created_at')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
  );
  const byUser = new Map<string, ExpiryRow[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id);
    const row = { points: num(r.points, 0), created_at: r.created_at };
    if (list) list.push(row);
    else byUser.set(r.user_id, [row]);
  }
  return byUser;
}

/** variant_id → entered cost (COGS), ₹. */
export async function loadCostMap(admin: Admin): Promise<Map<string, number>> {
  const rows = await pageAll<{ variant_id: string; cost_inr: number | string }>('menu_item_costs read', (from, to) =>
    admin.from('menu_item_costs').select('variant_id, cost_inr').order('variant_id', { ascending: true }).range(from, to),
  );
  return new Map(rows.map((r) => [r.variant_id, num(r.cost_inr, 0)]));
}

/** Every variant of every item, joined — prices live on the variant, availability on the item. */
export async function loadMenuVariants(admin: Admin): Promise<MenuVariantRow[]> {
  const items = await pageAll<{ id: string; name: string; category: string; is_available: boolean; sort_order: number }>(
    'menu_items read',
    (from, to) =>
      admin
        .from('menu_items')
        .select('id, name, category, is_available, sort_order')
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
  );
  const variants = await pageAll<{ id: string; menu_item_id: string; label: string; price_inr: number; sort_order: number }>(
    'menu_item_variants read',
    (from, to) =>
      admin
        .from('menu_item_variants')
        .select('id, menu_item_id, label, price_inr, sort_order')
        .order('menu_item_id', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
  );
  const out: MenuVariantRow[] = [];
  // Item order first (category, sort_order), then each item's own variant order.
  const byItem = new Map<string, typeof variants>();
  for (const v of variants) {
    const list = byItem.get(v.menu_item_id);
    if (list) list.push(v);
    else byItem.set(v.menu_item_id, [v]);
  }
  for (const item of items) {
    for (const v of byItem.get(item.id) ?? []) {
      out.push({
        variant_id: v.id,
        item_id: item.id,
        item_name: item.name,
        category: item.category,
        variant_label: v.label,
        price_inr: num(v.price_inr, 0),
        is_available: item.is_available !== false,
      });
    }
  }
  return out;
}

/** MenuVariantRow + entered cost → what rankFreeItems / resolveFreeItemOffer take. */
export function toFreeItemInputs(menu: readonly MenuVariantRow[], costs: ReadonlyMap<string, number>): FreeItemVariantInput[] {
  return menu.map((v) => ({
    item_id: v.item_id,
    item_name: v.item_name,
    variant_id: v.variant_id,
    variant_label: v.variant_label,
    price_inr: v.price_inr,
    cost_inr: costs.has(v.variant_id) ? (costs.get(v.variant_id) as number) : null,
    is_available: v.is_available,
  }));
}

/**
 * Non-voided order lines of valid orders since `sinceIso` — the input to the
 * blended food-cost ratio. Joined to orders (`!inner`) so the date and status
 * filters apply to the ORDER, and paged. `voided` exists only after the phase-3
 * migration, so a database without it retries without the column (nothing there
 * can be voided).
 */
export async function loadFoodCostLines(admin: Admin, sinceIso: string): Promise<FoodCostLine[]> {
  type LineRow = {
    variant_id: string | null;
    quantity: number;
    line_total_inr: number;
    voided?: boolean | null;
  };
  const read = (cols: string) =>
    pageAll<LineRow>('order_items read', (from, to) =>
      admin
        .from('order_items')
        .select(cols)
        .gte('orders.created_at', sinceIso)
        .not('orders.status', 'in', '("rejected","cancelled")')
        .order('id', { ascending: true })
        .range(from, to),
    );
  const withVoided = 'variant_id, quantity, line_total_inr, voided, orders!inner(status, created_at)';
  const withoutVoided = 'variant_id, quantity, line_total_inr, orders!inner(status, created_at)';
  let rows: LineRow[];
  try {
    rows = await read(withVoided);
  } catch (err) {
    // A missing `voided` column surfaces as a migration-missing error from assertOk. The marketing
    // tables are already known to exist by the time a caller reads order lines, so it is this column.
    if (!isMigrationMissingError(err)) throw err;
    rows = await read(withoutVoided);
  }
  return rows.map((r) => ({
    variant_id: r.variant_id ?? null,
    quantity: num(r.quantity, 0),
    line_total_inr: num(r.line_total_inr, 0),
    voided: r.voided === true,
  }));
}

// ---------------------------------------------------------------------------
// Money windows
// ---------------------------------------------------------------------------

/** Σ cost_inr of recipients sent at or after `sinceIso` — the month's WhatsApp spend. */
export async function sumSpendSince(admin: Admin, sinceIso: string): Promise<number> {
  const rows = await pageAll<{ cost_inr: number | string }>('marketing_recipients read', (from, to) =>
    admin
      .from('marketing_recipients')
      .select('cost_inr')
      .gte('sent_at', sinceIso)
      .order('sent_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  return rows.reduce((sum, r) => sum + num(r.cost_inr, 0), 0);
}

/** Messages that left at or after `sinceIso` (sent / delivered / read). */
export async function countSentSince(admin: Admin, sinceIso: string): Promise<number> {
  const { count, error } = await admin
    .from('marketing_recipients')
    .select('id', { count: 'exact', head: true })
    .in('status', ['sent', 'delivered', 'read'])
    .gte('sent_at', sinceIso);
  assertOk('marketing_recipients count', error);
  return count ?? 0;
}

/** Recipients still waiting to go out (queued / sending) — spend already promised to the budget. */
export async function countCommittedSends(admin: Admin): Promise<number> {
  const { count, error } = await admin
    .from('marketing_recipients')
    .select('id', { count: 'exact', head: true })
    .in('status', ['queued', 'sending']);
  assertOk('marketing_recipients count', error);
  return count ?? 0;
}

