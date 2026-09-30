// Marketing agent — shared types, constants and defaults (docs/MARKETING-AGENT-SPEC.md).
//
// CLIENT-SAFE: no 'server-only', no supabase. This file is the contract between
// the engine/APIs (lib/marketing/server, app/api/owner/marketing) and the
// dashboard (app/owner/marketing, components/owner/marketing). Change a field
// here and both sides move together.
//
// Units — load-bearing, read before adding a field:
//   *_inr    rupees. An INTEGER wherever the value can become a coupon or an order
//            amount (budgets, caps, coupon fields, basket, min order); a plain
//            number that may carry decimals for projections and per-message costs
//            (message_cost_inr = 1.02, expected_profit_inr = 3237.84). Round only
//            for display — never store a rounded projection.
//   *_pct    a percentage on a 0–100 scale (holdout_pct = 10, margin_after_pct = 55).
//   *_pp     percentage POINTS on a 0–100 scale (lift_pp = 4.2 means +4.2 points).
//   *_rate   a ratio on a 0–1 scale (conversion_rate = 0.12, break_even_rate = 0.0064).
//   roi      a plain ratio (4.02 = every ₹1 spent returns ₹4.02 of profit).
//   *_at     an ISO-8601 UTC timestamp string, as PostgREST returns it.
//   *_date   'YYYY-MM-DD' — an IST calendar date.
//
// "Nullable" is used deliberately: a null means "unknown / not applicable yet",
// never "zero". The comment on each nullable field says which.

// ---------------------------------------------------------------------------
// Small shared shapes
// ---------------------------------------------------------------------------

/** What every strict validator in parse.ts returns; `error` is a message the owner can act on. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Marketing consent status for a phone (marketing_consent.status). */
export type ConsentStatus = 'opted_in' | 'opted_out';

/** Where a consent change came from (marketing_consent[_events].source) — spec §2 table + the migration backfill. */
export const CONSENT_SOURCES = [
  'profile', // Account → Profile toggle, order-confirmation card
  'whatsapp_keyword', // START / SUBSCRIBE / OFFERS / UNSTOP sent to the business number
  'stop_keyword', // STOP / UNSUBSCRIBE keyword
  'stop_promotions', // Meta's "Stop promotions" marketing opt-out button
  'meta_131050', // status webhook error 131050 (user stopped promotions)
  'meta_stop', // user_preferences webhook: stop
  'meta_resume', // user_preferences webhook: resume (only counts after an earlier opt_in)
  'owner', // the owner recorded an opt-out the customer asked for in person
  'backfill_profile', // migration: verified profile with marketing_consent = true
  'backfill_opt_out', // migration: phone already in whatsapp_opt_outs
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

// ---------------------------------------------------------------------------
// Settings (marketing_settings — singleton, owner-only)
// ---------------------------------------------------------------------------

export interface MarketingSettings {
  /** Master kill switch. false (the default) = nothing is ever sent. */
  enabled: boolean;
  /** Monthly WhatsApp spend cap, integer ₹. The month is an IST calendar month. */
  monthly_budget_inr: number;
  /** Cost of one marketing message, ₹ incl. GST; may carry up to 3 decimals (default 1.02). */
  message_cost_inr: number;
  /** IST hour (0–23) the send window opens, inclusive. */
  send_window_start_hour: number;
  /** IST hour (1–24) the send window closes, exclusive; 24 = midnight. Always > start. */
  send_window_end_hour: number;
  /** Max marketing messages per IST day across all campaigns. */
  daily_send_cap: number;
  /** A phone gets at most one marketing message in this many days (rule too_soon). */
  min_days_between: number;
  /** ...and at most this many in any 30 days (rule monthly_cap). */
  max_per_30_days: number;
  /** Share of each campaign held out to measure lift, 0–50 (a percentage). */
  holdout_pct: number;
  /** Days after a send (or campaign start, for holdout) during which a return is attributed. */
  attribution_days: number;
  /** Guardrail: flag a campaign when profit per returning order is below this % of the basket. */
  min_margin_pct: number;
  /** Food-cost % assumed for a line with no entered product cost. */
  default_food_cost_pct: number;
  /** Customer-drop alert threshold: last week vs the prior 4-week mean, %. */
  drop_alert_pct: number;
  /** Pause a phone after this many unread marketing messages in a row; 0 = never pause. */
  pause_after_unread: number;
  /** The business WhatsApp number, E.164 ('+91…'), for the wa.me opt-in link. '' = not set. */
  whatsapp_business_number: string;
  /** null only on the in-code defaults (no row read yet). */
  updated_at: string | null;
}

/** A PATCH body: any subset of the editable settings. `updated_at` is server-owned. */
export type MarketingSettingsPatch = Partial<Omit<MarketingSettings, 'updated_at'>>;

/** Integer settings and their inclusive bounds — IDENTICAL to the CHECKs in 2026-10-marketing-agent.sql. */
export const SETTINGS_BOUNDS = {
  monthly_budget_inr: { min: 0, max: 1_000_000 },
  send_window_start_hour: { min: 0, max: 23 },
  send_window_end_hour: { min: 1, max: 24 },
  daily_send_cap: { min: 0, max: 10_000 },
  min_days_between: { min: 1, max: 60 },
  max_per_30_days: { min: 1, max: 30 },
  holdout_pct: { min: 0, max: 50 },
  attribution_days: { min: 1, max: 30 },
  min_margin_pct: { min: 0, max: 90 },
  default_food_cost_pct: { min: 1, max: 95 },
  drop_alert_pct: { min: 1, max: 90 },
  pause_after_unread: { min: 0, max: 20 },
} as const;
export type IntSettingKey = keyof typeof SETTINGS_BOUNDS;

/** message_cost_inr is numeric(6,3) with CHECK between 0 and 100. */
export const MESSAGE_COST_BOUNDS = { min: 0, max: 100, decimals: 3 } as const;

/** What a fresh install runs on; mirrors the column defaults in the migration. */
export const DEFAULT_SETTINGS: MarketingSettings = {
  enabled: false,
  monthly_budget_inr: 1000,
  message_cost_inr: 1.02,
  send_window_start_hour: 11,
  send_window_end_hour: 20,
  daily_send_cap: 200,
  min_days_between: 7,
  max_per_30_days: 4,
  holdout_pct: 10,
  attribution_days: 7,
  min_margin_pct: 30,
  default_food_cost_pct: 35,
  drop_alert_pct: 15,
  pause_after_unread: 3,
  whatsapp_business_number: '',
  updated_at: null,
};

// ---------------------------------------------------------------------------
// Tunable constants of the model (spec §1) — not owner settings
// ---------------------------------------------------------------------------

/** Deliverability (delivered ÷ sent) assumed until receipts have flowed for enough sends. */
export const DEFAULT_DELIVERABILITY = 0.9;
/** Fewer sends than this and the learned deliverability is noise; use the default. */
export const MIN_DELIVERABILITY_SAMPLE = 20;
/** Weight of the research prior in the Bayesian conversion blend, in "virtual recipients". */
export const BLEND_PRIOR_WEIGHT = 50;
/** Conversion prior (%) for manual campaigns, which have no playbook history. */
export const MANUAL_PRIOR_PCT = 5;
/** Lift is shown only when the holdout has at least this many people. */
export const MIN_HOLDOUT_FOR_LIFT = 20;
/** Fallback for the loyalty max_redeem_pct when pricing a points reminder. */
export const DEFAULT_MAX_REDEEM_PCT = 50;
/** missing_costs guardrail: flag when less than this % of 90-day item revenue has a real cost. */
export const MIN_COST_COVERAGE_PCT = 50;
/** Days of order history used for basket size and the blended food-cost ratio. */
export const ECONOMICS_WINDOW_DAYS = 90;
/** Days of order history the contact stats are computed over. */
export const CONTACT_HISTORY_DAYS = 365;
/** unread_pause only applies while the latest of the unread messages is younger than this. */
export const UNREAD_PAUSE_MAX_AGE_DAYS = 60;
/** The window used for the "points expiring this week" insight and audience summary. */
export const INSIGHT_EXPIRY_DAYS = 7;
/** A campaign left in pending_approval this long is expired by the planner. */
export const APPROVAL_EXPIRY_DAYS = 2;
/** A manual DRAFT nobody approved is expired by the planner after this long (a draft is not a pending decision, so it gets longer). */
export const DRAFT_EXPIRY_DAYS = 7;
/** A 'sending' recipient claimed this long ago is marked failed/'interrupted', never re-sent. */
export const STALE_SENDING_MINUTES = 15;
/** Rows per page in CampaignDetail.recipients. */
export const RECIPIENT_PAGE_SIZE = 50;
/** Weeks of history in the weekly-active chart (complete IST Mon–Sun weeks). */
export const WEEKLY_ACTIVE_WEEKS = 9;
/** Order statuses that never count as a customer's order. */
export const INVALID_ORDER_STATUSES = ['cancelled', 'rejected'] as const;

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

export type PlaybookKey = 'points_expiring' | 'points_balance' | 'winback_1' | 'winback_2' | 'winback_3';

/** Every playbook, highest priority first (priority 1 = first). Same order as DEFAULT priorities. */
export const PLAYBOOK_KEYS: readonly PlaybookKey[] = [
  'points_expiring',
  'winback_3',
  'winback_2',
  'winback_1',
  'points_balance',
];

export type PlaybookMode = 'off' | 'review' | 'auto';
export const PLAYBOOK_MODES: readonly PlaybookMode[] = ['off', 'review', 'auto'];

export interface PointsExpiringParams {
  /** Qualify when at least this many points expire within days_ahead (20 = the minimum redemption). */
  min_points: number;
  /** "Expiring soon" horizon in days. */
  days_ahead: number;
  /** Skip customers who ordered within this many days — they are already engaged. 0 = no such rule. */
  recent_order_days: number;
  /** Don't send this playbook to the same phone twice within this many days. */
  cooldown_days: number;
}

export interface PointsBalanceParams {
  /** Qualify when the balance is at least this many points. */
  min_points: number;
  /** ...and the customer has not ordered for at least this many days. */
  min_days_since_order: number;
  cooldown_days: number;
}

export interface WinbackStage1Params {
  /** Personalised lapse threshold = round(gap_multiplier × the customer's typical gap)... */
  gap_multiplier: number;
  /** ...clamped to [min_days, max_days]. */
  min_days: number;
  max_days: number;
  /** Threshold for customers with no measurable rhythm (fewer than 3 orders). Not clamped. */
  default_days: number;
}

export interface WinbackStage2Params {
  /** Stage 2 starts this many days after stage 1 starts. */
  offset_days: number;
}

export interface WinbackStage3Params {
  /** Stage 3 starts this many days after stage 1 starts. */
  offset_days: number;
  /** Beyond this many days since the last order the customer is 'lost' and never messaged automatically. */
  max_days: number;
}

export interface PlaybookParamsMap {
  points_expiring: PointsExpiringParams;
  points_balance: PointsBalanceParams;
  winback_1: WinbackStage1Params;
  winback_2: WinbackStage2Params;
  winback_3: WinbackStage3Params;
}
export type PlaybookParams = PlaybookParamsMap[PlaybookKey];

/** The three win-back params objects together — everything lifecycle staging needs. */
export interface WinbackParamsBundle {
  winback_1: WinbackStage1Params;
  winback_2: WinbackStage2Params;
  winback_3: WinbackStage3Params;
}

/** Inclusive [min, max] for every editable playbook param. parse.ts enforces these; the UI can use them for inputs. */
export const PARAM_BOUNDS: { [K in PlaybookKey]: { [P in keyof PlaybookParamsMap[K]]: { min: number; max: number } } } = {
  points_expiring: {
    min_points: { min: 1, max: 1000 },
    days_ahead: { min: 1, max: 30 },
    recent_order_days: { min: 0, max: 30 },
    cooldown_days: { min: 1, max: 90 },
  },
  points_balance: {
    min_points: { min: 1, max: 10_000 },
    min_days_since_order: { min: 0, max: 180 },
    cooldown_days: { min: 1, max: 90 },
  },
  winback_1: {
    gap_multiplier: { min: 1, max: 10 },
    min_days: { min: 2, max: 90 },
    max_days: { min: 2, max: 180 },
    default_days: { min: 2, max: 180 },
  },
  winback_2: {
    offset_days: { min: 1, max: 120 },
  },
  winback_3: {
    offset_days: { min: 1, max: 240 },
    max_days: { min: 30, max: 365 },
  },
};

/** Owner-facing names. */
export const PLAYBOOK_LABELS: Record<PlaybookKey, string> = {
  points_expiring: 'Points expiring',
  points_balance: 'Points waiting',
  winback_1: 'Win-back · stage 1 (we miss you)',
  winback_2: 'Win-back · stage 2 (a bigger treat)',
  winback_3: 'Win-back · stage 3 (last chance)',
};

/** One-line plain-English "who gets this" for each playbook card. */
export const PLAYBOOK_DESCRIPTIONS: Record<PlaybookKey, string> = {
  points_expiring:
    'Customers whose loyalty points are about to expire, so they use them before they are lost. Points are the offer, no coupon.',
  points_balance:
    'Customers sitting on a healthy points balance who have not ordered in a while. Points are the offer, no coupon.',
  winback_1: 'Customers who have just gone quiet, measured against their own visit rhythm. A small offer.',
  winback_2: 'Customers who are still away a month later. A stronger offer, ideally a free item that costs you little.',
  winback_3: 'A last try before a customer counts as lost. Sent once per lapse.',
};

/** Label for a manual (owner-created) campaign wherever a playbook name would go. */
export const MANUAL_CAMPAIGN_LABEL = 'Manual campaign';

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export interface NoOffer {
  type: 'none';
}

export interface PercentOffer {
  type: 'percent';
  /** Whole percent off, 1–50. */
  percent: number;
  /** Maximum discount, integer ₹. 0 = no cap. */
  cap_inr: number;
  /** Minimum order (₹) for the coupon to apply. */
  min_order_inr: number;
  /** The coupon is valid through the end of the IST day this many days after the send. */
  validity_days: number;
}

export interface FlatOffer {
  type: 'flat';
  /** ₹ off, integer, 1–1000. */
  amount_inr: number;
  min_order_inr: number;
  validity_days: number;
}

export interface FreeItemOffer {
  type: 'free_item';
  /** The item. null together with variant_id = null means "auto-pick the best value item at plan time". */
  item_id: string | null;
  /** The specific size/variant given free (prices and costs live per variant). null = auto-pick. */
  variant_id: string | null;
  /** Auto-pick only considers variants priced at or under this (integer ₹). */
  max_item_price: number;
  /** Minimum spend on OTHER items (₹). The coupon's own min order adds the free item's price on top. */
  min_order_inr: number;
  validity_days: number;
  // Resolved, FROZEN on a campaign when it is planned (never present on a playbook's stored offer, and
  // ignored if a client sends them). They make the campaign self-describing and the economics repeatable
  // even if the menu or its prices change before the send.
  item_name?: string;
  variant_label?: string;
  /** The variant's menu price at plan time, integer ₹. */
  price_inr?: number;
  /** The variant's entered cost (COGS) at plan time, ₹ (may carry decimals). */
  cost_inr?: number;
}

/** An offer the owner can attach: it becomes a phone-locked coupon at send time (except 'none'). */
export type Offer = NoOffer | PercentOffer | FlatOffer | FreeItemOffer;
export type OfferType = Offer['type'];

/** Points reminders "offer" the customer's own points. Economics-only — never stored on a playbook or campaign. */
export interface PointsOffer {
  type: 'points';
  /** ₹ value of the points being pointed at (points × ₹ per point). */
  points_value_inr: number;
}
/** What the economics module prices: a stored Offer, or the implicit points offer of a points playbook. */
export type EconomicOffer = Offer | PointsOffer;

/** Inclusive bounds for offer fields. parse.ts enforces these. */
export const OFFER_BOUNDS = {
  percent: { min: 1, max: 50 },
  amount_inr: { min: 1, max: 1000 },
  validity_days: { min: 1, max: 60 },
  min_order_inr: { min: 0, max: 5000 },
  cap_inr: { min: 0, max: 2000 },
  max_item_price: { min: 1, max: 2000 },
} as const;

// ---------------------------------------------------------------------------
// Templates (Meta-approved WhatsApp templates the owner maps in the dashboard)
// ---------------------------------------------------------------------------

/** Values a template variable {{n}} can be filled with, in the order the owner lists them. */
export const TEMPLATE_TOKENS = [
  'first_name', // first word of the profile name, max 20 chars, fallback "there"
  'points', // current points balance
  'points_value_inr', // ₹ value of that balance
  'expiring_points', // points that expire within the playbook's days_ahead
  'expiring_value_inr', // ₹ value of those
  'expiry_date', // when the oldest expiring points go, "5 Oct"
  'offer_text', // customer-facing text of the offer, see offerText()
  'code', // the customer's own single-use coupon code (issued at send time)
  'valid_till', // last day the coupon works, "12 Oct"
  'days_since_visit', // whole days since the last order
  'headline', // manual campaigns only — owner-typed, max 60 chars
] as const;
export type TemplateToken = (typeof TEMPLATE_TOKENS)[number];

export const TEMPLATE_TOKEN_LABELS: Record<TemplateToken, string> = {
  first_name: 'First name',
  points: 'Points balance',
  points_value_inr: 'Points value (₹)',
  expiring_points: 'Expiring points',
  expiring_value_inr: 'Expiring value (₹)',
  expiry_date: 'Expiry date',
  offer_text: 'Offer text',
  code: 'Coupon code',
  valid_till: 'Valid till',
  days_since_visit: 'Days since last visit',
  headline: 'Headline (manual only)',
};

/** Sample values for the dashboard preview and the "send test to my phone" button. */
export const TEMPLATE_TOKEN_SAMPLES: Record<TemplateToken, string> = {
  first_name: 'Asha',
  points: '120',
  points_value_inr: '120',
  expiring_points: '80',
  expiring_value_inr: '80',
  expiry_date: '5 Oct',
  offer_text: '10% off (up to ₹60) on orders above ₹150',
  code: 'WBK7M3QX',
  valid_till: '12 Oct',
  days_since_visit: '32',
  headline: 'New hazelnut latte',
};

/** A template as stored on a playbook or campaign (playbook.template / campaign.template). */
export interface TemplateConfig {
  /** The approved template's name in WhatsApp Manager. Empty = not mapped yet (guardrail no_template). */
  name: string;
  /** Meta language code, e.g. 'en' or 'en_US'. */
  lang: string;
  /** The token that fills {{1}}, {{2}}, … in order. */
  vars: TemplateToken[];
  /** true = send the recipient's click_token as the URL button's dynamic suffix (index 0). */
  url_button: boolean;
  /** The owner's copy of the approved body, with {{n}} placeholders. Dashboard preview only — never sent. */
  body_preview: string;
}

export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
export const TEMPLATE_LANG_PATTERN = /^[a-z]{2}(_[A-Z]{2})?$/;
export const TEMPLATE_MAX_VARS = 10;
/** Meta's body limit; the preview is the owner's copy of that body. */
export const TEMPLATE_BODY_PREVIEW_MAX = 1024;
/** A rendered variable is capped at this many characters (Meta rejects long params). */
export const TEMPLATE_PARAM_MAX = 100;
export const FIRST_NAME_MAX = 20;
export const HEADLINE_MAX = 60;
export const CAMPAIGN_NAME_MAX = 80;

/** The four templates the owner creates in Meta (docs/WHATSAPP-MARKETING-TEMPLATES.md). Marketing category, footer "Reply STOP to unsubscribe". */
export const DEFAULT_TEMPLATES = {
  points_expiring: {
    name: 'hioc_points_expiring_1',
    lang: 'en',
    vars: ['first_name', 'expiring_points', 'expiring_value_inr', 'expiry_date'],
    url_button: true,
    body_preview:
      'Hi {{1}}, {{2}} of your HIOC reward points (worth ₹{{3}}) expire on {{4}}. Use them on your next coffee or waffle: just share your number at the counter, or log in when you order online. See you soon!',
  },
  points_balance: {
    name: 'hioc_points_balance_1',
    lang: 'en',
    vars: ['first_name', 'points', 'points_value_inr'],
    url_button: true,
    body_preview:
      'Hi {{1}}, you have {{2}} HIOC reward points worth ₹{{3}} waiting for you. Redeem them on your next visit: just share your number at the counter, or log in when you order online. See you soon!',
  },
  winback: {
    name: 'hioc_winback_1',
    lang: 'en',
    vars: ['first_name', 'offer_text', 'code', 'valid_till'],
    url_button: true,
    body_preview:
      "Hi {{1}}, we've missed you at HIOC! Here's {{2}} on your next visit. Use code {{3}} at the counter or online, valid till {{4}}. Your favourites are waiting!",
  },
  manual: {
    name: 'hioc_offer_1',
    lang: 'en',
    vars: ['first_name', 'headline', 'offer_text', 'code', 'valid_till'],
    url_button: true,
    body_preview:
      'Hi {{1}}, {{2}} at HIOC! Enjoy {{3}} with code {{4}}, valid till {{5}}. See you soon.',
  },
} satisfies Record<string, TemplateConfig>;

// ---------------------------------------------------------------------------
// Playbook rows and views
// ---------------------------------------------------------------------------

/** marketing_playbooks as stored. Discriminated on `key`, so `params` narrows with it. */
export type PlaybookRow = {
  [K in PlaybookKey]: {
    key: K;
    mode: PlaybookMode;
    /** 1 = highest. A contact gets at most one agent message per day, from its highest-priority playbook. */
    priority: number;
    params: PlaybookParamsMap[K];
    /** Never carries the frozen resolved free-item fields; those live on campaigns. */
    offer: Offer;
    template: TemplateConfig;
    /** Research conversion prior, % (0–100). */
    prior_conversion_pct: number;
    /** Sum over closed campaigns of treated recipients that were delivered (the learning denominator). */
    observed_treated: number;
    /** ...and how many of those converted. */
    observed_conversions: number;
    /** null until the planner has ever planned this playbook. */
    last_planned_at: string | null;
    updated_at: string | null;
  };
}[PlaybookKey];

/** The four fields a rule needs to run: what assignPlaybooks/qualifiesForPlaybook read. */
export type PlaybookRule = {
  [K in PlaybookKey]: { key: K; mode: PlaybookMode; priority: number; params: PlaybookParamsMap[K] };
}[PlaybookKey];

/** GET /api/owner/marketing/playbooks (and PATCH …/[key]) item: the row plus everything the card shows. */
export type PlaybookView = PlaybookRow & {
  /** PLAYBOOK_LABELS[key]. */
  label: string;
  /** PLAYBOOK_DESCRIPTIONS[key]. */
  description: string;
  /** The rate projections use now: the Bayesian blend of prior and observed, in % (0–100). */
  learned_conversion_pct: number;
  /** Most recent campaigns of this playbook, newest first (up to 5). `samples` is empty here. */
  last_runs: CampaignSummary[];
};

export interface PlaybooksResponse {
  playbooks: PlaybookView[];
}

/** What the migration seeds and what the code falls back to; each playbook starts in mode 'off'. */
export type PlaybookDefaults = {
  [K in PlaybookKey]: {
    key: K;
    priority: number;
    params: PlaybookParamsMap[K];
    offer: Offer;
    template: TemplateConfig;
    prior_conversion_pct: number;
  };
}[PlaybookKey];

export const DEFAULT_PLAYBOOKS: { [K in PlaybookKey]: Extract<PlaybookDefaults, { key: K }> } = {
  points_expiring: {
    key: 'points_expiring',
    priority: 1,
    params: { min_points: 20, days_ahead: 5, recent_order_days: 2, cooldown_days: 14 },
    offer: { type: 'none' },
    template: { ...DEFAULT_TEMPLATES.points_expiring, vars: [...DEFAULT_TEMPLATES.points_expiring.vars] },
    prior_conversion_pct: 15,
  },
  winback_3: {
    key: 'winback_3',
    priority: 2,
    params: { offset_days: 60, max_days: 180 },
    offer: { type: 'percent', percent: 20, cap_inr: 120, min_order_inr: 200, validity_days: 7 },
    template: { ...DEFAULT_TEMPLATES.winback, vars: [...DEFAULT_TEMPLATES.winback.vars] },
    prior_conversion_pct: 5,
  },
  winback_2: {
    key: 'winback_2',
    priority: 3,
    params: { offset_days: 30 },
    offer: { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 },
    template: { ...DEFAULT_TEMPLATES.winback, vars: [...DEFAULT_TEMPLATES.winback.vars] },
    prior_conversion_pct: 8,
  },
  winback_1: {
    key: 'winback_1',
    priority: 4,
    params: { gap_multiplier: 2.5, min_days: 14, max_days: 45, default_days: 30 },
    offer: { type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 },
    template: { ...DEFAULT_TEMPLATES.winback, vars: [...DEFAULT_TEMPLATES.winback.vars] },
    prior_conversion_pct: 12,
  },
  points_balance: {
    key: 'points_balance',
    priority: 5,
    params: { min_points: 50, min_days_since_order: 10, cooldown_days: 21 },
    offer: { type: 'none' },
    template: { ...DEFAULT_TEMPLATES.points_balance, vars: [...DEFAULT_TEMPLATES.points_balance.vars] },
    prior_conversion_pct: 8,
  },
};

/** A fresh, independent copy of one playbook's defaults (safe to mutate). */
export function defaultPlaybook<K extends PlaybookKey>(key: K): Extract<PlaybookDefaults, { key: K }> {
  return JSON.parse(JSON.stringify(DEFAULT_PLAYBOOKS[key])) as Extract<PlaybookDefaults, { key: K }>;
}

/** PATCH /api/owner/marketing/playbooks/[key] body: any subset. `params` may itself be partial. */
export interface PlaybookPatch<K extends PlaybookKey = PlaybookKey> {
  mode?: PlaybookMode;
  params?: Partial<PlaybookParamsMap[K]>;
  offer?: Offer;
  template?: TemplateConfig;
  prior_conversion_pct?: number;
}

// ---------------------------------------------------------------------------
// Customers: lifecycle, contact stats, audience filters
// ---------------------------------------------------------------------------

export type LifecycleStage =
  | 'new' // exactly 1 order and not yet at the lapse threshold
  | 'active'
  | 'at_risk' // within the last 20% of the lapse threshold
  | 'lapsed_1'
  | 'lapsed_2'
  | 'lapsed_3'
  | 'lost' // never messaged automatically
  | 'no_orders'; // opted in but no valid order in the window — manual campaigns only

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  'new',
  'active',
  'at_risk',
  'lapsed_1',
  'lapsed_2',
  'lapsed_3',
  'lost',
  'no_orders',
];

export const LIFECYCLE_STAGE_LABELS: Record<LifecycleStage, string> = {
  new: 'New',
  active: 'Active',
  at_risk: 'At risk',
  lapsed_1: 'Lapsed · stage 1',
  lapsed_2: 'Lapsed · stage 2',
  lapsed_3: 'Lapsed · stage 3',
  lost: 'Lost',
  no_orders: 'No orders yet',
};

/** Days-since-last-order at which each stage begins, for one contact. See stageThresholds(). */
export interface StageThresholds {
  /** Lapse threshold: the customer is `lapsed_1` from this many days. Personalised by visit rhythm. */
  stage1_days: number;
  stage2_days: number;
  stage3_days: number;
  /** `lost` from this many days. */
  lost_after_days: number;
}

/**
 * Everything the agent knows about one marketing contact (an E.164 phone with a
 * consent row). Built by segments.buildContactStats from already-joined inputs.
 */
export interface ContactStats {
  /** E.164, '+91XXXXXXXXXX' when valid. The contact's identity. */
  phone: string;
  /** The auth user the phone joins to (verified profile), or null for a phone with no account. */
  user_id: string | null;
  /** First word of the profile name, ≤ 20 chars, "there" when unknown. Ready to drop into a template. */
  first_name: string;
  /** profiles.role, or null when the phone has no profile. Anything other than 'customer' is excluded (rule staff). */
  role: string | null;
  /** marketing_consent.status === 'opted_in'. */
  consent_opted_in: boolean;
  /** A whatsapp_opt_outs row exists for the phone — beats consent_opted_in. */
  opt_out_listed: boolean;

  /** Valid orders in the last 365 days. */
  order_count: number;
  /** Sum of their total_inr, integer ₹. */
  total_spend_inr: number;
  /** Mean order value, rounded to integer ₹; 0 when there are no orders. */
  aov_inr: number;
  /** null when order_count is 0. */
  first_order_at: string | null;
  /** null when order_count is 0. */
  last_order_at: string | null;
  /** Whole elapsed days since last_order_at (floored, never negative); null when there are no orders. */
  days_since_last_order: number | null;
  /** Median gap between consecutive order days, clamped to [2, 60]; null when order_count < 3 (no rhythm yet). */
  typical_gap_days: number | null;
  /** This contact's personalised lapse threshold (typical gap × multiplier, or the default). */
  stage1_days: number;
  stage: LifecycleStage;

  /** Ledger balance, whole points, never negative. */
  points_balance: number;
  /** ₹ value of the balance (floor(points × ₹ per point)). */
  points_value_inr: number;
  /** Points expiring within the points_expiring playbook's days_ahead. 0 when expiry is off. */
  expiring_points: number;
  expiring_value_inr: number;
  /** IST date ('YYYY-MM-DD') the oldest unspent points go; never earlier than today. null when nothing is unspent or expiry is off. */
  expiry_date: string | null;
  /** Points expiring within INSIGHT_EXPIRY_DAYS (7), for the dashboard insight, independent of any playbook's setting. */
  expiring_points_7d: number;
  expiring_value_7d_inr: number;

  /** Top 20% by spend among contacts with ≥ 3 orders. Set by segments.applyVip over the whole population; false until then. */
  vip: boolean;
}

/** A manual campaign's audience. Every field optional; an empty filter means all opted-in contacts. */
export interface AudienceFilter {
  /** Any of these stages. Omitted or empty = every stage. */
  stages?: LifecycleStage[];
  vip_only?: boolean;
  min_orders?: number;
  /** Integer ₹. */
  min_spend_inr?: number;
  /** Last order between `from` and `to` days ago, inclusive. Customers with no orders never match either bound. */
  last_order_from_days?: number;
  last_order_to_days?: number;
  min_points?: number;
}

export const AUDIENCE_BOUNDS = {
  min_orders: { min: 0, max: 1000 },
  min_spend_inr: { min: 0, max: 1_000_000 },
  last_order_days: { min: 0, max: 730 },
  min_points: { min: 0, max: 100_000 },
} as const;

// ---------------------------------------------------------------------------
// Sending: recipients, eligibility, history
// ---------------------------------------------------------------------------

export type RecipientArm = 'treatment' | 'holdout';

export type RecipientStatus =
  | 'pending' // planned, campaign awaiting approval
  | 'queued' // approved, waiting for the sender
  | 'sending' // claimed by the sender (never reclaimed — see spec trap 4)
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'skipped' // dropped at plan or send time; see skip_reason
  | 'holdout' // deliberately not messaged (measurement control)
  | 'cancelled';

export const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
  'holdout',
  'cancelled',
];

/** Statuses meaning a message actually left (forward-only: sent < delivered < read). */
export const SENT_STATUSES: readonly RecipientStatus[] = ['sent', 'delivered', 'read'];
/** Statuses meaning the recipient is still in an open campaign's pipeline. */
export const IN_FLIGHT_STATUSES: readonly RecipientStatus[] = ['pending', 'queued', 'sending'];

/** Why a contact was (or would be) skipped. These are spec §1.5 rules 1–9, in order. */
export const ELIGIBILITY_REASONS = [
  'not_opted_in', // 1 — no opted_in consent, or a whatsapp_opt_outs row exists
  'staff', // 2 — profile role is not 'customer'
  'invalid_phone', // 3 — not a valid Indian mobile
  'too_soon', // 4 — a marketing message in the last min_days_between days
  'monthly_cap', // 5 — max_per_30_days reached
  'unread_pause', // 6 — the last N messages all went unread
  'in_flight', // 7 — already in another open campaign (a draft does not count)
  'in_holdout', // 8 — a control-group member of a live campaign whose attribution window is open
  'claimed_by_higher_priority', // 9 — a higher-priority playbook took this contact today
] as const;
export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

/** recipients.skip_reason: an eligibility reason, or one the sender/consent code adds. */
export type SkipReason = EligibilityReason | 'opted_out' | 'not_configured';

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  not_opted_in: 'Not opted in',
  staff: 'Team member',
  invalid_phone: 'Not a valid mobile number',
  too_soon: 'Messaged too recently',
  monthly_cap: 'Monthly message limit reached',
  unread_pause: 'Paused: last messages went unread',
  in_flight: 'Already in another campaign',
  in_holdout: "In a control group — measuring a campaign's effect",
  claimed_by_higher_priority: 'Got a higher-priority message today',
  opted_out: 'Opted out before sending',
  not_configured: 'WhatsApp is not configured',
};

/**
 * One marketing_recipients row of a phone, as far as eligibility and playbook
 * cooldowns care. The caller loads a phone's rows from the last ~60 days plus
 * any still in flight; older rows only matter to win-back's "since last order".
 */
export interface SendHistoryEntry {
  campaign_id: string;
  /** null = a manual campaign. */
  playbook_key: PlaybookKey | null;
  arm: RecipientArm;
  status: RecipientStatus;
  created_at: string;
  /** When the message left; null until sent. */
  sent_at: string | null;
  /** When the recipient was read; null if unread or receipts are not flowing. */
  read_at: string | null;
  /** sent_at for treated, the campaign start for holdout; null before then. */
  reference_at: string | null;
  /**
   * The status of the campaign this row belongs to, when the loader knows it (undefined/null
   * otherwise, and then the row is treated as belonging to a live campaign). A DRAFT campaign's
   * pending rows are not "in flight" and a cancelled/expired campaign's holdout never held anyone out.
   */
  campaign_status?: CampaignStatus | null;
}

// ---------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------

export type GuardrailFlag =
  | 'negative_profit'
  | 'low_margin'
  | 'over_budget'
  | 'missing_costs'
  | 'no_template'
  | 'no_free_item';

export const GUARDRAIL_FLAGS: readonly GuardrailFlag[] = [
  'negative_profit',
  'low_margin',
  'over_budget',
  'missing_costs',
  'no_template',
  'no_free_item',
];

/** The plain-English chip text; the campaign never auto-sends while any flag is set. */
export const GUARDRAIL_EXPLANATIONS: Record<GuardrailFlag, string> = {
  negative_profit: 'Expected to lose money: the profit from returning customers does not cover the message cost.',
  low_margin: 'Thin margin: after the offer and product cost, each returning order keeps less than your minimum margin.',
  over_budget: 'This campaign costs more in messages than what is left of this month’s budget.',
  missing_costs: 'Product costs are missing for most of your sales, so this uses a default food-cost % and may be off.',
  no_template: 'No WhatsApp template is set for this campaign.',
  no_free_item: 'No free item can be picked: enter product costs, or raise the price limit for the free item.',
};

/** The economic forecast of one campaign — every formula in spec §1.6. Stored on the campaign as `projection`. */
export interface Projection {
  /** N: contacts that passed eligibility. */
  eligible: number;
  /** round(N × holdout_pct / 100) — kept back to measure lift. */
  holdout: number;
  /** N − holdout: the people who actually get the message. */
  treated: number;

  // The inputs the forecast used, echoed so the dashboard can show them.
  /** ₹ per message. */
  message_cost_inr: number;
  /** d — delivered ÷ sent, 0–1. */
  deliverability: number;
  /** r — blended conversion rate, 0–1. */
  conversion_rate: number;
  /** A — basket value, ₹ (median of recipients' AOV, else the store AOV). */
  basket_inr: number;
  /** f — blended food-cost ratio, 0–1. */
  food_cost_ratio: number;

  /** ₹ of revenue given up per returning order to the discount (0 for a free item). */
  discount_inr: number;
  /** ₹ the offer costs the cafe per returning order (for a free item: the item's product cost). */
  offer_cost_inr: number;

  /** treated × d × r — expected returning orders. */
  conversions: number;
  /** A × (1 − f) − offer_cost — profit each returning order leaves. Can be negative. */
  profit_per_conv_inr: number;
  /** conversions × (A − discount). */
  revenue_inr: number;
  /** conversions × offer_cost. */
  offer_spend_inr: number;
  /** treated × message_cost. */
  message_spend_inr: number;
  /** conversions × profit_per_conv − message_spend. */
  expected_profit_inr: number;
  /** expected_profit ÷ (message_spend + offer_spend). null when that denominator is 0. */
  roi: number | null;
  /** 100 × profit_per_conv ÷ A; 0 when A is 0. */
  margin_after_pct: number;
  /** The conversion rate at which the campaign just breaks even, 0–1. null when profit_per_conv ≤ 0 (it never does) or nobody can be reached. */
  break_even_rate: number | null;

  /** Stamped (ISO) by the planner's learning step once this campaign's results were folded into the playbook. project() never sets it. */
  learned_at?: string | null;
}

/** One variant a free-item offer can pick, ranked by perceived value per rupee of cost. */
export interface FreeItemCandidate {
  item_id: string;
  item_name: string;
  variant_id: string;
  variant_label: string;
  /** Menu price, integer ₹. */
  price_inr: number;
  /** Entered product cost, ₹ (> 0; a candidate always has a real cost row). */
  cost_inr: number;
  /** price ÷ cost — how many ₹ of perceived value each ₹ of cost buys. Higher is better. */
  value_per_rupee: number;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export type CampaignKind = 'playbook' | 'manual';

export type CampaignStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'sending'
  | 'completed'
  | 'cancelled'
  | 'expired';

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'draft',
  'pending_approval',
  'approved',
  'sending',
  'completed',
  'cancelled',
  'expired',
];

/** Statuses from which nothing more will happen. */
export const TERMINAL_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['completed', 'cancelled', 'expired'];

/** GET /campaigns?status= — the three list views. */
export type CampaignListFilter = 'pending_approval' | 'active' | 'history';
/** pending_approval → draft + pending_approval; active → approved + sending; history → the terminal statuses. */
export const CAMPAIGN_LIST_STATUSES: Record<CampaignListFilter, readonly CampaignStatus[]> = {
  pending_approval: ['draft', 'pending_approval'],
  active: ['approved', 'sending'],
  history: TERMINAL_CAMPAIGN_STATUSES,
};

/**
 * The shape stored in marketing_campaigns.audience (jsonb). A manual campaign
 * stores its filter and headline; a playbook campaign stores the snapshot of the
 * playbook's params it was planned with (so a later edit doesn't rewrite history).
 */
export interface CampaignAudienceJson {
  filter?: AudienceFilter;
  headline?: string;
  params?: PlaybookParams;
}

/** A rendered sample message, for the Approvals card and the wizard preview. */
export interface RecipientPreview {
  first_name: string;
  /** body_preview with this recipient's variable values substituted. */
  text: string;
  /** The values that filled {{1}}…{{n}}, in order. */
  vars: string[];
  /** The recipient's coupon code, or '' when the campaign issues none / has not issued it yet (codes are issued at send). */
  coupon_code: string;
}

/**
 * Send/response totals for one campaign. Counts are CUMULATIVE along the
 * forward-only path: sent ⊇ delivered ⊇ read. Holdout recipients never count here.
 */
export interface CampaignTotals {
  /** Treated recipients whose status reached sent, delivered or read. */
  sent: number;
  /** ...reached delivered or read. 0 while receipts are not flowing. */
  delivered: number;
  read: number;
  /** Treated recipients that clicked the URL button (first click only). */
  clicked: number;
  failed: number;
  skipped: number;
  /** Treated recipients attributed a return (coupon or order). */
  returned: number;
  /** Σ conversion_revenue_inr of the returned treated recipients, integer ₹. */
  revenue_inr: number;
  /** Σ cost_inr actually charged, ₹ (failed sends cost 0). */
  spend_inr: number;
}

/** One row of the campaign lists, Approvals cards and playbook "last runs". */
export interface CampaignSummary {
  id: string;
  kind: CampaignKind;
  /** null for a manual campaign. */
  playbook_key: PlaybookKey | null;
  name: string;
  status: CampaignStatus;
  /** IST date the planner made it for. */
  planned_for: string;
  /** null = as soon as approved. */
  send_after: string | null;
  created_at: string;
  approved_at: string | null;
  /** null until the first send. */
  started_at: string | null;
  completed_at: string | null;
  treated_count: number;
  holdout_count: number;
  /** offerText() of the frozen offer; '' for no offer. */
  offer_text: string;
  offer: Offer;
  template_name: string;
  guardrail_flags: GuardrailFlag[];
  projection: Projection;
  /** Up to 3 rendered messages. Filled only for draft / pending_approval campaigns; [] elsewhere. */
  samples: RecipientPreview[];
  totals: CampaignTotals;
  /** Measured lift in percentage points; null until the holdout is big enough and the campaign has sent. */
  lift_pp: number | null;
}

export type RecipientRow = {
  id: string;
  /** E.164. The owner sees full numbers, as elsewhere in the owner area. */
  phone: string;
  first_name: string;
  arm: RecipientArm;
  status: RecipientStatus;
  /** '' when not skipped. A SkipReason for skips the agent makes. */
  skip_reason: string;
  coupon_code: string;
  error: string;
  error_code: string;
  cost_inr: number;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  clicked_at: string | null;
  converted_at: string | null;
  /** 0 when not converted. */
  conversion_revenue_inr: number;
  attributed_via: '' | 'coupon' | 'order';
};

/** The attribution result of a campaign (spec §1.8). */
export interface CampaignResults {
  /** Treated recipients that were sent/delivered/read — the lift denominator. */
  treated_delivered: number;
  treated_converted: number;
  /** All holdout recipients. */
  holdout_n: number;
  holdout_converted: number;
  /** treated_converted ÷ treated_delivered, 0–1; null when nothing was delivered. */
  treated_rate: number | null;
  /** holdout_converted ÷ holdout_n, 0–1; null when the holdout is empty. */
  holdout_rate: number | null;
  /** 100 × (treated_rate − holdout_rate). null unless holdout_n ≥ MIN_HOLDOUT_FOR_LIFT ("not enough data yet"). */
  lift_pp: number | null;
  /** max(0, lift) × treated_delivered — orders that would not have happened anyway. null whenever lift_pp is. */
  incremental_orders: number | null;
  /** false until the holdout has MIN_HOLDOUT_FOR_LIFT people; the UI shows "not enough data yet". */
  holdout_big_enough: boolean;
  /** started_at + attribution_days; null before the first send. */
  window_closes_at: string | null;
  /** true while returns can still be attributed. */
  attribution_open: boolean;
}

/** GET /api/owner/marketing/campaigns/[id]?page= */
export interface CampaignDetail extends CampaignSummary {
  template: TemplateConfig;
  /** The stored audience JSON (manual filter + headline, or the playbook params snapshot). */
  audience: CampaignAudienceJson;
  recipients: RecipientRow[];
  /** 1-based page of RECIPIENT_PAGE_SIZE rows. */
  page: number;
  /** Total recipient rows across all pages. */
  recipients_total: number;
  results: CampaignResults;
}

/** POST /api/owner/marketing/campaigns and /campaigns/preview body (parse.parseManualCampaign). */
export interface ManualCampaignInput {
  /** 1–80 chars. Empty only when validated in preview mode. */
  name: string;
  audience: AudienceFilter;
  offer: Offer;
  template: TemplateConfig;
  /** ≤ 60 chars; fills the `headline` token. Required when the template uses it (outside preview). */
  headline?: string;
  /** ISO timestamp not to send before; null/omitted = as soon as approved. */
  send_after?: string | null;
}

export interface CampaignsResponse {
  campaigns: CampaignSummary[];
}

export interface CampaignResponse {
  campaign: CampaignDetail;
}

/** POST /api/owner/marketing/campaigns/preview (nothing is saved). */
export interface CampaignPreview {
  eligible: number;
  projection: Projection;
  guardrail_flags: GuardrailFlag[];
  /** Up to 3. */
  samples: RecipientPreview[];
}

// ---------------------------------------------------------------------------
// Overview, audience, costs
// ---------------------------------------------------------------------------

export interface WeeklyPoint {
  /** The Monday (IST) the week starts, 'YYYY-MM-DD'. Weeks run Mon–Sun. */
  week_start: string;
  /** Distinct identified customers with a valid order that week. */
  customers: number;
  /** Valid orders that week (anonymous walk-ins included). */
  orders: number;
}

export interface DropAlert {
  /** Monday of the week that dropped (the last complete week). */
  week_start: string;
  last_week_customers: number;
  /** Mean of the 4 weeks before it, 1 decimal. */
  baseline_customers: number;
  /** How far below the baseline, whole %, ≥ the threshold. */
  drop_pct: number;
  /** baseline − last week, rounded. */
  drop_customers: number;
}

export type InsightId =
  | 'points_expiring_off'
  | 'lapsed_no_winback'
  | 'low_consent_coverage'
  | 'costs_missing'
  | 'best_free_item'
  | 'receipts_not_connected';

export interface InsightCta {
  label: string;
  /** Where the button goes on the dashboard. */
  tab: MarketingTab;
  /** For playbook insights, the card to open. */
  playbook_key?: PlaybookKey;
}

export interface Insight {
  id: InsightId;
  /** warn = something is costing the owner; info = an opportunity. */
  tone: 'info' | 'warn';
  /** The sentence shown to the owner, numbers already filled in. */
  message: string;
  cta: InsightCta | null;
}

export interface MarketingKpis {
  /** Distinct phones with status opted_in. */
  opted_in: number;
  /** Identified customers in stage new / active / at_risk. */
  active_customers: number;
  /** Share of those active customers who are opted in, 0–100. null when there are no active customers. */
  active_opted_in_pct: number | null;
  /** Σ cost_inr of recipients sent in the current IST month, ₹. */
  month_spend_inr: number;
  /** settings.monthly_budget_inr, echoed for the progress bar. */
  monthly_budget_inr: number;
  /** Treated messages that left in the last 30 days — including any Meta later reported as undelivered (those rows end up 'failed' but keep their sent_at). */
  messages_sent_30d: number;
  /** (delivered + read) ÷ messages_sent_30d × 100 over 30 days. null while receipts are not flowing or nothing was sent. */
  delivered_pct_30d: number | null;
  /** read ÷ delivered × 100. null under the same conditions. */
  read_pct_30d: number | null;
  /** Treated recipients attributed a return, last 30 days. */
  returning_orders_30d: number;
  /** Σ their conversion_revenue_inr, integer ₹. */
  returning_revenue_30d_inr: number;
  /** Measured lift (pp) over recently closed campaigns with a big-enough holdout; null when none qualifies. */
  lift_pp: number | null;
  /** Estimated ROI of the last 30 days (profit ÷ spend); null when nothing was spent. */
  est_roi: number | null;
}

/** GET /api/owner/marketing/overview */
export interface MarketingOverview {
  /** The kill switch: true = "Sending is ON". */
  enabled: boolean;
  /** false when WhatsApp credentials are missing — marketing never sends through the stub. */
  whatsapp_configured: boolean;
  /** true once any recipient has ever reached delivered/read. false = STOP/START and lift measurement do not work yet. */
  receipts_connected: boolean;
  kpis: MarketingKpis;
  /** Campaigns in draft or pending_approval. */
  pending_approvals: number;
  /** WEEKLY_ACTIVE_WEEKS points, oldest first. */
  weekly: WeeklyPoint[];
  /** null when there is no drop. */
  drop_alert: DropAlert | null;
  insights: Insight[];
  /** The latest campaigns, newest first (about 8). */
  recent_campaigns: CampaignSummary[];
}

/**
 * GET /api/owner/marketing/overview?summary=1 — the four numbers the /owner home card shows.
 * The full overview joins a year of orders and the whole ledger; this one needs the settings, a
 * campaign count, the month's spend and about ten weeks of orders, so it is cheap enough to load
 * on every home-page visit.
 */
export interface MarketingOverviewSummary {
  /** The kill switch: true = "Sending is ON". Same rule as MarketingOverview.enabled. */
  enabled: boolean;
  /** Campaigns in draft or pending_approval. */
  pending_approvals: number;
  /** Σ cost_inr of recipients sent in the current IST month, ₹ (MarketingKpis.month_spend_inr). */
  month_spend_inr: number;
  /** settings.monthly_budget_inr. */
  month_budget_inr: number;
  /** Same alert the full overview computes from the weekly series; null when there is no drop. */
  drop_alert: DropAlert | null;
}

export interface ConsentEventRow {
  /** Masked ('+91 98••• ••210') — the audit list is for patterns, not lookups. */
  phone_masked: string;
  action: 'opt_in' | 'opt_out';
  source: string;
  created_at: string;
}

/** GET /api/owner/marketing/audience */
export interface AudienceSummary {
  /** Identified customers (with a verified account phone or an order phone). */
  total_customers: number;
  /** One row per LIFECYCLE_STAGES entry, in that order. `all` = every identified customer; `opted_in` = those who can be messaged. */
  stages: { stage: LifecycleStage; all: number; opted_in: number }[];
  points: {
    customers_with_balance: number;
    /** Σ balances, ₹. */
    outstanding_inr: number;
    /** ₹ expiring within INSIGHT_EXPIRY_DAYS. */
    expiring_7d_inr: number;
    expiring_7d_customers: number;
  };
  consent: {
    opted_in: number;
    opted_out: number;
    by_source: { source: string; opted_in: number; opted_out: number }[];
    /** Last 30 days, newest first (capped, about 50). */
    recent_events: ConsentEventRow[];
  };
  /** Echo of settings.whatsapp_business_number; '' = not set (the UI shows a notice). */
  whatsapp_business_number: string;
  /** https://wa.me/<digits>?text=START, or null when no business number is set. */
  optin_url: string | null;
}

/** One product-cost table row — one per VARIANT (prices and costs live per variant). */
export interface CostRow {
  variant_id: string;
  item_id: string;
  category: string;
  item_name: string;
  variant_label: string;
  price_inr: number;
  /** The entered cost, ₹. null = none entered (the default food-cost % is assumed). */
  cost_inr: number | null;
  /** 100 × cost ÷ price; null when there is no cost or the price is 0. The UI highlights above 50. */
  food_cost_pct: number | null;
  /** price − cost; null when there is no cost. */
  margin_inr: number | null;
  is_available: boolean;
  /** Revenue this variant made in the last 90 days, integer ₹ — for sorting missing costs by importance. */
  revenue_90d_inr: number;
}

/** GET /api/owner/marketing/costs (and the response to PUT). */
export interface CostsResponse {
  items: CostRow[];
  default_food_cost_pct: number;
  /** % of the last 90 days' item revenue that has a real cost entered, 0–100. */
  coverage_pct: number;
  /** Best free-item offers first (the UI shows the top 5). Empty until costs exist. */
  free_item_ranking: FreeItemCandidate[];
}

/** One row of PUT /api/owner/marketing/costs. */
export interface CostInput {
  variant_id: string;
  /** ₹ 0–100000; null deletes the cost row. */
  cost_inr: number | null;
}

export interface CostsPutBody {
  /** At most 500 rows per request. */
  costs: CostInput[];
}
export const COSTS_PUT_MAX_ROWS = 500;
export const COST_BOUNDS = { min: 0, max: 100_000 } as const;

// ---------------------------------------------------------------------------
// Other API shapes (spec §6)
// ---------------------------------------------------------------------------

export interface SettingsResponse {
  settings: MarketingSettings;
}

/** POST /api/owner/marketing/test-send */
export interface TestSendBody {
  template: TemplateConfig;
  /** Defaults to the owner's own profile phone. */
  phone?: string;
}
export interface TestSendResult {
  ok: boolean;
  error?: string;
  provider_ref?: string;
}

/** POST /api/owner/marketing/consent/opt-out */
export interface OptOutBody {
  phone: string;
}

/** GET|POST /api/cron/marketing-plan */
export interface PlanCronResult {
  enabled: boolean;
  /** true when a marketing table is missing (migration not applied) — a no-op, never an error. */
  migration_missing?: boolean;
  /** Recipients newly attributed a return. */
  attributed: number;
  planned: { key: PlaybookKey; status: CampaignStatus; eligible: number }[];
  /** Campaigns expired after sitting unapproved. */
  expired: number;
  /** Playbooks whose campaign could not be planned this run (its half-written rows were removed, so tomorrow — or a re-run — can try again). Absent when none failed. */
  failed?: { key: PlaybookKey; error: string }[];
}

/** GET|POST /api/cron/marketing-send */
export interface SendCronResult {
  enabled: boolean;
  migration_missing?: boolean;
  outside_window?: boolean;
  budget_exhausted?: boolean;
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Stale 'sending' rows marked failed/'interrupted'. */
  interrupted: number;
}

// ---------------------------------------------------------------------------
// Dashboard tabs
// ---------------------------------------------------------------------------

export type MarketingTab = 'overview' | 'approvals' | 'playbooks' | 'campaigns' | 'audience' | 'costs' | 'settings';

export const MARKETING_TABS: readonly { id: MarketingTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'playbooks', label: 'Playbooks' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'audience', label: 'Audience' },
  { id: 'costs', label: 'Product costs' },
  { id: 'settings', label: 'Settings' },
];

export const DEFAULT_MARKETING_TAB: MarketingTab = 'overview';

/** Narrows the `?tab=` query value; anything unknown is not a tab. */
export function isMarketingTab(value: unknown): value is MarketingTab {
  return typeof value === 'string' && MARKETING_TABS.some((t) => t.id === value);
}

// ---------------------------------------------------------------------------
// Coupons (spec §1.7)
// ---------------------------------------------------------------------------

/** No I, O, 0 or 1 — a code read aloud at the counter or typed on a phone must not be ambiguous. */
export const COUPON_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const COUPON_CODE_SUFFIX_LENGTH = 6;
/** Retry a unique-violation on the code this many times before giving up on the recipient. */
export const COUPON_CODE_MAX_ATTEMPTS = 3;

export const COUPON_CODE_PREFIXES = {
  points: 'PT',
  winback: 'WB',
  manual: 'OF',
} as const;

/** The coupon row a campaign offer becomes. Integer ₹ throughout; `scope` is the existing CouponScope. */
export interface CouponFields {
  discount_type: 'percent' | 'flat';
  /** Percent (1–50) or ₹. */
  discount_value: number;
  /** 0 = no cap. */
  max_discount_inr: number;
  min_order_inr: number;
  scope: { item_ids?: string[] };
}

/** Length and alphabet of recipients.click_token (base64url). */
export const CLICK_TOKEN_LENGTH = 12;
export const CLICK_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// ---------------------------------------------------------------------------
// Public opt-in link (S2 → S3)
// ---------------------------------------------------------------------------

/**
 * GET /api/marketing/optin — public, no auth, cached for 5 minutes. Carries ONLY the
 * wa.me link a customer taps to opt in (they send START and the webhook records it),
 * never any other setting. `available` is true only when the marketing flag is on AND the
 * owner has entered a WhatsApp business number; otherwise `wa_link` is null.
 */
export interface PublicOptinResponse {
  available: boolean;
  /** https://wa.me/<digits>?text=START, or null when not available. */
  wa_link: string | null;
}
