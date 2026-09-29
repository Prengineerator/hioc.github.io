import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 · SUG-2 + Coffey v2 — Jev (TypeSafe AI) menu-trait tagging
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.1, docs/COFFEY-SPEC.md §3.2). The
// SDK is mocked at the module level, same approach as tests/suggestJev.test.ts.
// This file drives the whole tagger through the mocked client; the pure pieces
// (question set, answer → row mapping, review rules, related descriptions) are
// covered directly in tests/suggestTraitsV2*.test.ts.

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));

vi.mock('@typesafe-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@typesafe-ai/sdk')>();
  return {
    ...actual,
    TypeSafeClient: vi.fn().mockImplementation(() => ({ systemOne: systemOneMock })),
  };
});

import { buildJevTraitQuestions, buildJevTraitState, tagMenuItemTraits, type MenuItemForTagging } from '@/lib/suggest/traitsPrompt';
import { FLAVOR_VOCABULARY, TRAIT_QUESTION_COUNT } from '@/lib/suggest/traitVocabulary';
import { CURRENT_TRAITS_VERSION, DAYPARTS, MOODS } from '@/lib/suggest/types';

type Answer = { choice?: string; confidence?: number; noul?: number; score?: number };
type AnswerOverrides = Record<string, Answer>;

/** An answer for EVERY question buildJevTraitQuestions() asks — defaulted to a
 * clean, confident, fully-valid one — so a test that forgets a key can't pass
 * by accident. Tests override just the fields they care about. */
function baseAnswers(overrides: AnswerOverrides = {}): AnswerOverrides {
  const answers: AnswerOverrides = {};
  for (const [key, question] of Object.entries(buildJevTraitQuestions())) {
    if (question.type === 'noul') answers[key] = { noul: 0.1 };
    else if (question.type === 'score') answers[key] = { score: 0, confidence: 0.9 };
    else answers[key] = { choice: Object.keys(question.criteria)[0], confidence: 0.9 };
  }
  Object.assign(answers, {
    temperature: { choice: 'hot', confidence: 0.9 },
    caffeine: { choice: 'high', confidence: 0.9 },
    is_coffee: { noul: 0.95 },
    kind: { choice: 'drink', confidence: 0.9 },
    body: { choice: 'light', confidence: 0.9 },
    sweetness: { score: 0.4, confidence: 0.9 },
    intensity: { score: 2.6, confidence: 0.9 },
    refreshment: { score: 1.2, confidence: 0.9 },
    indulgence: { score: 0.2, confidence: 0.9 },
    novelty: { score: 0.4, confidence: 0.9 },
    mood_boost: { score: 2.8, confidence: 0.9 },
    daypart_morning: { noul: 0.9 },
  });
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
    sizes: [{ label: 'Regular', price_inr: 180 }],
    customisations: [],
  }));
}

const flavorKey = (note: string) => `flavor_${FLAVOR_VOCABULARY.findIndex((f) => f.note === note)}`;

const ENV_KEYS = ['SUGGEST_LLM', 'TYPESAFE_API_KEY'] as const;
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

describe('test fixture — one answer per question', () => {
  it('baseAnswers covers exactly the questions the tagger asks', () => {
    expect(Object.keys(baseAnswers()).sort()).toEqual(Object.keys(buildJevTraitQuestions()).sort());
    expect(Object.keys(baseAnswers())).toHaveLength(TRAIT_QUESTION_COUNT);
  });
});

describe('tagMenuItemTraits (Jev) — question -> row mapping', () => {
  it('produces a full v1 + v2 row stamped with the current trait version', async () => {
    resolveWith();
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row).toMatchObject({
      menu_item_id: 'item-0',
      temperature: 'hot',
      caffeine: 'high',
      is_coffee: true,
      body: 'light',
      kind: 'drink',
      sweetness_level: 1,
      sweetness: 0,
      intensity: 3,
      refreshment: 1,
      indulgence: 0,
      novelty: 0,
      moods: ['boost'],
      dayparts: ['morning'],
      textures: [],
      flavor_notes: [],
      traits_version: CURRENT_TRAITS_VERSION,
    });
    expect(Object.keys(row.mood_fit).sort()).toEqual([...MOODS].sort());
    expect(row.mood_fit.boost).toBe(2.8);
  });

  it('sweetness_level = round(score x 2), and the legacy sweetness is derived from it', async () => {
    resolveWith({ sweetness: { score: 2.6, confidence: 0.9 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].sweetness_level).toBe(5);
    expect(result.rows[0].sweetness).toBe(2); // level 5 → legacy 2
  });

  it('clamps a sweetness score below 0 up to level 0', async () => {
    resolveWith({ sweetness: { score: -0.4, confidence: 0.9 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].sweetness_level).toBe(0);
    expect(result.rows[0].sweetness).toBe(0);
  });

  it('clamps a sweetness score above 5 down to level 10', async () => {
    resolveWith({ sweetness: { score: 5.6, confidence: 0.9 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows[0].sweetness_level).toBe(10);
    expect(result.rows[0].sweetness).toBe(3);
  });

  it('rounds and clamps intensity, refreshment, indulgence and novelty to 0–3', async () => {
    resolveWith({
      intensity: { score: 3.4, confidence: 0.9 },
      refreshment: { score: 1.5, confidence: 0.9 },
      indulgence: { score: -0.2, confidence: 0.9 },
      novelty: { score: 2.4, confidence: 0.9 },
    });
    const { rows } = await tagMenuItemTraits(items(1));
    expect(rows[0].intensity).toBe(3);
    expect(rows[0].refreshment).toBe(2);
    expect(rows[0].indulgence).toBe(0);
    expect(rows[0].novelty).toBe(2);
  });

  it('mood_fit is each mood score to one decimal; moods are those with fit >= 2, best first, max 3', async () => {
    resolveWith({
      mood_boost: { score: 2.26 },
      mood_focus: { score: 2.94 },
      mood_unwind: { score: 1.04 },
      mood_cosy: { score: 1.9 },
      mood_comfort: { score: 2.5 },
      mood_celebrate: { score: 2.04 },
      mood_cool: { score: 0.5 },
      mood_surprise: { score: 3 },
    });
    const { rows } = await tagMenuItemTraits(items(1));
    expect(rows[0].mood_fit).toEqual({ boost: 2.3, focus: 2.9, unwind: 1, cosy: 1.9, comfort: 2.5, celebrate: 2, cool: 0.5, surprise: 3 });
    // five moods reach 2 — the best three, highest first
    expect(rows[0].moods).toEqual(['surprise', 'focus', 'comfort']);
  });

  it('when no mood reaches 2, keeps only the single best', async () => {
    resolveWith({
      mood_boost: { score: 0.4 },
      mood_focus: { score: 1.2 },
      mood_unwind: { score: 1.6 },
      mood_cosy: { score: 1.9 },
      mood_comfort: { score: 0.2 },
      mood_celebrate: { score: 0.05 },
      mood_cool: { score: 1.5 },
      mood_surprise: { score: 0.3 },
    });
    const { rows } = await tagMenuItemTraits(items(1));
    expect(rows[0].moods).toEqual(['cosy']);
  });

  it('keeps dayparts at P >= 0.6, highest first, max 3', async () => {
    resolveWith({
      daypart_morning: { noul: 0.7 },
      daypart_afternoon: { noul: 0.95 },
      daypart_evening: { noul: 0.6 },
      daypart_late: { noul: 0.61 },
    });
    const { rows } = await tagMenuItemTraits(items(1));
    expect(rows[0].dayparts).toEqual(['afternoon', 'morning', 'late']); // evening (0.6) is 4th → capped
  });

  it('when no daypart qualifies, keeps only the single best', async () => {
    resolveWith({
      daypart_morning: { noul: 0.2 },
      daypart_afternoon: { noul: 0.55 },
      daypart_evening: { noul: 0.3 },
      daypart_late: { noul: 0.1 },
    });
    const { rows } = await tagMenuItemTraits(items(1));
    expect(rows[0].dayparts).toEqual(['afternoon']);
  });

  it('keeps textures at P >= 0.6, highest first, max 3', async () => {
    resolveWith({
      texture_silky: { noul: 0.7 },
      texture_creamy: { noul: 0.9 },
      texture_frothy: { noul: 0.59 },
      texture_thick: { noul: 0.8 },
      texture_icy: { noul: 0.65 },
    });
    const { rows } = await tagMenuItemTraits(items(1));
    expect(rows[0].textures).toEqual(['creamy', 'thick', 'silky']);
  });

  it('keeps flavour notes with P >= 0.6, highest first, capped at 5 — keyed by index into the vocabulary', async () => {
    resolveWith({
      [flavorKey('chocolate')]: { noul: 0.61 },
      [flavorKey('caramel')]: { noul: 0.95 },
      [flavorKey('hazelnut')]: { noul: 0.7 },
      [flavorKey('vanilla')]: { noul: 0.8 },
      [flavorKey('chai spice')]: { noul: 0.65 }, // a two-word note
      [flavorKey('mango')]: { noul: 0.99 }, // 6th qualifying note — dropped by the cap
    });
    const { rows } = await tagMenuItemTraits(items(1));
    expect(rows[0].flavor_notes).toEqual(['mango', 'caramel', 'vanilla', 'hazelnut', 'chai spice']);
  });

  it('drops a flavor note whose P is below 0.6', async () => {
    resolveWith({ [flavorKey('chocolate')]: { noul: 0.59 } });
    const { rows } = await tagMenuItemTraits(items(1));
    expect(rows[0].flavor_notes).not.toContain('chocolate');
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

  it('drops a row whose score answer is not a number', async () => {
    resolveWith({ intensity: { score: Number.NaN, confidence: 0.9 } });
    const result = await tagMenuItemTraits(items(1));
    expect(result.rows).toEqual([]);
    expect(result.failedBatches).toBe(1);
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

  it('flags an item whose sweetness confidence is below 0.5', async () => {
    resolveWith({ sweetness: { score: 3, confidence: 0.45 } });
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

describe('tagMenuItemTraits (Jev) — what is sent to Jev', () => {
  const item: MenuItemForTagging = {
    id: 'latte-iced',
    name: 'Latte Iced',
    description: '',
    category: 'Coffee',
    parent_category: 'Iced Drinks',
    sizes: [
      { label: 'Regular', price_inr: 180 },
      { label: 'Large', price_inr: 210 },
    ],
    customisations: [{ group: 'Choice of Sugar', options: ['Stevia (sugarfree)', 'Brown Sugar', 'No Sugar', 'Normal'] }],
    related_description: 'From the related menu item "Latte": Iced Latte is a smooth espresso paired with creamy chilled milk.',
  };

  it('sends one systemOne call per item: the state, every question, and the model', async () => {
    resolveWith();
    await tagMenuItemTraits([item]);
    expect(systemOneMock).toHaveBeenCalledTimes(1);
    const [request] = systemOneMock.mock.calls[0];
    expect(request.state).toEqual(buildJevTraitState(item));
    expect(Object.keys(request.questions)).toHaveLength(TRAIT_QUESTION_COUNT);
    expect(request.model).toBe('jev-latest');
  });

  it('the state carries the café, sizes with prices, customisations and the related description', async () => {
    resolveWith();
    await tagMenuItemTraits([item]);
    const { state } = systemOneMock.mock.calls[0][0];
    expect(state).toEqual({
      cafe: 'HIOC. — a pure-vegetarian coffee and waffle café in Agra, India.',
      item: {
        name: 'Latte Iced',
        category: 'Coffee',
        parent_category: 'Iced Drinks',
        description: '',
        related_description: 'From the related menu item "Latte": Iced Latte is a smooth espresso paired with creamy chilled milk.',
        sizes: ['Regular ₹180', 'Large ₹210'],
        customisations: ['Choice of Sugar: Stevia (sugarfree), Brown Sugar, No Sugar, Normal'],
      },
    });
  });

  it('leaves related_description out of the state when there is none', async () => {
    resolveWith();
    await tagMenuItemTraits([{ ...item, related_description: undefined }]);
    expect(systemOneMock.mock.calls[0][0].state.item).not.toHaveProperty('related_description');
  });

  it('gives each item a 15s timeout, one retry, and a deadline signal', async () => {
    resolveWith();
    await tagMenuItemTraits(items(1));
    const options = systemOneMock.mock.calls[0][1];
    expect(options.timeout).toBe(15000);
    expect(options.retry).toEqual({ maxRetries: 1 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
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

  it('caps each item timeout at what is left of the shared budget', async () => {
    vi.useFakeTimers();
    try {
      // The first call burns 46s of the 50s budget, synchronously — so the
      // items that start after it have 4s left, well under the 15s per-item
      // timeout.
      systemOneMock.mockImplementation(async () => {
        vi.advanceTimersByTime(46_000);
        return { model: 'jev-latest', answers: baseAnswers(), usage: { input_tokens: 5, output_tokens: 0 } };
      });

      await tagMenuItemTraits(items(20));
      expect(systemOneMock.mock.calls[0][1].timeout).toBe(15000);
      const later = systemOneMock.mock.calls.slice(1).map((c) => c[1].timeout as number);
      expect(later.length).toBeGreaterThan(0);
      for (const t of later) expect(t).toBeLessThanOrEqual(4000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a Jev error as failed and surfaces its message', async () => {
    systemOneMock.mockRejectedValueOnce(new Error('429 rate limited'));
    resolveWith();
    const result = await tagMenuItemTraits(items(2));
    expect(result.rows).toHaveLength(1);
    expect(result.failedBatches).toBe(1);
    expect(result.firstError).toBe('429 rate limited');
  });
});

describe('tagMenuItemTraits (Jev) — cost', () => {
  it('prices at $0.042/MTok input, output free, via the jev: label', async () => {
    resolveWith({}, { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    const result = await tagMenuItemTraits(items(1));
    expect(result.usage.costUsdMicros).toBe(Math.round(1_000_000 * 0.042));
  });
});

describe('tagMenuItemTraits (Jev) — not configured', () => {
  it('throws only when Jev is not configured', async () => {
    delete process.env.TYPESAFE_API_KEY;
    await expect(tagMenuItemTraits(items(1))).rejects.toThrow(/TYPESAFE_API_KEY/);
    expect(systemOneMock).not.toHaveBeenCalled();
  });
});

// Keeps the imported vocabularies honest: a new mood or daypart must get a
// question, or the fixture above would stop covering the tagger.
describe('question set vs the shared vocabularies', () => {
  it('asks a fit per mood and a question per daypart', () => {
    const keys = Object.keys(buildJevTraitQuestions());
    for (const m of MOODS) expect(keys).toContain(`mood_${m}`);
    for (const d of DAYPARTS) expect(keys).toContain(`daypart_${d}`);
  });
});
