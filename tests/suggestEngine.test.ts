import { describe, expect, it, vi } from 'vitest';
import { runSuggest } from '@/lib/suggest/engine';
import { passesHardConstraints } from '@/lib/suggest/filter';
import { DeciderError } from '@/lib/suggest/deciderError';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';
import type { Decider, DeciderResult, SuggestInputs, SuggestRequest, TasteProfile } from '@/lib/suggest/types';
import { buildFixtureMenu, buildFixtureTraitsById, ESPRESSO } from './fixtures/suggestMenu';

// Phase 7 · SUG-4 — engine.ts orchestration, per the spec's §5 pipeline and
// this ticket's ACs. Every test injects a fake `Decider` so nothing here ever
// touches the network.

const BASE_INPUTS: SuggestInputs = {
  temperature: 'either',
  base: 'either',
  extras: [],
  needs: [],
  budget: 'any',
  mood: 'boost',
  note: '',
};

function request(overrides: Partial<SuggestRequest> = {}): SuggestRequest {
  return { inputs: BASE_INPUTS, ...overrides };
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    request: request(),
    menu: buildFixtureMenu(),
    traitsById: buildFixtureTraitsById(),
    profile: null as TasteProfile | null,
    popularity: new Map<string, number>(),
    recentItemIds: [] as string[],
    now: new Date('2026-06-01T10:00:00Z'), // an IST afternoon
    decider: null as Decider | null,
    ...overrides,
  };
}

function goodResult(picks: DeciderResult['picks']): DeciderResult {
  return {
    picks,
    header: 'Here is a lovely pick for you',
    model: 'claude-opus-5',
    inputTokens: 10,
    cacheReadTokens: 0,
    outputTokens: 5,
    costUsdMicros: 100,
  };
}

describe('runSuggest — decider disabled or missing', () => {
  it('given decider is null, falls back without calling anything', async () => {
    const result = await runSuggest(baseArgs({ decider: null, fallbackReason: 'no_key' }));
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('no_key');
    expect(result.picks.length).toBeGreaterThan(0);
    expect(result.usage.model).toBeNull();
  });
});

describe('runSuggest — decider output validation (SUG-4 AC)', () => {
  it('drops an off-shortlist id and tops up to SUGGEST_LIMITS.picks', async () => {
    const decider: Decider = vi.fn(async () =>
      goodResult([{ menuItemId: 'not-a-real-menu-item', reason: 'Great pick', reasonCode: 'trait' }]),
    );
    const result = await runSuggest(baseArgs({ decider }));
    expect(result.source).toBe('llm');
    expect(result.picks.every((p) => p.menuItemId !== 'not-a-real-menu-item')).toBe(true);
    expect(result.picks.length).toBe(SUGGEST_LIMITS.picks);
    for (const pick of result.picks) {
      expect(result.candidateIds).toContain(pick.menuItemId);
    }
  });
});

describe('runSuggest — decider failure modes (SUG-4 AC)', () => {
  it('a hanging decider still resolves with source fallback + reason timeout, within the timeout budget', async () => {
    vi.useFakeTimers();
    try {
      const hangingDecider: Decider = () => new Promise(() => {}); // never resolves
      const promise = runSuggest(baseArgs({ decider: hangingDecider }));
      await vi.advanceTimersByTimeAsync(SUGGEST_LIMITS.deciderTimeoutMs + 50);
      const result = await promise;
      expect(result.source).toBe('fallback');
      expect(result.fallbackReason).toBe('timeout');
      expect(result.picks.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing decider (plain Error) falls back with reason "error"', async () => {
    const decider: Decider = async () => {
      throw new Error('boom');
    };
    const result = await runSuggest(baseArgs({ decider }));
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('error');
  });

  it('a decider that reports a refusal falls back with reason "refusal"', async () => {
    const decider: Decider = async () => {
      throw new DeciderError('refusal', 'the model declined');
    };
    const result = await runSuggest(baseArgs({ decider }));
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('refusal');
  });

  it('a decider that reports invalid_output falls back with reason "invalid_output"', async () => {
    const decider: Decider = async () => {
      throw new DeciderError('invalid_output', 'not JSON');
    };
    const result = await runSuggest(baseArgs({ decider }));
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('invalid_output');
  });
});

describe('runSuggest — "usual" (§3.2)', () => {
  it('the usual is never duplicated in picks, and picks still reach SUGGEST_LIMITS.picks', async () => {
    const profile: TasteProfile = {
      topItems: [{ menu_item_id: ESPRESSO.id, count: 9, lastOrderedAt: '2026-05-01T00:00:00Z' }],
      categoryAffinity: { Coffee: 1 },
      traitLean: { icedShare: 0.2, meanSweetness: 0.5, caffeineShare: 0.9, foodAttachRate: 0.1 },
      ticket: { median: 150, p75: 180 },
      priceComfort: 'budget',
      orderingMood: 'routine',
      daypartHistogram: { morning: 0.5, afternoon: 0.5, evening: 0, late: 0 },
      favorites: [],
    };
    // The decider adversarially tries to also pick the usual item.
    const decider: Decider = async ({ shortlist }) =>
      goodResult(shortlist.slice(0, 3).map((c) => ({ menuItemId: c.menuItemId, reason: 'Nice', reasonCode: 'trait' })));

    const result = await runSuggest(baseArgs({ decider, profile }));
    expect(result.usualItemId).toBe(ESPRESSO.id);
    expect(result.usual?.menuItemId).toBe(ESPRESSO.id);
    expect(result.pickIds).not.toContain(ESPRESSO.id);
    expect(result.picks.length).toBe(SUGGEST_LIMITS.picks);
  });
});

describe('runSuggest — hard constraints (§5.2, §0 DoD)', () => {
  it('every pick and the usual always satisfy passesHardConstraints for the given inputs', async () => {
    const inputs: SuggestInputs = { ...BASE_INPUTS, temperature: 'iced', needs: ['no_caffeine'], budget: 'under_150' };
    const menu = buildFixtureMenu();
    const traitsById = buildFixtureTraitsById();
    // Adversarial decider: tries to slip in items that violate today's chips
    // (hot, caffeinated, over-budget) by id — validateDeciderPicks must drop
    // anything not already hard-filtered into the shortlist.
    const decider: Decider = async () =>
      goodResult([
        { menuItemId: 'cafe-latte', reason: 'Nice', reasonCode: 'trait' }, // hot, caffeinated — off-shortlist
        { menuItemId: 'hazelnut-creme', reason: 'Nice', reasonCode: 'trait' }, // over ₹150 — off-shortlist
      ]);

    const result = await runSuggest(baseArgs({ request: request({ inputs }), decider, menu, traitsById }));

    const itemsById = new Map(menu.map((i) => [i.id, i]));
    const idsToCheck = [...result.pickIds, ...(result.usualItemId ? [result.usualItemId] : [])];
    for (const id of idsToCheck) {
      const item = itemsById.get(id)!;
      expect(passesHardConstraints(item, traitsById.get(id), inputs, [])).toBe(true);
    }
  });

  it('excludeItemIds from a refine are never returned as candidates or picks', async () => {
    const excludeItemIds = ['espresso', 'cappuccino', 'cafe-latte', 'iced-latte', 'on-the-rocks'];
    const result = await runSuggest(
      baseArgs({ request: request({ excludeItemIds }), decider: null, fallbackReason: 'disabled' }),
    );
    for (const id of excludeItemIds) {
      expect(result.candidateIds).not.toContain(id);
      expect(result.pickIds).not.toContain(id);
    }
  });
});

describe('runSuggest — relaxHint and header', () => {
  it('produces a tone-linted header even when the decider writes a banned phrase', async () => {
    const decider: Decider = async ({ shortlist }) => ({
      ...goodResult(shortlist.slice(0, 1).map((c) => ({ menuItemId: c.menuItemId, reason: 'Nice pick', reasonCode: 'trait' }))),
      header: 'You should buy this — best deal today!',
    });
    const result = await runSuggest(baseArgs({ decider }));
    expect(result.header).not.toMatch(/best deal/i);
    expect(result.header.length).toBeGreaterThan(0);
  });

  it('names a relax hint when almost nothing fits the chips', async () => {
    const inputs: SuggestInputs = { ...BASE_INPUTS, temperature: 'hot', budget: 'under_150', needs: ['no_caffeine'] };
    const result = await runSuggest(
      baseArgs({ request: request({ inputs }), decider: null, fallbackReason: 'disabled' }),
    );
    if (result.candidateIds.length < 3) {
      expect(result.relaxHint).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Regression — real production sessions (Phase-7 "help me choose" quality
// pass). Root cause #1: food/dessert leaked into plain drink requests, and a
// hot food item was wrongly excluded by an iced-drink chip. Root cause #2:
// the 2-per-category shortlist cap starved a same-category request (e.g. "hot
// coffee") down to just 2 options for the decider to choose from.
// ---------------------------------------------------------------------------

describe('regression — production evidence sessions', () => {
  const traitsById = buildFixtureTraitsById();
  const menu = buildFixtureMenu();

  it('evidence #1: coffee + boost + hot + less_sugar + treat, no extras — no pick is ever food/dessert (fallback path)', async () => {
    const inputs: SuggestInputs = {
      temperature: 'hot',
      base: 'coffee',
      extras: [],
      needs: ['less_sugar'],
      budget: 'treat',
      mood: 'boost',
      note: '',
    };
    const result = await runSuggest(
      baseArgs({ request: request({ inputs }), menu, traitsById, decider: null, fallbackReason: 'disabled' }),
    );
    for (const id of result.pickIds) {
      expect(traitsById.get(id)!.kind, `${id} should never be food/dessert here`).toBe('drink');
    }
    if (result.usualItemId) {
      expect(traitsById.get(result.usualItemId)!.kind).toBe('drink');
    }
  });

  it('evidence #1 still holds when the decider answers (validated path) — an adversarial food pick is dropped', async () => {
    const inputs: SuggestInputs = {
      temperature: 'hot',
      base: 'coffee',
      extras: [],
      needs: ['less_sugar'],
      budget: 'treat',
      mood: 'boost',
      note: '',
    };
    // Mirrors the real session: the decider (adversarially) tries to include
    // "Baked Cheese Nachos" alongside real coffee picks.
    const decider: Decider = async ({ shortlist }) =>
      goodResult([
        { menuItemId: 'baked-cheese-nachos', reason: 'Nice', reasonCode: 'trait' },
        ...shortlist.slice(0, 2).map((c) => ({ menuItemId: c.menuItemId, reason: 'Nice', reasonCode: 'trait' as const })),
      ]);
    const result = await runSuggest(baseArgs({ request: request({ inputs }), menu, traitsById, decider }));
    for (const id of result.pickIds) {
      expect(traitsById.get(id)!.kind).toBe('drink');
    }
  });

  it('evidence #2: coffee + cosy + iced + less_sugar + extras:[light] — no pick is ever food/dessert, deterministic fallback included', async () => {
    const inputs: SuggestInputs = {
      temperature: 'iced',
      base: 'coffee',
      extras: ['light'],
      needs: ['less_sugar'],
      budget: 'any',
      mood: 'cosy',
      note: '',
    };
    const result = await runSuggest(
      baseArgs({ request: request({ inputs }), menu, traitsById, decider: null, fallbackReason: 'timeout' }),
    );
    for (const id of result.pickIds) {
      expect(traitsById.get(id)!.kind, `${id} should never be food/dessert here`).toBe('drink');
    }
  });

  it('boost + hot + coffee yields three coffee drinks when ≥3 exist (root cause #2: no more 2-per-category starving)', async () => {
    const inputs: SuggestInputs = { ...BASE_INPUTS, temperature: 'hot', base: 'coffee', mood: 'boost' };
    const result = await runSuggest(
      baseArgs({ request: request({ inputs }), menu, traitsById, decider: null, fallbackReason: 'disabled' }),
    );
    expect(result.picks.length).toBe(3);
    for (const id of result.pickIds) {
      const t = traitsById.get(id)!;
      expect(t.kind).toBe('drink');
      expect(t.is_coffee).toBe(true);
      expect(t.temperature === 'hot' || t.temperature === 'either').toBe(true);
    }
  });
});
