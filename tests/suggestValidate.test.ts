import { describe, expect, it } from 'vitest';
import { validateDeciderPicks, validateSuggestInputs, validateSuggestRequest } from '@/lib/suggest/validate';
import { filterCandidates } from '@/lib/suggest/filter';
import { scoreCandidates } from '@/lib/suggest/score';
import type { Candidate, DeciderResult, SuggestInputs } from '@/lib/suggest/types';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';
import { buildFixtureMenu, buildFixtureTraitsById } from './fixtures/suggestMenu';

function makeInputs(over: Partial<SuggestInputs> = {}): SuggestInputs {
  return {
    temperature: 'either',
    base: 'either',
    extras: [],
    needs: [],
    budget: 'any',
    mood: 'boost',
    note: '',
    ...over,
  };
}

function buildShortlistFixture(): Candidate[] {
  const items = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();
  const inputs = makeInputs();
  const filtered = filterCandidates(items, traitsById, inputs, []);
  return scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
}

describe('validateDeciderPicks', () => {
  const shortlist = buildShortlistFixture();
  const inputs = makeInputs();

  it('drops picks whose id is not in the shortlist', () => {
    const picks: DeciderResult['picks'] = [{ menuItemId: 'not-a-real-item', reason: 'A lovely pick.', reasonCode: 'trait' }];
    const out = validateDeciderPicks(picks, shortlist, inputs);
    expect(out.every((p) => p.menuItemId !== 'not-a-real-item')).toBe(true);
  });

  it('dedupes repeated ids', () => {
    const id = shortlist[0].menuItemId;
    const picks: DeciderResult['picks'] = [
      { menuItemId: id, reason: 'A lovely pick.', reasonCode: 'trait' },
      { menuItemId: id, reason: 'A lovely pick, again.', reasonCode: 'trait' },
    ];
    const out = validateDeciderPicks(picks, shortlist, inputs);
    expect(out.filter((p) => p.menuItemId === id)).toHaveLength(1);
  });

  it('replaces a reason that fails lintReason with the deterministic template', () => {
    const id = shortlist[0].menuItemId;
    const picks: DeciderResult['picks'] = [
      { menuItemId: id, reason: 'Since you spend a lot, hurry — this is the best deal.', reasonCode: 'trait' },
    ];
    const out = validateDeciderPicks(picks, shortlist, inputs);
    expect(out[0].reason).not.toMatch(/spend|hurry|best deal/i);
    expect(out[0].reason.length).toBeGreaterThan(0);
  });

  it('keeps a clean reason as-is', () => {
    const id = shortlist[0].menuItemId;
    const picks: DeciderResult['picks'] = [{ menuItemId: id, reason: 'A lovely pick — bold and smooth.', reasonCode: 'trait' }];
    const out = validateDeciderPicks(picks, shortlist, inputs);
    expect(out[0].reason).toBe('A lovely pick — bold and smooth.');
  });

  it('coerces an invalid reasonCode to "trait"', () => {
    const id = shortlist[0].menuItemId;
    const picks = [{ menuItemId: id, reason: 'A lovely pick.', reasonCode: 'not-a-real-code' }] as unknown as DeciderResult['picks'];
    const out = validateDeciderPicks(picks, shortlist, inputs);
    expect(out[0].reasonCode).toBe('trait');
  });

  it('tops up from the deterministic order when the model returns fewer than 3 valid picks', () => {
    const out = validateDeciderPicks([], shortlist, inputs);
    expect(out.length).toBe(Math.min(SUGGEST_LIMITS.picks, shortlist.length));
  });

  it('never returns more than SUGGEST_LIMITS.picks', () => {
    const picks: DeciderResult['picks'] = shortlist.slice(0, 6).map((c) => ({
      menuItemId: c.menuItemId,
      reason: 'A lovely pick.',
      reasonCode: 'trait' as const,
    }));
    const out = validateDeciderPicks(picks, shortlist, inputs);
    expect(out.length).toBeLessThanOrEqual(SUGGEST_LIMITS.picks);
  });

  it('every returned pick is a valid, distinct shortlist id (§5.4 core guarantee)', () => {
    const shortlistIds = new Set(shortlist.map((c) => c.menuItemId));
    const out = validateDeciderPicks([], shortlist, inputs);
    for (const p of out) expect(shortlistIds.has(p.menuItemId)).toBe(true);
    expect(new Set(out.map((p) => p.menuItemId)).size).toBe(out.length);
  });
});

describe('validateSuggestInputs', () => {
  const valid = () => ({
    temperature: 'hot',
    base: 'coffee',
    extras: ['sweet'],
    needs: ['no_caffeine'],
    budget: 'under_150',
    mood: 'boost',
    note: '  meeting a friend  ',
  });

  it('accepts a fully valid body and sanitizes the note', () => {
    const out = validateSuggestInputs(valid());
    expect(typeof out).not.toBe('string');
    if (typeof out !== 'string') {
      expect(out.note).toBe('meeting a friend');
      expect(out.temperature).toBe('hot');
    }
  });

  it('defaults an absent note to an empty string', () => {
    const body = valid() as Record<string, unknown>;
    delete body.note;
    const out = validateSuggestInputs(body);
    expect(typeof out).not.toBe('string');
    if (typeof out !== 'string') expect(out.note).toBe('');
  });

  it('rejects a non-object body', () => {
    expect(validateSuggestInputs(null)).toEqual(expect.any(String));
    expect(validateSuggestInputs('nope')).toEqual(expect.any(String));
    expect(validateSuggestInputs(undefined)).toEqual(expect.any(String));
  });

  it('rejects an invalid temperature/base/budget/mood', () => {
    expect(validateSuggestInputs({ ...valid(), temperature: 'lukewarm' })).toEqual(expect.any(String));
    expect(validateSuggestInputs({ ...valid(), base: 'tea' })).toEqual(expect.any(String));
    expect(validateSuggestInputs({ ...valid(), budget: 'unlimited' })).toEqual(expect.any(String));
    expect(validateSuggestInputs({ ...valid(), mood: 'furious' })).toEqual(expect.any(String));
  });

  it('rejects an invalid or duplicated extras/needs array', () => {
    expect(validateSuggestInputs({ ...valid(), extras: ['spicy'] })).toEqual(expect.any(String));
    expect(validateSuggestInputs({ ...valid(), extras: ['sweet', 'sweet'] })).toEqual(expect.any(String));
    expect(validateSuggestInputs({ ...valid(), needs: ['gluten_free'] })).toEqual(expect.any(String));
    expect(validateSuggestInputs({ ...valid(), needs: ['no_caffeine', 'no_caffeine'] })).toEqual(expect.any(String));
  });

  it('rejects a non-string note', () => {
    expect(validateSuggestInputs({ ...valid(), note: 42 })).toEqual(expect.any(String));
  });
});

describe('validateSuggestRequest', () => {
  const validInputs = {
    temperature: 'either',
    base: 'either',
    extras: [],
    needs: [],
    budget: 'any',
    mood: 'surprise',
    note: '',
  };

  it('accepts a minimal valid request (inputs only)', () => {
    const out = validateSuggestRequest({ inputs: validInputs });
    expect(typeof out).not.toBe('string');
  });

  it('propagates the inputs validation error', () => {
    const out = validateSuggestRequest({ inputs: { ...validInputs, mood: 'nope' } });
    expect(typeof out).toBe('string');
  });

  it('accepts optional anonId, refineOf and excludeItemIds', () => {
    const out = validateSuggestRequest({
      inputs: validInputs,
      anonId: 'anon-123',
      refineOf: 'session-456',
      excludeItemIds: ['a', 'b'],
    });
    expect(typeof out).not.toBe('string');
    if (typeof out !== 'string') {
      expect(out.anonId).toBe('anon-123');
      expect(out.refineOf).toBe('session-456');
      expect(out.excludeItemIds).toEqual(['a', 'b']);
    }
  });

  it('rejects excludeItemIds longer than SUGGEST_LIMITS.excludeMax', () => {
    const tooMany = Array.from({ length: SUGGEST_LIMITS.excludeMax + 1 }, (_, i) => `id-${i}`);
    const out = validateSuggestRequest({ inputs: validInputs, excludeItemIds: tooMany });
    expect(typeof out).toBe('string');
  });

  it('rejects a non-array excludeItemIds', () => {
    const out = validateSuggestRequest({ inputs: validInputs, excludeItemIds: 'nope' });
    expect(typeof out).toBe('string');
  });

  it('rejects a non-object body', () => {
    expect(validateSuggestRequest(null)).toEqual(expect.any(String));
    expect(validateSuggestRequest('nope')).toEqual(expect.any(String));
  });
});
