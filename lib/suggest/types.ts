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

// Coffey v2 (docs/COFFEY-SPEC.md §1): 'focus' and 'unwind' are new — 'unwind'
// fills the stressed / high-arousal-negative corner of the circumplex the v1
// set missed (docs/research/COFFEY-PSYCHOLOGY-RESEARCH.md). The order here is
// the order of the step-1 cards (a 2×4 grid) and the tie-break order wherever
// moods are ranked.
export const MOODS = ['boost', 'focus', 'unwind', 'cosy', 'comfort', 'celebrate', 'cool', 'surprise'] as const;
export type Mood = (typeof MOODS)[number];
/** Step 1 is multi-select, capped at two feelings (COFFEY-SPEC §1). */
export const MAX_MOODS = 2;

export const DAYPARTS = ['morning', 'afternoon', 'evening', 'late'] as const;
export type Daypart = (typeof DAYPARTS)[number];

export type TraitTemperature = 'hot' | 'iced' | 'either' | 'ambient';
export type TraitCaffeine = 'none' | 'low' | 'medium' | 'high';
export type TraitBody = 'light' | 'medium' | 'rich';
export type TraitKind = 'drink' | 'food' | 'dessert';
/** Step 2 "What would you like?" order: a drink, something sweet, something savoury. */
export const KINDS = ['drink', 'dessert', 'food'] as const satisfies readonly TraitKind[];

// Customer step-2 choices (COFFEY-SPEC §1). 'either'/'any' is the same as not
// choosing.
export type TemperaturePref = 'hot' | 'iced' | 'either';
export type BasePref = 'coffee' | 'no_coffee' | 'either';
/** Soft, coffee drinks only: "Smooth & milky" is 'mild', "Strong coffee" is 'strong'. */
export const STRENGTH_PREFS = ['mild', 'balanced', 'strong', 'any'] as const;
export type StrengthPref = (typeof STRENGTH_PREFS)[number];
/** The fully labelled 5-point sweetness scale, plus 'any' (COFFEY-SPEC §1). */
export const SWEETNESS_PREFS = ['none', 'light', 'medium', 'sweet', 'very', 'any'] as const;
export type SweetnessPref = (typeof SWEETNESS_PREFS)[number];
export const BODY_PREFS = ['light', 'rich', 'any'] as const;
export type BodyPref = (typeof BODY_PREFS)[number];
/** Soft flavour preference, OR semantics. Labels and matching live in
 * lib/suggest/traitVocabulary.ts. */
// No 'savoury' family: "Something savoury" (kinds) already asks that, and a
// second savoury chip was the kind of duplicate the redesign removes.
export const FLAVOUR_FAMILIES = ['chocolatey', 'caramel', 'nutty', 'biscuit', 'fruity', 'spiced', 'floral'] as const;
export type FlavourFamily = (typeof FLAVOUR_FAMILIES)[number];
export const NEEDS = ['no_caffeine'] as const;
export type Need = (typeof NEEDS)[number];
// Price CEILINGS on the cheapest size (COFFEY-SPEC §1, §4.1). v1's
// "₹150–₹300" was a band that hid every item under ₹150 (half the live menu),
// and "Treat myself" filtered exactly like "Any" (nothing's cheapest size is
// above ₹280) — treating yourself now lives on the 'celebrate' mood card.
export const BUDGETS = ['under_100', 'under_150', 'under_200', 'any'] as const;
export type Budget = (typeof BUDGETS)[number];
export const BUDGET_CAPS: Record<Budget, number | null> = { under_100: 100, under_150: 150, under_200: 200, any: null };

// The v1 step-1 vocabulary. Still accepted by validateSuggestInputs() (old
// browser bundles, stored sessions, the eval fixtures) and upgraded to v2 by
// lib/suggest/inputs.ts upgradeV1Inputs() — never used by v2 code directly.
export const LEGACY_EXTRAS = ['sweet', 'eat', 'light', 'filling', 'chocolatey', 'fruity'] as const;
export type LegacyExtra = (typeof LEGACY_EXTRAS)[number];
export const LEGACY_NEEDS = ['no_caffeine', 'less_sugar'] as const;
export type LegacyNeed = (typeof LEGACY_NEEDS)[number];
/** v1 budgets. Upgraded: under_150 → under_150; 150_300 and treat → any. */
export const LEGACY_BUDGETS = ['under_150', '150_300', 'treat', 'any'] as const;
export type LegacyBudget = (typeof LEGACY_BUDGETS)[number];

/**
 * The 0–10 sweetness scale (COFFEY-SPEC §3.1, §4.1, §4.2, §4.7).
 * - `targets`: what each customer choice means on the item scale.
 * - `tolerance`: an item whose INHERENT sweetness is more than this above the
 *   target is excluded (sugar can be added, never taken out).
 * - `sugarAdds`: how far "Normal" sugar lifts a sugar-adjustable drink.
 * - `legacyToLevel`: the pre-v2 0–3 `sweetness` column on the 0–10 scale.
 */
export const SWEETNESS_SCALE = {
  max: 10,
  targets: { none: 0, light: 3, medium: 5, sweet: 7, very: 10 } as const satisfies Record<Exclude<SweetnessPref, 'any'>, number>,
  tolerance: 3,
  sugarAdds: 3,
  legacyToLevel: [0, 3, 6, 9] as const,
} as const;

/** menu_item_traits.traits_version for rows tagged under COFFEY-SPEC §3. */
export const CURRENT_TRAITS_VERSION = 2;

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
  // Coffey v2 (supabase/2026-10-coffey-traits-v2.sql, COFFEY-SPEC §3.1).
  // Optional, so a row read before the migration still type-checks; null or
  // absent means "not tagged at v2 yet", and every consumer treats it as
  // neutral. Read sweetness through lib/suggest/sweetness.ts sweetnessLevel(),
  // which falls back to the legacy 0–3 column.
  sweetness_level?: number | null; // 0–10, inherent (before optional table sugar)
  intensity?: number | null; // 0–3 gentle → bold
  refreshment?: number | null; // 0–3
  indulgence?: number | null; // 0–3 everyday → a real treat
  novelty?: number | null; // 0–3 familiar classic → adventurous
  textures?: Texture[]; // ≤ 3, lib/suggest/traitVocabulary.ts TEXTURES
  mood_fit?: Partial<Record<Mood, number>>; // 0–3 per mood, one decimal
  traits_version?: number; // 1 = pre-Coffey, CURRENT_TRAITS_VERSION = Coffey
}

export type Texture = (typeof import('./traitVocabulary').TEXTURES)[number];

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

/** v2 (COFFEY-SPEC §2). validateSuggestInputs() also accepts a v1 body
 * ({ mood, extras, needs: [..'less_sugar'], … }) and upgrades it. */
export interface SuggestInputs {
  mood: Mood; // primary feeling
  secondaryMood: Mood | null; // optional second feeling, never equal to `mood`
  kinds: TraitKind[]; // ≥ 1, no duplicates
  temperature: TemperaturePref;
  base: BasePref;
  strength: StrengthPref;
  sweetness: SweetnessPref;
  body: BodyPref;
  flavours: FlavourFamily[];
  needs: Need[];
  budget: Budget;
  note: string; // free text, ≤ 140 chars, UNTRUSTED
}

/** The pre-Coffey request shape, still accepted on the wire. */
export interface LegacySuggestInputs {
  temperature: TemperaturePref;
  base: BasePref;
  extras: LegacyExtra[];
  needs: LegacyNeed[];
  budget: LegacyBudget;
  mood: Exclude<Mood, 'focus' | 'unwind'>;
  note: string;
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
  /** ≤ 3 short "why it matches" labels from a fixed vocabulary
   * (COFFEY-SPEC §4.6), e.g. ["A proper lift", "Iced", "Not sweet"]. */
  matchTags?: string[];
  /** The sugar option to preselect in the customise modal (COFFEY-SPEC §4.7);
   * null/absent when the customer chose no sweetness or the item has no
   * sugar choice. */
  sugarPreset?: SugarPreset | null;
  /** An add-on that gives this item a flavour the customer asked for and it
   * doesn't have on its own (COFFEY-ADDONS-PAIRINGS-SPEC §2.4). Highlighted in
   * the customise modal, never preselected. null/absent otherwise. */
  flavourAddon?: FlavourAddonSuggestion | null;
}

export interface SugarPreset {
  groupId: string;
  optionId: string;
  label: string; // the option's customer-facing name, e.g. "No Sugar"
}

export interface RelaxHint {
  constraint: 'budget' | 'temperature' | 'base' | 'extras' | 'needs' | 'sweetness';
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
  name: string;
  score: number; // 0–1
  minPriceInr: number;
  maxPriceInr: number;
  category: string;
  /** Menu description, trimmed to 160 chars (§5.4) — extra context for the
   * decider model, on top of the structured traits. The Jev decider ignores
   * it (it only ever sees the short criteria label built by jevDecider.ts). */
  description: string;
  traits: MenuItemTraits;
  /** The item offers a sugar choice (lib/suggest/sugar.ts findSugarGroup),
   * so its sweetness can be raised above its inherent level (COFFEY-SPEC §4.2). */
  sugarAdjustable: boolean;
  /** Requested flavour families the item lacks on its own but can get from
   * one of its add-ons (lib/suggest/addonTraits.ts reachableAddonFamilies,
   * COFFEY-ADDONS-PAIRINGS-SPEC §2.4). Absent means none. */
  addonFlavourFamilies?: FlavourFamily[];
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
// network. lib/suggest/jevDecider.ts provides the real (Jev) implementation.
export type Decider = (args: {
  inputs: SuggestInputs;
  shortlist: Candidate[];
  profile: ProfileSummary | null;
  daypart: Daypart;
  signal: AbortSignal;
}) => Promise<DeciderResult>;

// ---------------------------------------------------------------------------
// Add-on traits (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2)
// ---------------------------------------------------------------------------

/** What an add-on option does to the item it's added to. Derived from the
 * group and option names (lib/suggest/addonTraits.ts deriveAddonTraits); the
 * owner can override any option (addon_option_traits). */
export const ADDON_ROLES = ['flavour', 'topping', 'shot', 'sweetener', 'milk', 'ice', 'serve', 'side', 'other'] as const;
export type AddonRole = (typeof ADDON_ROLES)[number];

/** Roles whose flavour families can give an item a flavour it lacks (§2.4),
 * in tie-break order. Sugar is lib/suggest/sugar.ts's job; milk, ice and a
 * side don't change what the item itself tastes of. */
export const FLAVOUR_REACH_ROLES = ['flavour', 'topping', 'serve'] as const satisfies readonly AddonRole[];

export interface AddonTraits {
  role: AddonRole;
  flavour_families: FlavourFamily[]; // ≤ 2
  sweetness_delta: number; // 0–5, on the 0–10 item sweetness scale
  intensity_delta: number; // 0–2 (an espresso shot is 1)
  indulgence_delta: number; // 0–2
  textures: Texture[]; // ≤ 2
}

/** addon_option_traits — the owner's override for one option. Mirrors
 * supabase/2026-10-coffey-addons-pairings.sql; change both together. */
export interface AddonOptionTraitsRow extends AddonTraits {
  option_id: string;
  updated_at: string;
}

/** The one add-on Coffey points to for a requested flavour (§2.4). */
export interface FlavourAddonSuggestion {
  groupId: string;
  optionId: string;
  label: string; // customer-facing, e.g. "Hazelnut syrup"
  priceInr: number;
  family: FlavourFamily;
}

export const ADDON_SUGGEST_LIMITS = {
  /** Options dearer than this are never pointed to. */
  maxPriceInr: 60,
  /** The flavour sub-fit for a family reached through an add-on (native = 1).
   * 0 on purpose: the add-on is a TIP on a pick, not a ranking boost. Measured
   * on the live menu (2026-10-10, 360 picks over mood × flavour × sweetness ×
   * kinds): at 0.75, 41.7% of picks were native flavour matches vs 60.6% at 0;
   * add-on items pushed out drinks that really are caramel or nutty while
   * rescuing almost no pick that matched nothing (22.8% → 20.0%). Even 0.15
   * cost 1.2 points of native matches for 0.6 rescued. At 0, ranking is exactly
   * as before and 16.7% of picks still carry a flavour add-on tip. */
  flavourFit: 0,
} as const;

// ---------------------------------------------------------------------------
// Checkout pairings (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4)
// ---------------------------------------------------------------------------

/** POST /api/suggest/pairings */
export interface PairingRequest {
  itemIds: string[]; // distinct menu item ids in the cart, ≤ PAIRING_LIMITS.cartItemsMax
}

export interface PairingPick {
  menuItemId: string;
  /** The cart item it goes with — named in the reason. */
  anchorItemId: string;
  reason: string; // ≤ PAIRING_LIMITS.reasonMaxChars, tone-linted
  score: number; // 0–1; for tests and logs, the UI ignores it
}

export interface PairingResponse {
  picks: PairingPick[]; // 0–PAIRING_LIMITS.picks
  /** Menu rows for the picks, shaped like /api/menu items. */
  items: import('@/lib/types').MenuItem[];
}

/** Co-order counts from recent order history (lib/suggest/pairings.ts
 * buildCoOrderStats). `pairs` is keyed by pairKey(a, b): the two ids sorted
 * and joined with '|'. */
export interface CoOrderStats {
  orders: number;
  itemOrders: Map<string, number>;
  pairs: Map<string, number>;
}

export const PAIRING_EVENTS = ['shown', 'added', 'ordered'] as const;
export type PairingEventType = (typeof PAIRING_EVENTS)[number];
/** What POST /api/suggest/pairings/events accepts; 'ordered' is server-written. */
export const CLIENT_PAIRING_EVENTS = ['shown', 'added'] as const satisfies readonly PairingEventType[];
export type ClientPairingEventType = (typeof CLIENT_PAIRING_EVENTS)[number];

/** pairing_events — mirrors supabase/2026-10-coffey-addons-pairings.sql. */
export interface PairingEventRow {
  id: string;
  anon_id: string | null;
  user_id: string | null;
  event: PairingEventType;
  menu_item_id: string | null;
  anchor_item_id: string | null;
  order_id: string | null;
  value_inr: number | null;
  created_at: string;
}

export const PAIRING_LIMITS = {
  picks: 3,
  cartItemsMax: 20,
  reasonMaxChars: 90,
  minScore: 0.35,
  minCoOrders: 3,
  historyDays: 90,
  historyMaxOrders: 5000,
  /** A pick's cheapest size may cost up to max(this, the dearest cart item's cheapest size). */
  minPriceCapInr: 150,
  ipRequestsPer10Min: 60,
  eventsPerRequest: 3,
  orderLinesMax: 5,
} as const;

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
  shortlist: 24,
  maxPerCategoryInShortlist: 8,
  refines: 2,
  excludeMax: 12,
  deciderTimeoutMs: 9000,
  profileWindowDays: 90,
  profileMaxOrders: 50,
  profileTtlHours: 24,
  ipRequestsPer10Min: 20,
  userRequestsPerDay: 60,
  orderSessionIdsMax: 5,
  eventSessionMaxAgeHours: 24,
} as const;
