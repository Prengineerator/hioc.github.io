// Phase 7 · SUG-2 — Opus menu-trait tagging (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5.1). Sends batches of ~40 items (id, name, description, category,
// parent_category — no customer data, so S-3 doesn't apply here, but nothing
// here ever sees an order either) to Opus with a JSON-schema output format,
// then runs every row through lib/suggest/traitsValidate.ts before it is
// trusted (playbook S-2: model output is data).
//
// 'server-only' — this is where ANTHROPIC_API_KEY-backed calls happen
// (playbook S-1). The caller (app/api/owner/suggest/traits/generate/route.ts)
// owns the "which items need tagging" and "upsert, never overwrite confirmed"
// decisions; this module only tags whatever it's given.

import 'server-only';
import { getAnthropicClient } from './anthropic';
import { costUsdMicros, deciderModel } from './models';
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
}

const BATCH_SIZE = 40;
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 50000; // under the route's 60 s maxDuration, leaving time to upsert

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

/** Tags a batch of menu items. Throws only if ANTHROPIC_API_KEY is unset —
 * per-batch call/parse failures are absorbed into `failedBatches`. */
export async function tagMenuItemTraits(items: MenuItemForTagging[]): Promise<TagTraitsResult> {
  const client = getAnthropicClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set');

  const model = deciderModel();
  const batches = chunk(items, BATCH_SIZE);
  const rows: ValidatedTraitRow[] = [];
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let failedBatches = 0;

  // Batches run CONCURRENTLY: ~120 items is 3 batches, and sequential calls
  // would blow the route's serverless time limit (maxDuration on the route).
  const results = await Promise.all(
    batches.map(async (batch) => {
      const allowedIds = new Set(batch.map((i) => i.id));
      const payload = {
        items: batch.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          category: i.category,
          parent_category: i.parent_category,
        })),
      };
      try {
        const response = await client.messages.create(
          {
            model,
            max_tokens: MAX_TOKENS,
            output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
            system: [{ type: 'text', text: SYSTEM_PROMPT }],
            messages: [{ role: 'user', content: JSON.stringify(payload) }],
          },
          { timeout: TIMEOUT_MS },
        );
        const usage = response.usage;
        let batchRows: ValidatedTraitRow[] | null = null;
        if (response.stop_reason === 'end_turn') {
          const textBlock = response.content.find((b) => b.type === 'text');
          if (textBlock && textBlock.type === 'text') {
            const parsed = JSON.parse(textBlock.text) as { items?: unknown };
            batchRows = validateOpusTraitRows(parsed.items, allowedIds);
          }
        }
        return { rows: batchRows, usage };
      } catch (err) {
        console.error('tagMenuItemTraits: batch failed', err);
        return { rows: null, usage: null };
      }
    }),
  );

  for (const r of results) {
    if (r.usage) {
      inputTokens += r.usage.input_tokens ?? 0;
      cacheReadTokens += r.usage.cache_read_input_tokens ?? 0;
      cacheWriteTokens += r.usage.cache_creation_input_tokens ?? 0;
      outputTokens += r.usage.output_tokens ?? 0;
    }
    if (r.rows) rows.push(...r.rows);
    else failedBatches++;
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
    batches: batches.length,
    failedBatches,
  };
}
