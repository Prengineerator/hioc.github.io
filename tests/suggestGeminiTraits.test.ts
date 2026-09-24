import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 · SUG-2 — Gemini (free tier) menu-trait tagging, the speed-up
// requested on top of the Jev work (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5.1): 15-item batches through a concurrency-4 pool sharing one 50s budget,
// `thinkingLevel: 'low'`, and a friendly message (with tagged rows preserved)
// when the free tier's rate limit is hit. `lib/suggest/gemini.ts` is mocked
// at the module boundary — no network.

const { geminiGenerateJsonMock } = vi.hoisted(() => ({ geminiGenerateJsonMock: vi.fn() }));

vi.mock('@/lib/suggest/gemini', () => ({ geminiGenerateJson: geminiGenerateJsonMock }));

import { DeciderError } from '@/lib/suggest/deciderError';
import { tagMenuItemTraits, type MenuItemForTagging } from '@/lib/suggest/traitsPrompt';

function validRow(id: string) {
  return {
    menu_item_id: id,
    temperature: 'hot',
    caffeine: 'medium',
    is_coffee: true,
    sweetness: 1,
    body: 'medium',
    kind: 'drink',
    moods: ['boost'],
    dayparts: ['morning'],
    flavor_notes: ['bold'],
  };
}

function items(n: number): MenuItemForTagging[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    name: `Item ${i}`,
    description: 'A test item',
    category: 'Coffee',
    parent_category: 'Hot',
  }));
}

interface CallArgs {
  user: string;
  thinkingLevel?: string;
}

const ENV_KEYS = ['SUGGEST_LLM', 'SUGGEST_LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GEMINI_API_KEY = 'gk-test';
  geminiGenerateJsonMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe('tagMenuItemTraits (Gemini) — batching', () => {
  it('batches 15 items at a time and passes thinkingLevel: "low"', async () => {
    geminiGenerateJsonMock.mockImplementation(async (args: CallArgs) => {
      const batchItems = (JSON.parse(args.user).items as { id: string }[]).map((i) => validRow(i.id));
      return { json: { items: batchItems }, usage: { inputTokens: 50, outputTokens: 0, cacheReadTokens: 0 } };
    });

    const result = await tagMenuItemTraits(items(30));

    expect(geminiGenerateJsonMock).toHaveBeenCalledTimes(2);
    for (const call of geminiGenerateJsonMock.mock.calls) {
      const [args] = call as [CallArgs];
      expect(JSON.parse(args.user).items).toHaveLength(15);
      expect(args.thinkingLevel).toBe('low');
    }
    expect(result.rows).toHaveLength(30);
    expect(result.batches).toBe(2);
    expect(result.failedBatches).toBe(0);
  });

  it('runs batches with concurrency at most 4', async () => {
    let active = 0;
    let maxActive = 0;
    geminiGenerateJsonMock.mockImplementation(async (args: CallArgs) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      const batchItems = (JSON.parse(args.user).items as { id: string }[]).map((i) => validRow(i.id));
      return { json: { items: batchItems }, usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 } };
    });

    const result = await tagMenuItemTraits(items(180)); // 12 batches of 15
    expect(geminiGenerateJsonMock).toHaveBeenCalledTimes(12);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
    expect(result.rows).toHaveLength(180);
  });
});

describe('tagMenuItemTraits (Gemini) — rate limiting (HTTP 429)', () => {
  it('stops starting new batches after a 429, keeps rows already tagged, and reports a friendly message even on partial success', async () => {
    let callIndex = -1;
    geminiGenerateJsonMock.mockImplementation(async (args: CallArgs) => {
      const idx = ++callIndex;
      if (idx === 1) {
        // Rejects near-instantly (no internal await before the throw), so the
        // pool observes rateLimited well before the other in-flight batches'
        // artificial 10ms latency elapses — deterministic without fake timers.
        throw new DeciderError('error', 'gemini HTTP 429: Too Many Requests');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      const batchItems = (JSON.parse(args.user).items as { id: string }[]).map((i) => validRow(i.id));
      return { json: { items: batchItems }, usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 } };
    });

    const result = await tagMenuItemTraits(items(120)); // 8 batches of 15, concurrency 4

    // Only the first wave (4, one per concurrency slot) was ever called — the
    // rest never started once the 429 was seen.
    expect(geminiGenerateJsonMock).toHaveBeenCalledTimes(4);
    // 3 of the first 4 batches succeeded (15 items each); the 429'd one and
    // the 4 that never started all count as failed, not called.
    expect(result.rows).toHaveLength(45);
    expect(result.rows.length).toBeGreaterThan(0); // rows already tagged are KEPT
    expect(result.failedBatches).toBe(5);
    expect(result.firstError).toMatch(/free-tier limit was reached/i);
    expect(result.firstError).not.toMatch(/429/); // the raw HTTP detail is replaced, not appended
  });
});
