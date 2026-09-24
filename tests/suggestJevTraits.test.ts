import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 · SUG-2 — Jev (TypeSafe AI) menu-trait tagging
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.1). The SDK is mocked at the
// module level, same approach as tests/suggestJev.test.ts.

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));

vi.mock('@typesafe-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@typesafe-ai/sdk')>();
  return {
    ...actual,
    TypeSafeClient: vi.fn().mockImplementation(() => ({ systemOne: systemOneMock })),
  };
});

import { JEV_FLAVOR_VOCABULARY, tagMenuItemTraits, type MenuItemForTagging } from '@/lib/suggest/traitsPrompt';

const MOODS = ['boost', 'cosy', 'celebrate', 'comfort', 'cool', 'surprise'] as const;
const DAYPARTS = ['morning', 'afternoon', 'evening', 'late'] as const;

type AnswerOverrides = Record<string, { choice?: string; confidence?: number; noul?: number; score?: number }>;

/** Every question buildJevQuestions() asks, defaulted to a clean, confident,
 * fully-valid answer — tests override just the fields they care about. */
function baseAnswers(overrides: AnswerOverrides = {}) {
  const answers: AnswerOverrides = {
    temperature: { choice: 'hot', confidence: 0.9 },
    caffeine: { choice: 'high', confidence: 0.9 },
    is_coffee: { noul: 0.95 },
    sweetness: { score: 0.4 },
    body: { choice: 'light', confidence: 0.9 },
    kind: { choice: 'drink', confidence: 0.9 },
  };
  for (const m of MOODS) answers[`mood_${m}`] = { noul: m === 'boost' ? 0.9 : 0.1 };
  for (const d of DAYPARTS) answers[`daypart_${d}`] = { noul: d === 'morning' ? 0.9 : 0.1 };
  for (const f of JEV_FLAVOR_VOCABULARY) answers[`flavor_${f}`] = { noul: 0.1 };
  return { ...answers, ...overrides };
}

function resolveWith(overrides: AnswerOverrides = {}, usage = { input_tokens: 40, output_tokens: 0 }) {
  systemOneMock.mockResolvedValueOnce({ model: 'jev-latest', answers: baseAnswers(overrides), usage });
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

const ENV_KEYS = ['SUGGEST_LLM', 'SUGGEST_LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TYPESAFE_API_KEY = 'jev-test-secret-should-never-leak';
  systemOneMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('tagMenuItemTraits (Jev) — question -> row mapping', () => {
  it('rounds and clamps sweetness from the score answer', async () => {
    resolveWith({ sweetness: { score: 2.6 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sweetness).toBe(3);
  });

  it('clamps a sweetness score below 0 up to 0', async () => {
    resolveWith({ sweetness: { score: -0.4 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].sweetness).toBe(0);
  });

  it('clamps a sweetness score above 3 down to 3', async () => {
    resolveWith({ sweetness: { score: 3.6 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].sweetness).toBe(3);
  });

  it('keeps moods whose noul is >= 0.5', async () => {
    resolveWith({ mood_boost: { noul: 0.9 }, mood_cosy: { noul: 0.6 }, mood_cool: { noul: 0.49 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].moods.sort()).toEqual(['boost', 'cosy']);
  });

  it('when no mood clears 0.5, keeps only the single highest-probability mood', async () => {
    resolveWith({
      mood_boost: { noul: 0.4 },
      mood_cosy: { noul: 0.1 },
      mood_celebrate: { noul: 0.05 },
      mood_comfort: { noul: 0.2 },
      mood_cool: { noul: 0.15 },
      mood_surprise: { noul: 0.3 },
    });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].moods).toEqual(['boost']);
  });

  it('keeps dayparts whose noul is >= 0.5', async () => {
    resolveWith({ daypart_morning: { noul: 0.9 }, daypart_afternoon: { noul: 0.55 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].dayparts.sort()).toEqual(['afternoon', 'morning']);
  });

  it('when no daypart clears 0.5, keeps ALL four dayparts', async () => {
    resolveWith({
      daypart_morning: { noul: 0.2 },
      daypart_afternoon: { noul: 0.2 },
      daypart_evening: { noul: 0.2 },
      daypart_late: { noul: 0.2 },
    });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].dayparts.slice().sort()).toEqual([...DAYPARTS].sort());
  });

  it('keeps flavor notes with noul >= 0.6, highest first, capped at 5', async () => {
    resolveWith({
      flavor_chocolate: { noul: 0.61 },
      flavor_caramel: { noul: 0.95 },
      flavor_hazelnut: { noul: 0.7 },
      flavor_vanilla: { noul: 0.8 },
      flavor_nutty: { noul: 0.65 },
      flavor_fruity: { noul: 0.99 }, // 6th qualifying note — must be dropped by the cap
    });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].flavor_notes).toEqual(['fruity', 'caramel', 'vanilla', 'hazelnut', 'nutty']);
  });

  it('drops a flavor note whose noul is below 0.6', async () => {
    resolveWith({ flavor_chocolate: { noul: 0.59 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].flavor_notes).not.toContain('chocolate');
  });

  it('is_coffee is true only when its noul is >= 0.5', async () => {
    resolveWith({ is_coffee: { noul: 0.49 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].is_coffee).toBe(false);
  });
});

describe('tagMenuItemTraits (Jev) — the shared validator still applies (S-2)', () => {
  it('drops a row whose temperature choice is outside the CHECK-constraint enum', async () => {
    resolveWith({ temperature: { choice: 'lukewarm', confidence: 0.9 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows).toEqual([]);
    expect(result.failedBatches).toBe(1);
  });

  it('drops a row whose kind choice is invalid', async () => {
    resolveWith({ kind: { choice: 'beverage', confidence: 0.9 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows).toEqual([]);
  });
});

describe('tagMenuItemTraits (Jev) — needsReview (low-confidence hints)', () => {
  it('flags an item whose temperature confidence is below 0.6', async () => {
    resolveWith({ temperature: { choice: 'hot', confidence: 0.4 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.needsReview).toEqual(['Item 0']);
  });

  it('flags an item whose is_coffee noul lands in the uncertain 0.35-0.65 band', async () => {
    resolveWith({ is_coffee: { noul: 0.5 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.needsReview).toEqual(['Item 0']);
  });

  it('does not flag a confident, decisive item', async () => {
    resolveWith();
    const result = await tagMenuItemTraits(items(1));
    expect(result.needsReview).toEqual([]);
  });

  it('never flags an item whose row was dropped by the validator', async () => {
    // Low confidence AND an invalid enum value — the row itself fails first.
    resolveWith({ temperature: { choice: 'lukewarm', confidence: 0.1 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows).toEqual([]);
    expect(result.needsReview).toEqual([]);
  });
});

describe('tagMenuItemTraits (Jev) — concurrency and budget', () => {
  it('runs with concurrency at most 8', async () => {
    let active = 0;
    let maxActive = 0;
    systemOneMock.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return { model: 'jev-latest', answers: baseAnswers(), usage: { input_tokens: 5, output_tokens: 0 } };
    });

    const result = await tagMenuItemTraits(items(20));
    expect(maxActive).toBeLessThanOrEqual(8);
    expect(maxActive).toBeGreaterThan(1); // actually ran concurrently, not sequentially
    expect(result.rows).toHaveLength(20);
    expect(systemOneMock).toHaveBeenCalledTimes(20);
  });

  it('marks items that never started (because the shared 50s budget ran out) as failed, not called', async () => {
    vi.useFakeTimers();
    try {
      // The mock's own synchronous side effect pushes the fake clock well past
      // the 50s shared budget the very first time it's called — every OTHER
      // item's budget check (which runs before it would call the SDK) then
      // sees the budget already exhausted and is never called at all.
      systemOneMock.mockImplementation(async () => {
        vi.advanceTimersByTime(60_000);
        return { model: 'jev-latest', answers: baseAnswers(), usage: { input_tokens: 5, output_tokens: 0 } };
      });

      const result = await tagMenuItemTraits(items(20));
      expect(systemOneMock.mock.calls.length).toBeLessThan(20);
      expect(result.rows.length).toBe(systemOneMock.mock.calls.length);
      expect(result.failedBatches).toBe(20 - systemOneMock.mock.calls.length);
      expect(result.failedBatches).toBeGreaterThan(0);
      expect(result.firstError).toMatch(/budget/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('tagMenuItemTraits (Jev) — cost', () => {
  it('prices at $0.042/MTok input, output free, via the jev: label', async () => {
    resolveWith({}, { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    const result = await tagMenuItemTraits(items(1));
    expect(result.usage.costUsdMicros).toBe(Math.round(1_000_000 * 0.042));
  });
});
