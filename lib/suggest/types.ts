// Phase 7 — "Help me choose" suggestion engine: the shared contract
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md). Every module under lib/suggest,
// the /api/suggest* routes, the /suggest page and the owner dashboard build
// against THESE types. Row types mirror supabase/2026-09-suggestion-engine.sql
// exactly — change both together or neither.
//
// Pure types + constants: no Supabase, no 'server-only', safe to import from
// client components and tests.

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MOODS = ['boost', 'cosy', 'celebrate', 'comfort', 'cool', 'surprise'] as const;
export type Mood = (typeof MOODS)[number];

export const DAYPARTS = ['morning', 'afternoon', 'evening', 'late'] as const;
export type Daypart = (typeof DAYPARTS)[number];

export type TraitTemperature = 'hot' | 'iced' | 'either' | 'ambient';
export type TraitCaffeine = 'none' | 'low' | 'medium' | 'high';
export type TraitBody = 'light' | 'medium' | 'rich';
export type TraitKind = 'drink' | 'food' | 'dessert';

// Customer step-1 chips (§3.2). 'either' is the same as not choosing.
export type TemperaturePref = 'hot' | 'iced' | 'either';
export type BasePref = 'coffee' | 'no_coffee' | 'either';
export const EXTRAS = ['sweet', 'eat', 'light', 'filling'] as const;
export type Extra = (typeof EXTRAS)[number];
export const NEEDS = ['no_caffeine', 'less_sugar'] as const;
export type Need = (typeof NEEDS)[number];
export const BUDGETS = ['under_150', '150_300', 'treat', 'any'] as const;
export type Budget = (typeof BUDGETS)[number];

// Derived from the taste profile (§5.5).
export type PriceComfort = 'budget' | 'mid' | 'premium';
export type OrderingMood = 'treating' | 'saving' | 'explorer' | 'routine';

// ---------------------------------------------------------------------------
// Rows (mirror the migration)
// ---------------------------------------------------------------------------

export interface MenuItemTraits {
  menu_item_id: string;
  temperature: TraitTemperature;
  caffeine: TraitCaffeine;
  is_coffee: boolean;
  sweetness: 0 | 1 | 2 | 3;
  body: TraitBody;
  kind: TraitKind;
  moods: Mood[];
  dayparts: Daypart[];
  flavor_notes: string[]; // ≤ 5
  source: 'opus' | 'owner';
  confirmed: boolean;
  updated_at: string;
}

export interface TasteProfile {
  topItems: { menu_item_id: string; count: number; lastOrderedAt: string }[]; // ≤ 10, most-ordered first
  categoryAffinity: Record<string, number>; // category → share of lines, sums to ~1
  traitLean: {
    icedShare: number; // share of drink lines that were iced (0–1)
    meanSweetness: number; // 0–3
    caffeineShare: number; // share of drink lines with caffeine ≠ none
    foodAttachRate: number; // share of orders containing food/dessert
  };
  ticket: { median: number; p75: number }; // integer rupees
  priceComfort: PriceComfort;
  orderingMood: OrderingMood;
  daypartHistogram: Record<Daypart, number>; // order share per daypart
  favorites: string[]; // menu_item_ids
}

export interface CustomerTasteProfileRow {
  user_id: string;
  profile: TasteProfile | Record<string, never>;
  order_count: number;
  computed_at: string;
  source_order_at: string | null;
  opted_out: boolean;
}

export type SuggestionSource = 'llm' | 'fallback';

export type FallbackReason =
  | 'timeout'
  | 'error'
  | 'refusal'
  | 'invalid_output'
  | 'budget'
  | 'rate_limited'
  | 'no_key'
  | 'disabled';

export interface SuggestionSessionRow {
  id: string;
  user_id: string | null;
  anon_id: string | null;
  inputs: SuggestInputs;
  profile_used: boolean;
  ordering_mood: OrderingMood | null;
  candidate_ids: string[];
  pick_ids: string[];
  usual_item_id: string | null;
  source: SuggestionSource;
  fallback_reason: FallbackReason | null;
  model: string | null;
  latency_ms: number;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd_micros: number;
  refine_of: string | null;
  created_at: string;
}

export const SUGGESTION_EVENTS = [
  'shown',
  'added_to_cart',
  'feedback_up',
  'feedback_down',
  'refined',
  'dismissed',
  'browse_menu',
  'checkout_started',
  'ordered',
] as const;
export type SuggestionEventType = (typeof SUGGESTION_EVENTS)[number];

// What POST /api/suggest/events accepts from a browser. 'shown' and 'ordered'
// are server-written only (playbook S-4).
export const CLIENT_SUGGESTION_EVENTS = [
  'added_to_cart',
  'feedback_up',
  'feedback_down',
  'refined',
  'dismissed',
  'browse_menu',
  'checkout_started',
] as const satisfies readonly SuggestionEventType[];
export type ClientSuggestionEventType = (typeof CLIENT_SUGGESTION_EVENTS)[number];

export interface SuggestionEventRow {
  id: string;
  session_id: string;
  event: SuggestionEventType;
  menu_item_id: string | null;
  order_id: string | null;
  value_inr: number | null;
  created_at: string;
}

export interface SuggestionDigestRow {
  id: string;
  week_start: string; // YYYY-MM-DD (IST Monday)
  summary: string;
  stats: SuggestionStats;
  source: 'llm' | 'template';
  model: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// API: POST /api/suggest
// ---------------------------------------------------------------------------

export interface SuggestInputs {
  temperature: TemperaturePref;
  base: BasePref;
  extras: Extra[];
  needs: Need[];
  budget: Budget;
  mood: Mood;
  note: string; // free text, ≤ 140 chars, UNTRUSTED
}

export interface SuggestRequest {
  inputs: SuggestInputs;
  anonId?: string; // client UUID from localStorage (guests' funnel continuity)
  refineOf?: string; // parent session id when "Show me something different"
  excludeItemIds?: string[]; // items already shown (refine), ≤ 12
}

export interface SuggestionPick {
  menuItemId: string;
  reason: string; // ≤ 120 chars, tone-linted
  reasonCode: Mood | 'trait' | 'usual' | 'popular';
}

export interface RelaxHint {
  constraint: 'budget' | 'temperature' | 'base' | 'extras' | 'needs';
  message: string; // polite, e.g. "Nothing iced under ₹150 right now…"
}

export interface SuggestResponse {
  sessionId: string;
  header: string; // e.g. "Here's what we'd pour for you ☕"
  usual: SuggestionPick | null; // signed-in returning customers only
  picks: SuggestionPick[]; // 0–3
  source: SuggestionSource;
  relaxHint: RelaxHint | null;
  refinesLeft: number; // 2 → 1 → 0
  // The menu rows for usual + picks, shaped like /api/menu items, so the page
  // can render cards and the customize modal without a second fetch.
  items: import('@/lib/types').MenuItem[];
}

// ---------------------------------------------------------------------------
// Engine internals (shared by filter/score/engine/llm)
// ---------------------------------------------------------------------------

export interface Candidate {
  menuItemId: string;
  score: number; // 0–1
  minPriceInr: number;
  category: string;
  traits: MenuItemTraits;
}

// What the decider model is allowed to know about a person (playbook S-3).
export interface ProfileSummary {
  topCategories: string[]; // ≤ 3
  icedLean: 'hot' | 'iced' | 'mixed';
  sweetLean: 'low' | 'medium' | 'high';
  priceComfort: PriceComfort;
  orderingMood: OrderingMood;
  usualItemIds: string[]; // ≤ 5
}

export interface DeciderResult {
  picks: { menuItemId: string; reason: string; reasonCode: SuggestionPick['reasonCode'] }[];
  header: string | null;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsdMicros: number;
}

// The injectable seam: engine.ts takes one of these so tests never hit the
// network. lib/suggest/llm.ts provides the real (Opus) implementation.
export type Decider = (args: {
  inputs: SuggestInputs;
  shortlist: Candidate[];
  profile: ProfileSummary | null;
  daypart: Daypart;
  signal: AbortSignal;
}) => Promise<DeciderResult>;

// ---------------------------------------------------------------------------
// Owner analytics (SUG-10)
// ---------------------------------------------------------------------------

export interface SuggestionStats {
  windowStart: string;
  sessions: number;
  sessionsWithAdd: number;
  sessionsCheckout: number;
  sessionsOrdered: number;
  attributedRevenueInr: number;
  suggestionAovInr: number | null;
  webAovInr: number | null;
  moodMix: { mood: Mood; sessions: number; ordered: number }[];
  topItems: {
    menuItemId: string;
    name: string;
    suggested: number;
    added: number;
    ordered: number;
    up: number;
    down: number;
  }[];
  personalised: { sessions: number; ordered: number };
  guest: { sessions: number; ordered: number };
  llmShare: number; // 0–1
  fallbackReasons: { reason: FallbackReason; count: number }[];
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Limits (spec constants — change with a reviewed diff + eval re-run)
// ---------------------------------------------------------------------------

export const SUGGEST_LIMITS = {
  noteMaxChars: 140,
  reasonMaxChars: 120,
  picks: 3,
  shortlist: 12,
  maxPerCategoryInShortlist: 2,
  refines: 2,
  excludeMax: 12,
  deciderTimeoutMs: 5000,
  profileWindowDays: 90,
  profileMaxOrders: 50,
  profileTtlHours: 24,
  ipRequestsPer10Min: 20,
  userRequestsPerDay: 60,
  orderSessionIdsMax: 5,
  eventSessionMaxAgeHours: 24,
} as const;
