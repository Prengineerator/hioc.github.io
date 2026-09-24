// Phase 7 · SUG-2 — menu-trait tagging (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5.1). Sends batches of ~40 items (id, name, description, category,
// parent_category — no customer data, so S-3 doesn't apply here, but nothing
// here ever sees an order either) to the active decider provider (Opus, or
// Gemini Flash when configured — §1) with a JSON-schema output format, then
// runs every row through lib/suggest/traitsValidate.ts before it is trusted
// (playbook S-2: model output is data). Both providers share the exact same
// SYSTEM_PROMPT, OUTPUT_SCHEMA and validateOpusTraitRows() call — only the
// transport and batching strategy differ.
//
// 'server-only' — this is where ANTHROPIC_API_KEY/GEMINI_API_KEY-backed calls
// happen (playbook S-1). The caller (app/api/owner/suggest/traits/generate/route.ts)
// owns the "which items need tagging" and "upsert, never overwrite confirmed"
// decisions; this module only tags whatever it's given.

import 'server-only';
import { getAnthropicClient } from './anthropic';
import { geminiGenerateJson } from './gemini';
import { costUsdMicros, deciderModel, deciderModelLabel, geminiModel, llmProvider } from './models';
import { DAYPARTS, MOODS } from './types';
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
  /** Batches sent. */
  batches: number;
  /** Batches that errored, timed out, weren't `end_turn`, or didn't parse —
   * their items simply aren't in `rows`; the caller decides what to do next. */
  failedBatches: number;
  /** The first per-batch failure message, e.g. a wrong Gemini model id or a
   * 429 quota error — surfaced by the owner-facing generate route when
   * NOTHING got tagged, so the "Generate" failure is actionable rather than a
   * bare "0 of 120 tagged". Never contains an API key (S-6). */
  firstError?: string;
}

const BATCH_SIZE = 40;
const MAX_TOKENS = 16000;
const ANTHROPIC_TIMEOUT_MS = 50000; // under the route's 60 s maxDuration, leaving time to upsert

// Gemini's free tier is roughly 10 requests/minute, so batches run
// SEQUENTIALLY (concurrent batches would just trip the rate limit) under one
// shared 50 s budget rather than each getting its own fixed timeout. Each
// call's timeout is whatever's left of that budget, floored at 10 s so the
// last batch still gets a fair shot rather than a near-zero window.
const GEMINI_BUDGET_MS = 50000;
const GEMINI_MIN_TIMEOUT_MS = 10000;

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

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', items: TRAIT_ITEM_SCHEMA },
  },
} as const;

const SYSTEM_PROMPT = [
  'You are a barista tagging real cafe menu items with objective taste facts an ordering engine relies on.',
  'For EVERY item given, return exactly one object with these fields:',
  '- menu_item_id: the id given for that item, copied exactly — never invent one.',
  '- temperature: "hot", "iced", "either" (served both ways), or "ambient" (food/dessert — no serving temperature).',
  '- caffeine: "none", "low", "medium", or "high".',
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
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
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
        rows = validateOpusTraitRows(parsed.items, allowedIds);
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
  const batches = chunk(items, BATCH_SIZE);
  const outcomes = await Promise.all(batches.map((batch) => tagBatchWithAnthropic(client, model, batch)));
  return finishResult(outcomes, model, batches.length);
}

// ---------------------------------------------------------------------------
// Gemini (free tier) — batches run SEQUENTIALLY under one shared time budget
// (see GEMINI_BUDGET_MS above). Same SYSTEM_PROMPT/OUTPUT_SCHEMA, same
// validateOpusTraitRows() call as the Anthropic path.
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
    });
    const parsed = json as { items?: unknown };
    const rows = validateOpusTraitRows(parsed.items, allowedIds);
    return {
      rows,
      usage: { inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: 0, outputTokens: usage.outputTokens },
    };
  } catch (err) {
    console.error('tagMenuItemTraits: gemini batch failed', err);
    return { rows: null, usage: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function tagWithGemini(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  const apiModel = geminiModel();
  const batches = chunk(items, BATCH_SIZE);
  const startedAt = Date.now();
  const outcomes: BatchOutcome[] = [];

  for (const batch of batches) {
    const remainingMs = GEMINI_BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      outcomes.push({ rows: null, usage: null, error: 'gemini trait tagging: overall time budget exhausted' });
      continue;
    }
    outcomes.push(await tagBatchWithGemini(apiModel, batch, Math.max(remainingMs, GEMINI_MIN_TIMEOUT_MS)));
  }

  return finishResult(outcomes, deciderModelLabel(), batches.length);
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
    batches: batchCount,
    failedBatches,
    firstError,
  };
}

/** Tags a batch of menu items with whichever provider llmProvider() selects.
 * Throws only when NEITHER key is configured — per-batch call/parse failures
 * are absorbed into `failedBatches`/`firstError`. */
export async function tagMenuItemTraits(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  const provider = llmProvider();
  if (provider === 'gemini') return tagWithGemini(items);
  if (provider === 'anthropic') return tagWithAnthropic(items);
  throw new Error('Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is set');
}
