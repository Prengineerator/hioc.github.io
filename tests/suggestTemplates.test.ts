import { describe, expect, it } from 'vitest';
import { deterministicPicks, templateHeader, templateReason } from '@/lib/suggest/templates';
import { lintReason } from '@/lib/suggest/tone';
import { MOODS, SUGGEST_LIMITS } from '@/lib/suggest/types';
import type { Candidate, MenuItemTraits, SuggestInputs } from '@/lib/suggest/types';

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

function makeTraits(over: Partial<MenuItemTraits> & { menu_item_id: string }): MenuItemTraits {
  return {
    temperature: 'hot',
    caffeine: 'medium',
    is_coffee: true,
    sweetness: 1,
    body: 'medium',
    kind: 'drink',
    moods: [],
    dayparts: ['morning', 'afternoon', 'evening', 'late'],
    flavor_notes: [],
    source: 'opus',
    confirmed: true,
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function candidate(over: Partial<Candidate> & { menuItemId: string; category: string; score: number }): Candidate {
  return {
    name: over.menuItemId,
    minPriceInr: 100,
    maxPriceInr: 100,
    description: '',
    traits: makeTraits({ menu_item_id: over.menuItemId }),
    ...over,
  };
}

describe('templateHeader', () => {
  it('returns a distinct, non-empty header for every mood', () => {
    const headers = MOODS.map((m) => templateHeader(m));
    expect(new Set(headers).size).toBe(MOODS.length);
    for (const h of headers) expect(lintReason(h).ok).toBe(true);
  });
});

describe('templateReason — chocolatey/fruity clause (owner addition)', () => {
  const inputs = makeInputs({ extras: ['chocolatey'] });

  it("names the chocolatey flavour when the item's name/flavor_notes match and the extra was chosen", () => {
    const traits = makeTraits({ menu_item_id: 'mocha', flavor_notes: ['chocolate', 'coffee-forward'] });
    const reason = templateReason(traits, inputs, 'trait', 'Mocha');
    expect(reason).toMatch(/chocolat/i);
    expect(lintReason(reason).ok).toBe(true);
  });

  it("names the fruity flavour when the item's name/flavor_notes match and the extra was chosen", () => {
    const fruityInputs = makeInputs({ extras: ['fruity'] });
    const traits = makeTraits({ menu_item_id: 'berry-lemonade', flavor_notes: ['berry', 'citrus'] });
    const reason = templateReason(traits, fruityInputs, 'trait', 'Berry Lemonade Iced');
    expect(reason).toMatch(/fruity/i);
    expect(lintReason(reason).ok).toBe(true);
  });

  it('falls back to the generic flavor-note join when the extra was chosen but the item does not match it', () => {
    const traits = makeTraits({ menu_item_id: 'espresso', flavor_notes: ['bold', 'nutty'] });
    const reason = templateReason(traits, inputs, 'trait', 'Espresso');
    expect(reason).not.toMatch(/chocolat/i);
    expect(lintReason(reason).ok).toBe(true);
  });

  it('works without a name argument (e.g. the "usual" card call site) — flavor_notes alone still apply', () => {
    const traits = makeTraits({ menu_item_id: 'hot-chocolate', flavor_notes: ['chocolate'] });
    const reason = templateReason(traits, inputs, 'usual');
    expect(reason).toMatch(/chocolat/i);
    expect(lintReason(reason).ok).toBe(true);
  });
});

describe('deterministicPicks — variety tie-break (§5.3, root cause #2)', () => {
  it('prefers a different-category candidate when the next one is within 0.05 and shares the last pick\'s category', () => {
    // Top 3 by raw score are all 'Coffee' and mutually within 0.05 of each
    // other; a 'Tea' item sits just below, also within 0.05 of the top pick.
    // The tie-break should pull the Tea item in ahead of the 3rd coffee.
    const shortlist: Candidate[] = [
      candidate({ menuItemId: 'a-coffee', category: 'Coffee', score: 0.9 }),
      candidate({ menuItemId: 'b-coffee', category: 'Coffee', score: 0.89 }),
      candidate({ menuItemId: 'c-coffee', category: 'Coffee', score: 0.87 }),
      candidate({ menuItemId: 'd-tea', category: 'Tea', score: 0.86 }),
    ];
    const picks = deterministicPicks(shortlist, makeInputs());
    expect(picks).toHaveLength(SUGGEST_LIMITS.picks);
    expect(picks.map((p) => p.menuItemId)).toEqual(['a-coffee', 'd-tea', 'b-coffee']);
    // c-coffee (a 3rd, all-Coffee pick right after two others) is squeezed out.
    expect(picks.some((p) => p.menuItemId === 'c-coffee')).toBe(false);
  });

  it('never demotes a clearly better-scored item just for variety (score wins outside a tie)', () => {
    const shortlist: Candidate[] = [
      candidate({ menuItemId: 'best-coffee', category: 'Coffee', score: 0.9 }),
      candidate({ menuItemId: 'mid-tea', category: 'Tea', score: 0.6 }),
      candidate({ menuItemId: 'far-worse-coffee', category: 'Coffee', score: 0.5 }),
    ];
    const picks = deterministicPicks(shortlist, makeInputs());
    // Plain score order: best-coffee (0.9) > mid-tea (0.6) > far-worse-coffee (0.5).
    // No pair is within 0.05, so the tie-break never fires — the top-scored
    // order is exactly preserved, same-category or not.
    expect(picks.map((p) => p.menuItemId)).toEqual(['best-coffee', 'mid-tea', 'far-worse-coffee']);
  });

  it('every reason still lints clean and reasonCode follows the customer\'s mood when tagged', () => {
    const shortlist: Candidate[] = [
      candidate({ menuItemId: 'boost-item', category: 'Coffee', score: 0.9, traits: makeTraits({ menu_item_id: 'boost-item', moods: ['boost'] }) }),
      candidate({ menuItemId: 'other-item', category: 'Tea', score: 0.5 }),
    ];
    const picks = deterministicPicks(shortlist, makeInputs({ mood: 'boost' }));
    for (const p of picks) expect(lintReason(p.reason).ok).toBe(true);
    expect(picks.find((p) => p.menuItemId === 'boost-item')?.reasonCode).toBe('boost');
    expect(picks.find((p) => p.menuItemId === 'other-item')?.reasonCode).toBe('trait');
  });
});
