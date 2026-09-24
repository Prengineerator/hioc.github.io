// Phase 7 · SUG-2 — menu-trait tagging (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5.1). Sends items (id, name, description, category, parent_category — no
// customer data, so S-3 doesn't apply here, but nothing here ever sees an
// order either) to the active decider provider (Jev, or Opus, or Gemini Flash
// when configured — §1), then runs every row through
// lib/suggest/traitsValidate.ts before it is trusted (playbook S-2: model
// output is data). All three providers share the exact same allow-lists
// (imported, not retyped) and validateOpusTraitRows() call; only the
// transport, question/prompt shape and batching strategy differ:
//   - Anthropic (Opus): batches of 40 items, ~3 batches run concurrently.
//   - Gemini (free tier): batches of 15 items, a concurrency-4 promise pool,
//     all sharing one 50s budget — fast enough that the owner isn't stuck
//     waiting a full minute for ~40 items (see GEMINI_BATCH_SIZE below).
//   - Jev: ONE systemOne call per item (Jev is decision-only, not a batch
//     JSON-writer), a concurrency-8 promise pool sharing one 50s budget, plus
//     per-item low-confidence `needsReview` hints (§5.1 "Low-confidence
//     review hints").
//
// 'server-only' — this is where TYPESAFE_API_KEY/ANTHROPIC_API_KEY/GEMINI_API_KEY-backed
// calls happen (playbook S-1). The caller
// (app/api/owner/suggest/traits/generate/route.ts) owns the "which items need
// tagging" and "upsert, never overwrite confirmed" decisions; this module
// only tags whatever it's given.

import { toAnthropicSchema } from './schema';
import 'server-only';
import { choice, noul, score } from '@typesafe-ai/sdk';
import { getAnthropicClient } from './anthropic';
import { geminiGenerateJson } from './gemini';
import { getJevClient } from './jev';
import { costUsdMicros, deciderModel, deciderModelLabel, deciderProvider, geminiModel, jevModel } from './models';
import { DAYPARTS, MOODS, type Daypart, type Mood } from './types';
import { TRAIT_BODY, TRAIT_CAFFEINE, TRAIT_KIND, TRAIT_TEMPERATURES, validateOpusTraitRows, type ValidatedTraitRow } from './traitsValidate';

export interface MenuItemForTagging {
  id: string;
  name: string;
  description: string;
  category: string;
  parent_category: string;
}

export interface TagTraitsUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsdMicros: number;
}

export interface TagTraitsResult {
  rows: ValidatedTraitRow[];
  usage: TagTraitsUsage;
  /** Batches sent (Jev: one per item — see the module doc comment). */
  batches: number;
  /** Batches that errored, timed out, weren't `end_turn`, didn't parse, or
   * (Jev/Gemini) never got to start before the shared time/rate-limit budget
   * ran out — their items simply aren't in `rows`; the caller decides what to
   * do next. */
  failedBatches: number;
  /** The first per-batch failure message, e.g. a wrong Gemini model id or a
   * 429 quota error — surfaced by the owner-facing generate route even on a
   * PARTIAL success (some rows tagged, some not), so the "Generate" result is
   * always actionable rather than a bare "N of 120 tagged". Never contains an
   * API key (S-6). */
  firstError?: string;
  /** Jev only (§5.1 "Low-confidence review hints") — item NAMES (not ids;
   * the owner-facing route has no other use for the id here) whose
   * temperature/caffeine/kind choice confidence was < 0.6, or whose
   * is_coffee noul landed in the uncertain 0.35–0.65 band. Empty for the
   * Anthropic/Gemini paths, which don't carry a comparable per-field
   * confidence signal into this result. No DB column — display-only. */
  needsReview: string[];
}

// Anthropic: small batches, all sent at once. One Opus request writing traits
// for 40 items can run past the 50 s budget (then the whole batch is lost and
// every click makes zero progress); 12 items per request keeps each call well
// inside it, and ~10 parallel requests is far below any API tier's rate limit.
const ANTHROPIC_BATCH_SIZE = 12;
const MAX_TOKENS = 16000;
const ANTHROPIC_TIMEOUT_MS = 50000; // under the route's 60 s maxDuration, leaving time to upsert

// Gemini's free tier batches run through a small CONCURRENCY-4 promise pool —
// small batches (15 items, vs. Anthropic's 40) get through several times
// faster than the old fully-sequential 40-item-batch approach, which owners
// reported taking a full minute for ~40 items. All batches share one 50s
// budget; each call's own timeout is whatever's left of that budget, floored
// at 10s so a late-starting batch still gets a fair shot rather than a
// near-zero window. A 429 (rate limit) from any batch stops new batches from
// starting — everything already tagged is kept — since concurrent requests
// against the free tier's ~10/min limit are the most likely way to trip it.
const GEMINI_BATCH_SIZE = 15;
const GEMINI_CONCURRENCY = 4;
const GEMINI_BUDGET_MS = 50000;
const GEMINI_MIN_TIMEOUT_MS = 10000;
const GEMINI_RATE_LIMIT_MESSAGE =
  "Gemini's free-tier limit was reached. Everything tagged so far is saved; wait a minute and click Generate again.";

// Jev tags ONE item per systemOne call (it can't write a batch of JSON rows —
// it only answers structured questions about ONE state), through a
// CONCURRENCY-8 promise pool sharing one 50s budget. An item not started
// before the budget runs out counts as failed — not called — same posture as
// Gemini's budget exhaustion above; the owner simply clicks Generate again,
// and only missing/unconfirmed items are ever re-tagged (this module never
// decides that — the caller does).
const JEV_CONCURRENCY = 8;
const JEV_BUDGET_MS = 50000;
const JEV_PER_ITEM_TIMEOUT_MS = 10000;
// Jev has no free-form text output, so flavor_notes is a FIXED vocabulary —
// one noul ("does this item taste of X?") per word, kept when noul ≥ 0.6,
// highest-probability first, capped at 5 (§5.1).
export const JEV_FLAVOR_VOCABULARY = [
  'chocolate',
  'caramel',
  'hazelnut',
  'vanilla',
  'coffee-forward',
  'nutty',
  'fruity',
  'berry',
  'citrus',
  'mango',
  'strawberry',
  'creamy',
  'biscuit',
  'cinnamon',
  'honey',
  'floral',
  'matcha',
  'spiced',
  'cheesy',
  'savoury',
] as const;
const JEV_LOW_CONFIDENCE_THRESHOLD = 0.6;
const JEV_UNCERTAIN_NOUL_LOW = 0.35;
const JEV_UNCERTAIN_NOUL_HIGH = 0.65;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// The schema's enums are the SAME arrays traitsValidate.ts checks against —
// imported, not retyped, so the two can never drift apart.
const TRAIT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['menu_item_id', 'temperature', 'caffeine', 'is_coffee', 'sweetness', 'body', 'kind', 'moods', 'dayparts', 'flavor_notes'],
  properties: {
    menu_item_id: { type: 'string', description: "Copied exactly from the item's id in the batch." },
    temperature: { type: 'string', enum: TRAIT_TEMPERATURES },
    caffeine: { type: 'string', enum: TRAIT_CAFFEINE },
    is_coffee: { type: 'boolean' },
    sweetness: { type: 'integer', minimum: 0, maximum: 3 },
    body: { type: 'string', enum: TRAIT_BODY },
    kind: { type: 'string', enum: TRAIT_KIND },
    moods: { type: 'array', items: { type: 'string', enum: MOODS }, maxItems: MOODS.length },
    dayparts: { type: 'array', items: { type: 'string', enum: DAYPARTS }, maxItems: DAYPARTS.length },
    flavor_notes: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
} as const;

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', items: TRAIT_ITEM_SCHEMA },
  },
} as const;

// Anthropic rejects minimum/maximum/maxItems (lib/suggest/schema.ts). Those
// rules move into the field descriptions and are enforced after the reply by
// validateOpusTraitRows.
export const ANTHROPIC_OUTPUT_SCHEMA = toAnthropicSchema(OUTPUT_SCHEMA);

// A model may propose more than MAX flavour notes once maxItems isn't
// enforced by the schema; trim the extras instead of letting the validator
// discard the whole item's row over them.
const MAX_MODEL_FLAVOR_NOTES = 5;
function capFlavorNotes(items: unknown): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((it) =>
    it && typeof it === 'object' && Array.isArray((it as { flavor_notes?: unknown }).flavor_notes)
      ? { ...(it as object), flavor_notes: (it as { flavor_notes: unknown[] }).flavor_notes.slice(0, MAX_MODEL_FLAVOR_NOTES) }
      : it,
  );
}

const SYSTEM_PROMPT = [
  'You are a barista tagging real cafe menu items with objective taste facts an ordering engine relies on.',
  'For EVERY item given, return exactly one object with these fields:',
  '- menu_item_id: the id given for that item, copied exactly — never invent one.',
  '- temperature: "hot", "iced", "either" (served both ways), or "ambient" (food/dessert — no serving temperature).',
  '- caffeine: "none", "low", "medium", or "high". Chocolate, cocoa, Nutella, Oreo and hot chocolate are ALWAYS "none" — they contain no caffeine, regardless of how rich or intense they taste. Only coffee/espresso drinks (usually "medium" or "high") and tea/matcha/chai drinks (usually "low" or "medium") ever carry caffeine.',
  '- is_coffee: true only for coffee-based drinks; false for tea, other drinks, food and desserts.',
  '- sweetness: an integer 0-3 (0 = unsweetened/savoury, 3 = very sweet).',
  '- body: "light", "medium", or "rich" — for food/dessert this is portion heaviness, not taste.',
  '- kind: "drink", "food", or "dessert".',
  '- moods: the subset of ["boost","cosy","celebrate","comfort","cool","surprise"] this item suits (can be empty).',
  '- dayparts: the subset of ["morning","afternoon","evening","late"] it is usually ordered in (can be empty).',
  '- flavor_notes: up to 5 short lowercase tags such as "chocolate", "nutty", "citrus" (can be empty).',
  'Base every field only on the name, description and category given — never assume ingredients that are not stated or strongly implied by the name.',
  'Return one object per item given, in the same order, and never skip or duplicate an item.',
].join('\n');

function batchPayload(batch: MenuItemForTagging[]) {
  return {
    items: batch.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      category: i.category,
      parent_category: i.parent_category,
    })),
  };
}

interface NormalizedUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

interface BatchOutcome {
  rows: ValidatedTraitRow[] | null;
  usage: NormalizedUsage | null;
  error?: string;
  /** Gemini only: this batch failed specifically with HTTP 429 — the caller
   * stops starting new batches when it sees this (GEMINI_RATE_LIMIT_MESSAGE). */
  rateLimited?: boolean;
}

// ---------------------------------------------------------------------------
// Anthropic (Opus) — batches run CONCURRENTLY: ~120 items is 3 batches, and
// sequential calls would blow the route's serverless time limit.
// ---------------------------------------------------------------------------

async function tagBatchWithAnthropic(
  client: NonNullable<ReturnType<typeof getAnthropicClient>>,
  model: string,
  batch: MenuItemForTagging[],
): Promise<BatchOutcome> {
  const allowedIds = new Set(batch.map((i) => i.id));
  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: ANTHROPIC_OUTPUT_SCHEMA } },
        system: [{ type: 'text', text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: JSON.stringify(batchPayload(batch)) }],
      },
      { timeout: ANTHROPIC_TIMEOUT_MS },
    );
    let rows: ValidatedTraitRow[] | null = null;
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        const parsed = JSON.parse(textBlock.text) as { items?: unknown };
        rows = validateOpusTraitRows(capFlavorNotes(parsed.items), allowedIds);
      }
    }
    const usage = response.usage;
    return {
      rows,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      },
    };
  } catch (err) {
    console.error('tagMenuItemTraits: batch failed', err);
    return { rows: null, usage: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function tagWithAnthropic(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  const client = getAnthropicClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set');

  const model = deciderModel();
  const batches = chunk(items, ANTHROPIC_BATCH_SIZE);
  const outcomes = await Promise.all(batches.map((batch) => tagBatchWithAnthropic(client, model, batch)));
  return finishResult(outcomes, model, batches.length);
}

// ---------------------------------------------------------------------------
// Gemini (free tier) — small batches through a CONCURRENCY-4 promise pool,
// all sharing one 50s budget (see GEMINI_BATCH_SIZE/GEMINI_CONCURRENCY
// above). Same SYSTEM_PROMPT/OUTPUT_SCHEMA, same validateOpusTraitRows() call
// as the Anthropic path; `thinkingLevel: 'low'` cuts per-call latency for
// this JSON-schema-constrained classification task.
// ---------------------------------------------------------------------------

async function tagBatchWithGemini(model: string, batch: MenuItemForTagging[], timeoutMs: number): Promise<BatchOutcome> {
  const allowedIds = new Set(batch.map((i) => i.id));
  try {
    const { json, usage } = await geminiGenerateJson({
      model,
      system: SYSTEM_PROMPT,
      user: JSON.stringify(batchPayload(batch)),
      schema: OUTPUT_SCHEMA,
      maxOutputTokens: MAX_TOKENS,
      timeoutMs,
      thinkingLevel: 'low',
    });
    const parsed = json as { items?: unknown };
    const rows = validateOpusTraitRows(capFlavorNotes(parsed.items), allowedIds);
    return {
      rows,
      usage: { inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: 0, outputTokens: usage.outputTokens },
    };
  } catch (err) {
    console.error('tagMenuItemTraits: gemini batch failed', err);
    const message = err instanceof Error ? err.message : String(err);
    return { rows: null, usage: null, error: message, rateLimited: /HTTP 429\b/.test(message) };
  }
}

/** A small index-based promise pool: `concurrency` workers each pull the next
 * unclaimed index until the list is exhausted or `stop()` returns true, in
 * which case a worker returns without claiming further work — already
 * in-flight calls are left to finish naturally, only NEW ones are skipped.
 * Skipped/never-reached indices are left `undefined` in the returned array. */
async function runPool<T>(
  count: number,
  concurrency: number,
  stop: () => boolean,
  run: (index: number) => Promise<T>,
): Promise<(T | undefined)[]> {
  // .fill(undefined), not a bare `new Array(count)`: the latter leaves real
  // holes, which Array.prototype.map() SKIPS (not what we want — every
  // never-reached index must still map to a "failed, not called" outcome
  // below) while a plain for-of loop treats a hole as undefined anyway. This
  // keeps both call sites consistent.
  const results: (T | undefined)[] = new Array(count).fill(undefined);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      if (stop()) return;
      const i = nextIndex++;
      if (i >= count) return;
      results[i] = await run(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
  return results;
}

async function tagWithGemini(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  const apiModel = geminiModel();
  const batches = chunk(items, GEMINI_BATCH_SIZE);
  const startedAt = Date.now();
  let rateLimited = false;

  const outcomes = await runPool<BatchOutcome>(
    batches.length,
    GEMINI_CONCURRENCY,
    () => rateLimited,
    async (i) => {
      const remainingMs = GEMINI_BUDGET_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        return { rows: null, usage: null, error: 'gemini trait tagging: overall time budget exhausted' };
      }
      const outcome = await tagBatchWithGemini(apiModel, batches[i], Math.max(remainingMs, GEMINI_MIN_TIMEOUT_MS));
      if (outcome.rateLimited) rateLimited = true;
      return outcome;
    },
  );

  // A batch the pool never started (because rate-limiting stopped new work)
  // counts as failed, not called — same posture as a budget-exhausted one.
  const finalOutcomes: BatchOutcome[] = outcomes.map(
    (o) => o ?? { rows: null, usage: null, error: 'gemini trait tagging: skipped after the free-tier rate limit was hit' },
  );

  const result = finishResult(finalOutcomes, deciderModelLabel(), batches.length);
  // A friendly, actionable message beats whichever raw batch error happened
  // to be first — surfaced even on a partial success (some rows tagged).
  if (rateLimited) result.firstError = GEMINI_RATE_LIMIT_MESSAGE;
  return result;
}

// ---------------------------------------------------------------------------
// Jev (decision-only) — ONE systemOne call per item, through a CONCURRENCY-8
// promise pool sharing one 50s budget (§5.1). Jev can't write free-form JSON
// rows, so every field is its own choice/score/noul question; the answers are
// assembled into the SAME row shape (and run through the SAME
// validateOpusTraitRows()) as the Anthropic/Gemini batch paths.
// ---------------------------------------------------------------------------

// One-line descriptions per §3.2/§5.3's mood meanings, reused verbatim in
// spirit for Jev's per-mood noul questions.
const JEV_MOOD_DESCRIPTIONS: Record<Mood, string> = {
  boost: 'Suits a customer who wants an energising lift — e.g. a high- or medium-caffeine drink.',
  cosy: 'Suits a customer who wants something warm and unhurried — hot and rich-bodied.',
  celebrate: 'Suits a customer who is celebrating — a dessert, or a notably sweet treat.',
  comfort: 'Suits a customer who wants comfort — rich-bodied, or noticeably sweet.',
  cool: 'Suits a customer who wants to cool down on a hot day — a cold, iced drink.',
  surprise: 'Suits a customer open to trying something a little different from the everyday choice.',
};

const JEV_DAYPART_DESCRIPTIONS: Record<Daypart, string> = {
  morning: 'Typically ordered first thing in the morning.',
  afternoon: 'Typically ordered in the afternoon.',
  evening: 'Typically ordered in the evening.',
  late: 'Typically ordered late at night.',
};

const JEV_TEMPERATURE_CRITERIA = {
  hot: 'Served hot.',
  iced: 'Served iced/cold.',
  either: 'A drink offered both hot and iced.',
  ambient: 'Food or dessert served at room temperature — no serving temperature applies.',
};

const JEV_CAFFEINE_CRITERIA = {
  none: 'No caffeine at all — no coffee, tea or matcha. This ALWAYS includes chocolate, cocoa, Nutella, Oreo and hot chocolate, none of which contain caffeine no matter how rich they taste.',
  low: 'A light amount of caffeine — typically a milk-heavy tea-, chai- or matcha-based drink.',
  medium: 'A moderate amount of caffeine — a milkier coffee drink, or a stronger tea-, matcha- or chai-based drink.',
  high: 'A high amount of caffeine — a coffee-based espresso drink.',
};

const JEV_BODY_CRITERIA = {
  light: 'Light-bodied — or, for food/dessert, a light portion.',
  medium: 'Medium-bodied — or, for food/dessert, a medium portion.',
  rich: 'Rich, heavy-bodied — or, for food/dessert, a hearty, filling portion.',
};

const JEV_KIND_CRITERIA = { drink: 'A drink.', food: 'A savoury food item.', dessert: 'A sweet dessert.' };

const JEV_SWEETNESS_CRITERIA = [
  'Not sweet at all — unsweetened or savoury.',
  'Lightly sweet.',
  'Sweet.',
  'Very sweet — dessert-like.',
] as const;

type JevAnswer = { choice?: string; confidence?: number; noul?: number; score?: number };

function buildJevQuestions(): Record<string, ReturnType<typeof choice> | ReturnType<typeof noul> | ReturnType<typeof score>> {
  const questions: Record<string, ReturnType<typeof choice> | ReturnType<typeof noul> | ReturnType<typeof score>> = {
    temperature: choice('The item\'s serving temperature.', JEV_TEMPERATURE_CRITERIA),
    caffeine: choice('The item\'s caffeine level.', JEV_CAFFEINE_CRITERIA),
    is_coffee: noul('Is this drink coffee-based?'),
    sweetness: score('How sweet is this item?', JEV_SWEETNESS_CRITERIA),
    body: choice("The item's body/heaviness (portion heaviness for food/dessert).", JEV_BODY_CRITERIA),
    kind: choice('What kind of menu item this is.', JEV_KIND_CRITERIA),
  };
  for (const mood of MOODS) questions[`mood_${mood}`] = noul(JEV_MOOD_DESCRIPTIONS[mood]);
  for (const daypart of DAYPARTS) questions[`daypart_${daypart}`] = noul(JEV_DAYPART_DESCRIPTIONS[daypart]);
  for (const flavor of JEV_FLAVOR_VOCABULARY) questions[`flavor_${flavor}`] = noul(`Does this item taste of ${flavor}?`);
  return questions;
}

interface JevItemOutcome {
  row: ValidatedTraitRow | null;
  needsReviewName: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  error?: string;
}

async function tagOneItemWithJev(
  client: NonNullable<ReturnType<typeof getJevClient>>,
  model: string,
  item: MenuItemForTagging,
  timeoutMs: number,
): Promise<JevItemOutcome> {
  try {
    const result = await client.systemOne(
      {
        state: { name: item.name, description: item.description, category: item.category, parent_category: item.parent_category },
        questions: buildJevQuestions(),
        model,
      },
      { timeout: timeoutMs, retry: { maxRetries: 1 } },
    );
    const a = result.answers as unknown as Record<string, JevAnswer>;

    let moods = MOODS.filter((m) => (a[`mood_${m}`]?.noul ?? 0) >= 0.5);
    if (moods.length === 0) {
      moods = [MOODS.reduce((best, m) => ((a[`mood_${m}`]?.noul ?? 0) > (a[`mood_${best}`]?.noul ?? 0) ? m : best))];
    }

    const dayparts = DAYPARTS.filter((d) => (a[`daypart_${d}`]?.noul ?? 0) >= 0.5);
    const finalDayparts = dayparts.length > 0 ? dayparts : [...DAYPARTS];

    const flavorNotes = JEV_FLAVOR_VOCABULARY.map((f) => ({ f, p: a[`flavor_${f}`]?.noul ?? 0 }))
      .filter((x) => x.p >= 0.6)
      .sort((x, y) => y.p - x.p)
      .slice(0, 5)
      .map((x) => x.f);

    const sweetness = Math.min(3, Math.max(0, Math.round(a.sweetness?.score ?? 0)));

    const rawRow = {
      menu_item_id: item.id,
      temperature: a.temperature?.choice,
      caffeine: a.caffeine?.choice,
      is_coffee: (a.is_coffee?.noul ?? 0) >= 0.5,
      sweetness,
      body: a.body?.choice,
      kind: a.kind?.choice,
      moods,
      dayparts: finalDayparts,
      flavor_notes: flavorNotes,
    };
    const [row] = validateOpusTraitRows([rawRow], new Set([item.id]));

    const isCoffeeNoul = a.is_coffee?.noul ?? 0;
    const lowConfidence =
      (a.temperature?.confidence ?? 1) < JEV_LOW_CONFIDENCE_THRESHOLD ||
      (a.caffeine?.confidence ?? 1) < JEV_LOW_CONFIDENCE_THRESHOLD ||
      (a.kind?.confidence ?? 1) < JEV_LOW_CONFIDENCE_THRESHOLD ||
      (isCoffeeNoul > JEV_UNCERTAIN_NOUL_LOW && isCoffeeNoul < JEV_UNCERTAIN_NOUL_HIGH);

    return {
      row: row ?? null,
      needsReviewName: row && lowConfidence ? item.name : null,
      usage: { inputTokens: result.usage?.input_tokens ?? 0, outputTokens: result.usage?.output_tokens ?? 0 },
    };
  } catch (err) {
    console.error('tagMenuItemTraits: jev item failed', err);
    return { row: null, needsReviewName: null, usage: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function tagWithJev(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  const client = getJevClient();
  if (!client) throw new Error('TYPESAFE_API_KEY is not set');

  const model = jevModel();
  const startedAt = Date.now();

  const outcomes = await runPool<JevItemOutcome>(
    items.length,
    JEV_CONCURRENCY,
    () => false, // never stop early — a budget-exhausted item just fails in place, below
    async (i) => {
      const remainingMs = JEV_BUDGET_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        return { row: null, needsReviewName: null, usage: null, error: 'jev trait tagging: overall time budget exhausted' };
      }
      return tagOneItemWithJev(client, model, items[i], Math.min(remainingMs, JEV_PER_ITEM_TIMEOUT_MS));
    },
  );

  const rows: ValidatedTraitRow[] = [];
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

// ---------------------------------------------------------------------------

function finishResult(outcomes: BatchOutcome[], model: string, batchCount: number): TagTraitsResult {
  const rows: ValidatedTraitRow[] = [];
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let failedBatches = 0;
  let firstError: string | undefined;

  for (const r of outcomes) {
    if (r.usage) {
      inputTokens += r.usage.inputTokens;
      cacheReadTokens += r.usage.cacheReadTokens;
      cacheWriteTokens += r.usage.cacheWriteTokens;
      outputTokens += r.usage.outputTokens;
    }
    if (r.rows) {
      rows.push(...r.rows);
    } else {
      failedBatches++;
      if (!firstError && r.error) firstError = r.error;
    }
  }

  return {
    rows,
    usage: {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      costUsdMicros: costUsdMicros(model, { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }),
    },
    needsReview: [],
    batches: batchCount,
    failedBatches,
    firstError,
  };
}

/** Tags a batch of menu items with whichever provider deciderProvider()
 * selects (Jev preferred, then Anthropic, then Gemini — §1). Throws only when
 * NO key is configured — per-item/per-batch call/parse failures are absorbed
 * into `failedBatches`/`firstError`/`needsReview`. */
export async function tagMenuItemTraits(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  const provider = deciderProvider();
  if (provider === 'jev') return tagWithJev(items);
  if (provider === 'gemini') return tagWithGemini(items);
  if (provider === 'anthropic') return tagWithAnthropic(items);
  throw new Error('Neither TYPESAFE_API_KEY, GEMINI_API_KEY nor ANTHROPIC_API_KEY is set');
}
