import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 — lib/suggest/jevDecider.ts: the Jev (TypeSafe AI) picks decider
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.4). The SDK is mocked at the
// module level — no network, no real key — keeping the REAL choice()/noul()/
// score() builders and error classes from the actual package so `instanceof`
// checks in jevDecider.ts's error mapping still work.

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));

vi.mock('@typesafe-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@typesafe-ai/sdk')>();
  return {
    ...actual,
    TypeSafeClient: vi.fn().mockImplementation(() => ({ systemOne: systemOneMock })),
  };
});

import { APIError, APITimeoutError, APIUserAbortError, RateLimitError } from '@typesafe-ai/sdk';
import { DeciderError } from '@/lib/suggest/deciderError';
import { jevDecider } from '@/lib/suggest/jevDecider';
import { lintReason } from '@/lib/suggest/tone';
import { filterCandidates } from '@/lib/suggest/filter';
import { scoreCandidates } from '@/lib/suggest/score';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';
import type { Candidate, SuggestInputs } from '@/lib/suggest/types';
import { buildFixtureMenu, buildFixtureTraitsById } from './fixtures/suggestMenu';

const BASE_INPUTS: SuggestInputs = {
  temperature: 'either',
  base: 'either',
  extras: [],
  needs: [],
  budget: 'any',
  mood: 'boost',
  note: '',
};

function buildShortlist(): Candidate[] {
  const items = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();
  const filtered = filterCandidates(items, traitsById, BASE_INPUTS, []);
  return scoreCandidates({ candidates: filtered, inputs: BASE_INPUTS, profile: null, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
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
  vi.clearAllMocks();
});

function args(overrides: Partial<Parameters<typeof jevDecider>[0]> = {}) {
  return {
    inputs: BASE_INPUTS,
    shortlist: buildShortlist(),
    profile: null,
    daypart: 'afternoon' as const,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('jevDecider — ranking', () => {
  it('ranks candidates by answers.best.probabilities and returns the top 3, each with a template reason that passes lintReason', async () => {
    const shortlist = buildShortlist();
    expect(shortlist.length).toBeGreaterThanOrEqual(4);
    const ids = shortlist.map((c) => c.menuItemId);

    // Deliberately NOT already-sorted-by-shortlist-order, so a passing test
    // proves the decider re-sorts by probability rather than just echoing
    // the shortlist's own order.
    const probabilities: Record<string, number> = {};
    ids.forEach((id, i) => {
      probabilities[id] = i === 0 ? 0.1 : i === 1 ? 0.5 : i === 2 ? 0.9 : i === 3 ? 0.3 : 0.05;
    });
    systemOneMock.mockResolvedValueOnce({
      model: 'jev-latest',
      answers: { best: { type: 'choice', choice: ids[2], confidence: 0.9, probabilities } },
      usage: { input_tokens: 400, output_tokens: 0 },
    });

    const result = await jevDecider(args({ shortlist }));

    expect(result.picks.map((p) => p.menuItemId)).toEqual([ids[2], ids[1], ids[3]]);
    expect(result.picks).toHaveLength(SUGGEST_LIMITS.picks);
    expect(result.header).toBeNull();
    expect(result.model).toBe('jev:jev-latest');
    expect(result.inputTokens).toBe(400);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.costUsdMicros).toBe(Math.round(400 * 0.042));
    for (const pick of result.picks) {
      expect(lintReason(pick.reason).ok).toBe(true);
    }
  });

  it('ties break by the shortlist\'s own order', async () => {
    const shortlist = buildShortlist();
    const ids = shortlist.map((c) => c.menuItemId);
    const probabilities: Record<string, number> = {};
    for (const id of ids) probabilities[id] = 0.5; // every candidate tied
    systemOneMock.mockResolvedValueOnce({
      model: 'jev-latest',
      answers: { best: { type: 'choice', choice: ids[0], confidence: 0.5, probabilities } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    const result = await jevDecider(args({ shortlist }));
    expect(result.picks.map((p) => p.menuItemId)).toEqual(ids.slice(0, SUGGEST_LIMITS.picks));
  });

  it('assigns reasonCode = the customer\'s mood when the pick is tagged for it, else "trait"', async () => {
    const shortlist = buildShortlist();
    const boostItem = shortlist.find((c) => c.traits.moods.includes('boost'));
    const nonBoostItem = shortlist.find((c) => !c.traits.moods.includes('boost'));
    expect(boostItem).toBeDefined();
    expect(nonBoostItem).toBeDefined();

    const probabilities: Record<string, number> = { [boostItem!.menuItemId]: 0.9, [nonBoostItem!.menuItemId]: 0.8 };
    systemOneMock.mockResolvedValueOnce({
      model: 'jev-latest',
      answers: { best: { type: 'choice', choice: boostItem!.menuItemId, confidence: 0.9, probabilities } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    const result = await jevDecider(args({ shortlist, inputs: { ...BASE_INPUTS, mood: 'boost' } }));
    const boostPick = result.picks.find((p) => p.menuItemId === boostItem!.menuItemId);
    const nonBoostPick = result.picks.find((p) => p.menuItemId === nonBoostItem!.menuItemId);
    expect(boostPick?.reasonCode).toBe('boost');
    expect(nonBoostPick?.reasonCode).toBe('trait');
  });
});

describe('jevDecider — state contains no PII (S-3)', () => {
  it('never includes a name/phone/email/order key', async () => {
    const shortlist = buildShortlist();
    const ids = shortlist.map((c) => c.menuItemId);
    const probabilities: Record<string, number> = {};
    for (const id of ids) probabilities[id] = 1 / ids.length;
    systemOneMock.mockResolvedValueOnce({
      model: 'jev-latest',
      answers: { best: { type: 'choice', choice: ids[0], confidence: 0.4, probabilities } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    await jevDecider(args({ shortlist }));

    expect(systemOneMock).toHaveBeenCalledTimes(1);
    const [request] = systemOneMock.mock.calls[0] as [{ state: unknown }];
    const state = request.state as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(['candidates', 'customer', 'daypart', 'profile']);
    // Menu item `name` is expected (it's product data, not PII) — what must
    // never appear is anything that could identify the CUSTOMER.
    const serialized = JSON.stringify(state).toLowerCase();
    for (const forbidden of ['phone', 'email', 'order_id', 'order id', 'user_id', 'customer_id', 'session_id']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('jevDecider — error mapping (§5.4 "Fallback triggers")', () => {
  it('APITimeoutError -> DeciderError(timeout)', async () => {
    systemOneMock.mockRejectedValueOnce(new APITimeoutError(5000));
    await expect(jevDecider(args())).rejects.toMatchObject({ kind: 'timeout' } satisfies Partial<DeciderError>);
  });

  it('APIUserAbortError -> DeciderError(timeout)', async () => {
    systemOneMock.mockRejectedValueOnce(new APIUserAbortError('aborted'));
    await expect(jevDecider(args())).rejects.toMatchObject({ kind: 'timeout' } satisfies Partial<DeciderError>);
  });

  it('RateLimitError (429) -> DeciderError(error) without the API key in the message', async () => {
    systemOneMock.mockRejectedValueOnce(new RateLimitError(429, { error: 'rate limited' }, new Headers(), 'Too Many Requests'));
    try {
      await jevDecider(args());
      expect.fail('expected jevDecider to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(DeciderError);
      expect((err as DeciderError).kind).toBe('error');
      expect((err as DeciderError).message).not.toContain('jev-test-secret-should-never-leak');
      expect((err as DeciderError).message).toContain('429');
    }
  });

  it('a generic 500 APIError -> DeciderError(error) without the API key in the message', async () => {
    systemOneMock.mockRejectedValueOnce(new APIError(500, { error: 'boom' }, new Headers(), 'Internal Server Error'));
    try {
      await jevDecider(args());
      expect.fail('expected jevDecider to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(DeciderError);
      expect((err as DeciderError).kind).toBe('error');
      expect((err as DeciderError).message).not.toContain('jev-test-secret-should-never-leak');
      expect((err as DeciderError).message).toContain('500');
    }
  });

  it('a missing "best" answer -> DeciderError(invalid_output)', async () => {
    systemOneMock.mockResolvedValueOnce({ model: 'jev-latest', answers: {}, usage: { input_tokens: 10, output_tokens: 0 } });
    await expect(jevDecider(args())).rejects.toMatchObject({ kind: 'invalid_output' } satisfies Partial<DeciderError>);
  });

  it('empty probabilities -> DeciderError(invalid_output)', async () => {
    systemOneMock.mockResolvedValueOnce({
      model: 'jev-latest',
      answers: { best: { type: 'choice', choice: 'x', confidence: 0.5, probabilities: {} } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    await expect(jevDecider(args())).rejects.toMatchObject({ kind: 'invalid_output' } satisfies Partial<DeciderError>);
  });

  it('a plain connection-failure Error -> DeciderError(error)', async () => {
    systemOneMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(jevDecider(args())).rejects.toMatchObject({ kind: 'error' } satisfies Partial<DeciderError>);
  });
});
