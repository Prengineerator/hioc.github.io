// Phase 7 · SUG-2 + Coffey v2 — menu-trait tagging
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.1, docs/COFFEY-SPEC.md §3.2).
// Sends one item at a time to Jev — its name, category, parent_category,
// description, SIZES with prices and CUSTOMISATION groups with their options,
// plus a related item's description when its own is empty (no customer data,
// so S-3 doesn't apply here, but nothing here ever sees an order either) — then
// runs every row through lib/suggest/traitsValidate.ts before it is trusted
// (playbook S-2: model output is data). Jev is decision-only, not a batch
// JSON-writer, so it gets ONE systemOne call per item — every trait field is
// its own choice/score/noul question — through a concurrency-8 promise pool
// sharing one 50s budget, plus per-item low-confidence `needsReview` hints
// (§5.1 "Low-confidence review hints").
//
// Traits v2 (COFFEY-SPEC §3.2): ~70 questions per item (TRAIT_QUESTION_COUNT
// in lib/suggest/traitVocabulary.ts) fill 14 taste dimensions — the v1 nine
// plus a 0–10 sweetness, intensity, refreshment, indulgence, novelty, textures
// and a graded fit per mood. Every question carries concrete examples from THIS
// menu, because Jev can only be as sharp as its rubric: v1 tagged 114 of 117
// items "afternoon" and 60% at sweetness 3 (COFFEY-SPEC §0).
//
// 'server-only' — this is where TYPESAFE_API_KEY-backed calls happen
// (playbook S-1). The caller
// (app/api/owner/suggest/traits/generate/route.ts) owns the "which items need
// tagging" and "which columns may be written" decisions; this module only tags
// whatever it's given.

import 'server-only';
import { choice, noul, score, type JsonValue, type Question } from '@typesafe-ai/sdk';
import { getJevClient } from './jev';
import { costUsdMicros, deciderModelLabel, deciderProvider, jevModel } from './models';
import { legacySweetnessFromLevel } from './sweetness';
import { FLAVOR_VOCABULARY, MOOD_INFO, TEXTURES, TEXTURE_HINTS } from './traitVocabulary';
import { moodsFromFit, roundFit, validateModelTraitRowsV2, MAX_TEXTURES, MOOD_FIT_MAX, SWEETNESS_LEVEL_MAX, TRAIT_SCORE_MAX, type ValidatedTraitRowV2 } from './traitsValidate';
import { CURRENT_TRAITS_VERSION, DAYPARTS, MOODS, type Daypart, type Mood } from './types';

export interface MenuItemForTagging {
  id: string;
  name: string;
  description: string;
  category: string;
  parent_category: string;
  /** Every size the item is sold in, e.g. { label: 'Regular', price_inr: 180 }. */
  sizes: { label: string; price_inr: number }[];
  /** The item's add-on groups: the group's display name and its option names,
   * e.g. { group: 'Choice of Sugar', options: ['Stevia (sugarfree)', 'Brown Sugar', 'No Sugar', 'Normal'] }. */
  customisations: { group: string; options: string[] }[];
  /** Another menu item's NAME and description — `From the related menu item
   * "Oreo-Heaven": <description>` — filled in by withRelatedDescriptions() when
   * this item's own description is empty. The name travels with the text so
   * Jev knows it describes a different item. */
  related_description?: string;
}

export interface TagTraitsUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsdMicros: number;
}

export interface TagTraitsResult {
  /** Full v1 + v2 rows (COFFEY-SPEC §3.2), each stamped CURRENT_TRAITS_VERSION. */
  rows: ValidatedTraitRowV2[];
  usage: TagTraitsUsage;
  /** Calls sent — one per item (see the module doc comment). */
  batches: number;
  /** Items whose call errored, timed out, failed validation, or never got to
   * start before the shared time budget ran out — they simply aren't in
   * `rows`; the caller decides what to do next. */
  failedBatches: number;
  /** The first per-item failure message, e.g. a 401 for a bad key or a 429
   * rate limit — surfaced by the owner-facing generate route even on a
   * PARTIAL success (some rows tagged, some not), so the "Generate" result is
   * always actionable rather than a bare "N of 120 tagged". Never contains an
   * API key (S-6). */
  firstError?: string;
  /** §5.1 "Low-confidence review hints" (COFFEY-SPEC §3.2) — item NAMES (not
   * ids; the owner-facing route has no other use for the id here) whose
   * temperature/caffeine/kind choice confidence was < 0.6, whose is_coffee noul
   * landed in the uncertain 0.35–0.65 band, or whose sweetness confidence was
   * < 0.5. No DB column — display-only. */
  needsReview: string[];
}

// Jev tags ONE item per systemOne call (it can't write a batch of JSON rows —
// it only answers structured questions about ONE state), through a
// CONCURRENCY-8 promise pool sharing one 50s budget. An item not started
// before the budget runs out counts as failed — not called; the owner simply
// presses Regenerate again, and the rows that are still below the current
// trait version are worked first (the caller decides that — this module never
// does).
const JEV_CONCURRENCY = 8;
const JEV_BUDGET_MS = 50000;
// Raised from 10s for v2: ~70 questions plus sizes and customisations is a
// bigger request than v1's ~40. Still capped by whatever is left of the shared
// budget (see tagWithJev).
const JEV_PER_ITEM_TIMEOUT_MS = 15000;
// The SDK's timeout is PER ATTEMPT and there is one retry, so on its own an
// item started late in the budget could run to ~2x its timeout — past the
// route's 60s maxDuration, which would lose the whole run. Every call also
// carries a signal that aborts this long after the budget ends, so nothing
// outlives (budget + grace).
const JEV_DEADLINE_GRACE_MS = 5000;
const JEV_BUDGET_EXHAUSTED = 'jev trait tagging: overall time budget exhausted';

const JEV_LOW_CONFIDENCE_THRESHOLD = 0.6;
const JEV_UNCERTAIN_NOUL_LOW = 0.35;
const JEV_UNCERTAIN_NOUL_HIGH = 0.65;
const JEV_SWEETNESS_LOW_CONFIDENCE = 0.5;
/** COFFEY-SPEC §3.2: is_coffee is true at P >= 0.5. */
const IS_COFFEE_THRESHOLD = 0.5;
/** COFFEY-SPEC §3.2: dayparts, textures and flavour notes are kept at P >= 0.6. */
const KEEP_PROBABILITY = 0.6;
const MAX_DAYPARTS = 3;
const MAX_FLAVOR_NOTES = 5;

/** A small index-based promise pool: `concurrency` workers each pull the next
 * unclaimed index until the list is exhausted. Never-reached indices are left
 * `undefined` in the returned array. */
async function runPool<T>(count: number, concurrency: number, run: (index: number) => Promise<T>): Promise<(T | undefined)[]> {
  // .fill(undefined), not a bare `new Array(count)`: the latter leaves real
  // holes, which Array.prototype.map() SKIPS.
  const results: (T | undefined)[] = new Array(count).fill(undefined);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= count) return;
      results[i] = await run(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Related descriptions (COFFEY-SPEC §3.2): 49 of 117 items have no description
// (waffle crepes, chips, cupcakes, cheesecakes…), so the tagger would have only
// the name to go on. "Oreo Heaven Cupcake" borrows the description of the
// "Oreo-Heaven" waffle.
// ---------------------------------------------------------------------------

/** Words that are never distinctive: they name a kind of item — or an
 * ingredient so common on this menu that sharing it says nothing — not a
 * specific flavour ("Iced Latte" is not related to "Iced Americano", and
 * "White Truffle Slice" is not related to "Flat White"). The first eighteen are
 * COFFEY-SPEC §3.2's; the last ten were added after running this over the real
 * menu (white, dark, honey, choco, chocolate, berry, orange, truffle, cream,
 * milk each linked unrelated items). */
const GENERIC_NAME_TOKENS = [
  'waffle', 'waffles', 'creme', 'crepes', 'chips', 'cupcake', 'slice', 'iced', 'latte',
  'signature', 'hioc', 'stuffed', 'cheesecake', 'cold', 'brew', 'hot', 'with', 'and',
  'white', 'dark', 'honey', 'choco', 'chocolate', 'berry', 'orange', 'truffle', 'cream', 'milk',
];

/** Tokens shorter than this are noise: the stray "s" of "Hioc's" or "Devil's"
 * would otherwise relate every possessive on the menu to every other. */
const MIN_TOKEN_LETTERS = 3;

/** A plural "s" is stripped from tokens of 5 or more letters
 * ("waffles" → "waffle", "brownies" → "brownie"). */
function singularToken(token: string): string {
  return token.length >= 5 && token.endsWith('s') ? token.slice(0, -1) : token;
}

/** Lowercase, accents dropped ("Crème" → "creme"), split on non-letters, plural
 * "s" stripped. Order-preserving, de-duplicated. */
function nameTokens(name: string): string[] {
  const words = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .map(singularToken);
  return [...new Set(words)];
}

// Normalised the same way as the tokens, so "chips" (→ "chip") is generic
// whichever spelling a name uses.
const GENERIC_TOKEN_SET = new Set(GENERIC_NAME_TOKENS.map(singularToken));

/** A name split into the words that identify a flavour or a dish
 * (`distinctive`) and the words that only name a kind of item (`generic`). */
function classifiedTokens(name: string): { distinctive: Set<string>; generic: Set<string> } {
  const distinctive = new Set<string>();
  const generic = new Set<string>();
  for (const token of nameTokens(name)) {
    if (token.length < MIN_TOKEN_LETTERS) continue;
    (GENERIC_TOKEN_SET.has(token) ? generic : distinctive).add(token);
  }
  return { distinctive, generic };
}

function hasDescription(item: { description: string }): boolean {
  return item.description.trim() !== '';
}

/** Name order for the last tie-break: case-insensitive, then exact, then id —
 * total, so the result never depends on the order the menu happened to load in. */
function byName(a: MenuItemForTagging, b: MenuItemForTagging): number {
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const token of a) if (b.has(token)) n++;
  return n;
}

interface RelatedCandidate<T> {
  item: T;
  /** Distinctive tokens shared with the item being filled — the ranking. */
  shared: number;
  /** Distinctive tokens the candidate has that the item does not. */
  extra: number;
  /** Generic words (latte, iced, cupcake…) shared with the item. */
  sharedGeneric: number;
}

/** True when `a` is the better source of a borrowed description than `b`.
 * Most shared distinctive tokens wins (COFFEY-SPEC §3.2). Ties go to the
 * CLOSEST name — fewest distinctive words the item doesn't have, then most
 * generic words in common — and only then to name order. That is what makes
 * "Nutella Stuffed" borrow from the "Nutella" waffle rather than from whichever
 * Nutella item sorts first ("Minion Creme (Nutella-Banana)"). */
function isBetterSource<T extends MenuItemForTagging>(a: RelatedCandidate<T>, b: RelatedCandidate<T>): boolean {
  if (a.shared !== b.shared) return a.shared > b.shared;
  if (a.extra !== b.extra) return a.extra < b.extra;
  if (a.sharedGeneric !== b.sharedGeneric) return a.sharedGeneric > b.sharedGeneric;
  return byName(a.item, b.item) < 0;
}

/** What an item borrows: the source item's NAME with its description, so Jev
 * knows the text describes a different item — `From the related menu item
 * "Oreo-Heaven": <description>`. (A double quote in a name would break the
 * quoting, so it becomes a single one.) */
function borrowedDescription(source: MenuItemForTagging): string {
  return `From the related menu item "${source.name.replace(/"/g, "'")}": ${source.description.trim()}`;
}

/**
 * For every item with an EMPTY description, finds another item that has one
 * and shares a distinctive name token, and puts that item's name and
 * description (see borrowedDescription) into `related_description`. The related
 * item is the one sharing the MOST distinctive tokens; ties go to the closest
 * name, then break by name (see isBetterSource). Pure: returns new objects for
 * items it fills, leaves every other item as it was, keeps the input order.
 *
 * Pass the WHOLE menu, not just the items being tagged — the description an
 * item borrows usually belongs to one that is not being re-tagged.
 */
export function withRelatedDescriptions<T extends MenuItemForTagging>(items: T[]): T[] {
  const described = items.filter(hasDescription).map((item) => ({ item, tokens: classifiedTokens(item.name) }));
  return items.map((item) => {
    if (hasDescription(item)) return item;
    const mine = classifiedTokens(item.name);
    if (mine.distinctive.size === 0) return item;

    let best: RelatedCandidate<T> | null = null;
    for (const cand of described) {
      if (cand.item.id === item.id) continue;
      const shared = overlap(mine.distinctive, cand.tokens.distinctive);
      if (shared === 0) continue;
      const candidate: RelatedCandidate<T> = {
        item: cand.item,
        shared,
        extra: cand.tokens.distinctive.size - shared,
        sharedGeneric: overlap(mine.generic, cand.tokens.generic),
      };
      if (!best || isBetterSource(candidate, best)) best = candidate;
    }
    return best ? { ...item, related_description: borrowedDescription(best.item) } : item;
  });
}

// ---------------------------------------------------------------------------
// What Jev is shown about an item.
// ---------------------------------------------------------------------------

const JEV_CAFE_DESCRIPTION = 'HIOC. — a pure-vegetarian coffee and waffle café in Agra, India.';

/** The `state` of one systemOne call (COFFEY-SPEC §3.2): the café, then the
 * item with its sizes (`"Regular ₹180"`) and customisation groups
 * (`"Choice of Sugar: Stevia (sugarfree), Brown Sugar, No Sugar, Normal"`).
 * `related_description` is only present when there is one. */
export function buildJevTraitState(item: MenuItemForTagging): Record<string, JsonValue> {
  const state: Record<string, JsonValue> = {
    name: item.name,
    category: item.category,
    parent_category: item.parent_category,
    description: item.description,
  };
  if (item.related_description && item.related_description.trim() !== '') state.related_description = item.related_description;
  state.sizes = item.sizes.map((s) => `${s.label} ₹${s.price_inr}`);
  state.customisations = item.customisations
    .filter((g) => g.options.length > 0)
    .map((g) => `${g.group}: ${g.options.join(', ')}`);
  return { cafe: JEV_CAFE_DESCRIPTION, item: state };
}

// ---------------------------------------------------------------------------
// The questions (COFFEY-SPEC §3.2). Jev can't write free-form JSON rows, so
// every field is its own choice/score/noul question; the answers are assembled
// into a trait row and run through validateModelTraitRowsV2() like any other
// model output. The wording below is deliberate — the examples come from this
// menu (see COFFEY-SPEC §0 for what the v1 wording got wrong).
// ---------------------------------------------------------------------------

const JEV_TEMPERATURE_CRITERIA = {
  hot: 'Served hot.',
  iced: 'Served cold or over ice — iced coffees, cold brews, cremes and shakes.',
  either: 'A drink the café offers both hot and iced.',
  ambient: 'Food or a dessert — no drink serving temperature applies.',
};

const JEV_CAFFEINE_CRITERIA = {
  none: 'No caffeine at all — no coffee, tea or matcha. This ALWAYS includes chocolate, cocoa, Nutella, Oreo, KitKat and hot chocolate, which contain no caffeine however rich they taste; also fruit coolers and food or desserts made without coffee.',
  low: 'A little caffeine — a milky tea, chai or matcha drink, or a dessert made with coffee such as tiramisu.',
  medium: 'A moderate amount — a milky coffee (latte, cappuccino, flat white, mocha, a coffee creme or frappé), or a strong tea or matcha.',
  high: 'A lot — espresso-forward coffee: espresso, americano, long black, macchiato, espresso on the rocks, cold brew.',
};

const JEV_IS_COFFEE_CRITERIA = {
  true: 'Made with espresso, cold brew or coffee — including mochas, coffee cremes, tiramisu and affogato.',
  false: 'No coffee at all — chocolate, tea, matcha, fruit, plain dairy, or food without coffee.',
};

const JEV_KIND_CRITERIA = {
  drink: 'Anything you drink, including thick shakes and cremes; an affogato counts as a drink.',
  dessert: 'A sweet food — waffles, crepes, cupcakes, cheesecakes, sundaes, brownies, sweet croissants.',
  food: 'A savoury food — sandwiches, nachos, garlic bread, a plain butter croissant.',
};

// Unchanged from v1.
const JEV_BODY_CRITERIA = {
  light: 'Light-bodied — or, for food/dessert, a light portion.',
  medium: 'Medium-bodied — or, for food/dessert, a medium portion.',
  rich: 'Rich, heavy-bodied — or, for food/dessert, a hearty, filling portion.',
};

// Six anchors, 0–5: stored as clamp(round(score × 2), 0, 10) = sweetness_level.
const JEV_SWEETNESS_CRITERIA = [
  'Not sweet at all — e.g. espresso, americano, long black, black cold brew, garlic bread, nachos, a savoury sandwich.',
  'Barely sweet — only the natural sweetness of milk; e.g. an unsweetened cappuccino, latte or flat white.',
  'Lightly sweet — e.g. a matcha or chai latte, a plain butter croissant, a lightly flavoured latte.',
  'Moderately sweet — e.g. a mocha, a caramel or hazelnut latte, a fruit iced tea or lemonade.',
  'Sweet — e.g. a creamy blended cold coffee, a hot chocolate, a cupcake, a fruit cheesecake.',
  'Very sweet, dessert-level — e.g. Nutella, Oreo or KitKat shakes, loaded chocolate waffles, brownies, sundaes.',
] as const;

const JEV_INTENSITY_CRITERIA = [
  'Gentle and mild — e.g. a plain milky drink, vanilla, a soft sponge.',
  'Mellow — e.g. a latte, a creamy vanilla shake.',
  'Full-flavoured — e.g. a cappuccino, a mocha, a chai latte, a chocolate waffle.',
  'Bold and intense — e.g. an espresso, an americano, a cold brew, dark chocolate, garlic.',
] as const;

const JEV_REFRESHMENT_CRITERIA = [
  'Not refreshing — heavy, warm or filling (a hot chocolate, a loaded waffle).',
  'A little refreshing — cold but rich and creamy (a thick cold-coffee shake).',
  'Refreshing — cold and fairly light (an iced latte, a cold brew).',
  'Very refreshing — cold, light, often fruity or fizzy (an iced americano, a lemonade, an espresso tonic).',
] as const;

const JEV_INDULGENCE_CRITERIA = [
  'Everyday and simple — an espresso, an americano, a plain croissant.',
  'A small comfort — a latte, a cappuccino, a chai latte.',
  'A treat — a mocha, a flavoured creme, a cupcake.',
  'A real indulgence — a loaded waffle, a Nutella or Oreo shake, a brownie sundae, a cheesecake.',
] as const;

const JEV_NOVELTY_CRITERIA = [
  'An everyday classic — a cappuccino, a latte, a hot chocolate, garlic bread.',
  'Familiar with a twist — a hazelnut latte, a caramel creme, a Nutella waffle.',
  'Distinctive — a Biscoff latte, a rose latte, a matcha drink, a Vietnamese latte.',
  'Adventurous — an unusual pairing like cranberry coffee, orange espresso, blueberry matcha or a spiced orange cooler.',
] as const;

// One per mood in MOODS, asked as "A customer who <need>. How well does this
// item suit them?" — the same MOOD_INFO[m].need the wizard's cards cover.
const JEV_MOOD_FIT_CRITERIA = [
  'Not a fit for this feeling.',
  'Could work for this feeling.',
  'A good fit for this feeling.',
  'An ideal pick for this feeling.',
] as const;

const JEV_DAYPART_QUESTIONS: Record<Daypart, string> = {
  morning: 'Would a customer naturally order this in the morning (6am–noon), e.g. with breakfast or to start the day?',
  afternoon: 'Would a customer naturally order this in the afternoon (noon–5pm)?',
  evening: 'Would a customer naturally order this in the evening (5pm–9pm), e.g. an after-work treat or a hangout with friends?',
  late: 'Would a customer naturally order this late at night (after 9pm)? Late-night picks usually have little or no caffeine, or are a dessert.',
};

/**
 * Every question Jev answers about one item — `TRAIT_QUESTION_COUNT` of them
 * (10 single-answer fields, then a fit per mood, a daypart each, a texture each
 * and a note each of FLAVOR_VOCABULARY). Keys: `temperature`, `caffeine`,
 * `is_coffee`, `kind`, `body`, `sweetness`, `intensity`, `refreshment`,
 * `indulgence`, `novelty`, `mood_<mood>`, `daypart_<daypart>`, `texture_<texture>`
 * and `flavor_<index>` — the INDEX into FLAVOR_VOCABULARY, not the note, since
 * notes contain spaces. Pure.
 */
export function buildJevTraitQuestions(): Record<string, Question> {
  const questions: Record<string, Question> = {
    temperature: choice("The item's serving temperature.", JEV_TEMPERATURE_CRITERIA),
    caffeine: choice("The item's caffeine level.", JEV_CAFFEINE_CRITERIA),
    is_coffee: noul('Is this item coffee-based (made with espresso or coffee)?', JEV_IS_COFFEE_CRITERIA),
    kind: choice('What kind of menu item this is.', JEV_KIND_CRITERIA),
    body: choice("The item's body/heaviness (portion heaviness for food/dessert).", JEV_BODY_CRITERIA),
    sweetness: score(
      'How sweet is this item as the kitchen makes it — NOT counting any optional table sugar the customer can choose to add?',
      JEV_SWEETNESS_CRITERIA,
    ),
    intensity: score('How bold or strong is its flavour?', JEV_INTENSITY_CRITERIA),
    refreshment: score('How refreshing and thirst-quenching is it?', JEV_REFRESHMENT_CRITERIA),
    indulgence: score('How much of a treat is it?', JEV_INDULGENCE_CRITERIA),
    novelty: score('How unusual would this feel to a typical café-goer in India?', JEV_NOVELTY_CRITERIA),
  };
  for (const mood of MOODS) {
    questions[`mood_${mood}`] = score(`A customer who ${MOOD_INFO[mood].need}. How well does this item suit them?`, JEV_MOOD_FIT_CRITERIA);
  }
  for (const daypart of DAYPARTS) questions[`daypart_${daypart}`] = noul(JEV_DAYPART_QUESTIONS[daypart]);
  for (const texture of TEXTURES) {
    questions[`texture_${texture}`] = noul(`Is this item's texture noticeably ${TEXTURE_HINTS[texture] ?? texture}?`);
  }
  FLAVOR_VOCABULARY.forEach((flavor, index) => {
    questions[`flavor_${index}`] = noul(`Does this item noticeably taste of ${flavor.hint ?? flavor.note}?`);
  });
  return questions;
}

// ---------------------------------------------------------------------------
// Answers → a trait row (COFFEY-SPEC §3.2, "stored as").
// ---------------------------------------------------------------------------

export type JevAnswer = { choice?: string; confidence?: number; noul?: number; score?: number };
export type JevAnswers = Record<string, JevAnswer | undefined>;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** The entries at or above `min`, highest first (ties keep list order — the
 * sort is stable), at most `max`. */
function keepAbove<T>(entries: { value: T; p: number }[], min: number, max: number): T[] {
  return entries
    .filter((e) => e.p >= min)
    .sort((a, b) => b.p - a.p)
    .slice(0, max)
    .map((e) => e.value);
}

/** The single highest-probability entry (ties keep list order). */
function bestOf<T>(entries: { value: T; p: number }[]): T {
  return entries.reduce((best, e) => (e.p > best.p ? e : best)).value;
}

/**
 * One item's answers → its full v1 + v2 row, run through
 * validateModelTraitRowsV2 (S-2). Returns null when a required answer is
 * missing or out of vocabulary — e.g. Jev picked a label that isn't one of the
 * criteria. Pure.
 *
 *  - is_coffee: P(yes) >= 0.5.
 *  - sweetness_level = clamp(round(score × 2), 0, 10); the legacy 0–3
 *    `sweetness` is DERIVED from it (legacySweetnessFromLevel).
 *  - intensity, refreshment, indulgence, novelty = clamp(round(score), 0, 3).
 *  - mood_fit[m] = score rounded to one decimal, for every mood; `moods` = the
 *    moods with fit >= 2, best first, at most three — or the single best.
 *  - dayparts: P >= 0.6, best first, at most three — or the single best.
 *  - textures: P >= 0.6, best first, at most three.
 *  - flavor_notes: P >= 0.6, best first, at most five, by FLAVOR_VOCABULARY note.
 */
export function traitRowFromAnswers(itemId: string, a: JevAnswers): ValidatedTraitRowV2 | null {
  const sweetnessLevel = clamp(Math.round((a.sweetness?.score ?? 0) * 2), 0, SWEETNESS_LEVEL_MAX);
  const scale = (key: string) => clamp(Math.round(a[key]?.score ?? 0), 0, TRAIT_SCORE_MAX);

  const moodFit: Partial<Record<Mood, number>> = {};
  for (const mood of MOODS) moodFit[mood] = roundFit(clamp(a[`mood_${mood}`]?.score ?? 0, 0, MOOD_FIT_MAX));

  const daypartEntries = DAYPARTS.map((d) => ({ value: d, p: a[`daypart_${d}`]?.noul ?? 0 }));
  const dayparts = keepAbove(daypartEntries, KEEP_PROBABILITY, MAX_DAYPARTS);

  const rawRow = {
    menu_item_id: itemId,
    temperature: a.temperature?.choice,
    caffeine: a.caffeine?.choice,
    is_coffee: (a.is_coffee?.noul ?? 0) >= IS_COFFEE_THRESHOLD,
    sweetness: legacySweetnessFromLevel(sweetnessLevel),
    body: a.body?.choice,
    kind: a.kind?.choice,
    moods: moodsFromFit(moodFit),
    dayparts: dayparts.length > 0 ? dayparts : [bestOf(daypartEntries)],
    flavor_notes: keepAbove(
      FLAVOR_VOCABULARY.map((f, i) => ({ value: f.note, p: a[`flavor_${i}`]?.noul ?? 0 })),
      KEEP_PROBABILITY,
      MAX_FLAVOR_NOTES,
    ),
    sweetness_level: sweetnessLevel,
    intensity: scale('intensity'),
    refreshment: scale('refreshment'),
    indulgence: scale('indulgence'),
    novelty: scale('novelty'),
    textures: keepAbove(
      TEXTURES.map((t) => ({ value: t, p: a[`texture_${t}`]?.noul ?? 0 })),
      KEEP_PROBABILITY,
      MAX_TEXTURES,
    ),
    mood_fit: moodFit,
    traits_version: CURRENT_TRAITS_VERSION,
  };
  const [row] = validateModelTraitRowsV2([rawRow], new Set([itemId]));
  return row ?? null;
}

/** COFFEY-SPEC §3.2 "Needs review" (display-only): the temperature, caffeine or
 * kind choice confidence is < 0.6, OR is_coffee is in (0.35, 0.65), OR the
 * sweetness score's confidence is < 0.5. */
export function jevNeedsReview(a: JevAnswers): boolean {
  const confidence = (key: string) => a[key]?.confidence ?? 1;
  const isCoffee = a.is_coffee?.noul ?? 0;
  return (
    confidence('temperature') < JEV_LOW_CONFIDENCE_THRESHOLD ||
    confidence('caffeine') < JEV_LOW_CONFIDENCE_THRESHOLD ||
    confidence('kind') < JEV_LOW_CONFIDENCE_THRESHOLD ||
    (isCoffee > JEV_UNCERTAIN_NOUL_LOW && isCoffee < JEV_UNCERTAIN_NOUL_HIGH) ||
    confidence('sweetness') < JEV_SWEETNESS_LOW_CONFIDENCE
  );
}

interface JevItemOutcome {
  row: ValidatedTraitRowV2 | null;
  needsReviewName: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  error?: string;
}

async function tagOneItemWithJev(
  client: NonNullable<ReturnType<typeof getJevClient>>,
  model: string,
  questions: Record<string, Question>,
  item: MenuItemForTagging,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<JevItemOutcome> {
  try {
    const result = await client.systemOne(
      { state: buildJevTraitState(item), questions, model },
      { timeout: timeoutMs, retry: { maxRetries: 1 }, signal },
    );
    const answers = result.answers as unknown as JevAnswers;
    const row = traitRowFromAnswers(item.id, answers);
    return {
      row,
      needsReviewName: row && jevNeedsReview(answers) ? item.name : null,
      usage: { inputTokens: result.usage?.input_tokens ?? 0, outputTokens: result.usage?.output_tokens ?? 0 },
    };
  } catch (err) {
    console.error('tagMenuItemTraits: jev item failed', err);
    // An abort here is the shared deadline, not a Jev fault — say so.
    const message = signal.aborted ? JEV_BUDGET_EXHAUSTED : err instanceof Error ? err.message : String(err);
    return { row: null, needsReviewName: null, usage: null, error: message };
  }
}

async function tagWithJev(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  const client = getJevClient();
  if (!client) throw new Error('TYPESAFE_API_KEY is not set');

  const model = jevModel();
  const questions = buildJevTraitQuestions();
  const startedAt = Date.now();

  const outcomes = await runPool<JevItemOutcome>(
    items.length,
    JEV_CONCURRENCY,
    async (i) => {
      const remainingMs = JEV_BUDGET_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        return { row: null, needsReviewName: null, usage: null, error: JEV_BUDGET_EXHAUSTED };
      }
      return tagOneItemWithJev(
        client,
        model,
        questions,
        items[i],
        Math.min(remainingMs, JEV_PER_ITEM_TIMEOUT_MS),
        AbortSignal.timeout(remainingMs + JEV_DEADLINE_GRACE_MS),
      );
    },
  );

  const rows: ValidatedTraitRowV2[] = [];
  const needsReview: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let failedItems = 0;
  let firstError: string | undefined;

  for (const o of outcomes) {
    const outcome = o ?? { row: null, needsReviewName: null, usage: null, error: 'jev trait tagging: item never started' };
    if (outcome.usage) {
      inputTokens += outcome.usage.inputTokens;
      outputTokens += outcome.usage.outputTokens;
    }
    if (outcome.row) {
      rows.push(outcome.row);
      if (outcome.needsReviewName) needsReview.push(outcome.needsReviewName);
    } else {
      failedItems++;
      if (!firstError && outcome.error) firstError = outcome.error;
    }
  }

  const label = deciderModelLabel();
  return {
    rows,
    usage: {
      inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens,
      costUsdMicros: costUsdMicros(label, { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens }),
    },
    batches: items.length,
    failedBatches: failedItems,
    firstError,
    needsReview,
  };
}

/** Tags a batch of menu items with Jev (§1). Throws only when TYPESAFE_API_KEY
 * is not set (or the SUGGEST_LLM kill switch is off) — per-item call/parse
 * failures are absorbed into `failedBatches`/`firstError`/`needsReview`. */
export async function tagMenuItemTraits(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  if (deciderProvider() !== 'jev') throw new Error('TYPESAFE_API_KEY is not set');
  return tagWithJev(items);
}
