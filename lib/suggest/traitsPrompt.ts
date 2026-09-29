// Phase 7 · SUG-2 — menu-trait tagging (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5.1). Sends items (name, description, category, parent_category — no
// customer data, so S-3 doesn't apply here, but nothing here ever sees an
// order either) to Jev, then runs every row through
// lib/suggest/traitsValidate.ts before it is trusted (playbook S-2: model
// output is data). Jev is decision-only, not a batch JSON-writer, so it gets
// ONE systemOne call per item — every trait field is its own
// choice/score/noul question — through a concurrency-8 promise pool sharing
// one 50s budget, plus per-item low-confidence `needsReview` hints (§5.1
// "Low-confidence review hints").
//
// 'server-only' — this is where TYPESAFE_API_KEY-backed calls happen
// (playbook S-1). The caller
// (app/api/owner/suggest/traits/generate/route.ts) owns the "which items need
// tagging" and "upsert, never overwrite confirmed" decisions; this module
// only tags whatever it's given.

import 'server-only';
import { choice, noul, score } from '@typesafe-ai/sdk';
import { getJevClient } from './jev';
import { costUsdMicros, deciderModelLabel, deciderProvider, jevModel } from './models';
import { DAYPARTS, MOODS, type Daypart, type Mood } from './types';
import { validateModelTraitRows, type ValidatedTraitRow } from './traitsValidate';

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
  /** §5.1 "Low-confidence review hints" — item NAMES (not ids;
   * the owner-facing route has no other use for the id here) whose
   * temperature/caffeine/kind choice confidence was < 0.6, or whose
   * is_coffee noul landed in the uncertain 0.35–0.65 band. No DB column —
   * display-only. */
  needsReview: string[];
}

// Jev tags ONE item per systemOne call (it can't write a batch of JSON rows —
// it only answers structured questions about ONE state), through a
// CONCURRENCY-8 promise pool sharing one 50s budget. An item not started
// before the budget runs out counts as failed — not called; the owner simply
// clicks Generate again, and only missing/unconfirmed items are ever
// re-tagged (this module never decides that — the caller does).
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

// Jev can't write free-form JSON rows, so every field is its own
// choice/score/noul question; the answers are assembled into a trait row and
// run through validateModelTraitRows() like any other model output.

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
    const [row] = validateModelTraitRows([rawRow], new Set([item.id]));

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

/** Tags a batch of menu items with Jev (§1). Throws only when TYPESAFE_API_KEY
 * is not set (or the SUGGEST_LLM kill switch is off) — per-item call/parse
 * failures are absorbed into `failedBatches`/`firstError`/`needsReview`. */
export async function tagMenuItemTraits(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  if (deciderProvider() !== 'jev') throw new Error('TYPESAFE_API_KEY is not set');
  return tagWithJev(items);
}
