import { describe, expect, it } from 'vitest';
import { withInputDefaults } from '@/lib/suggest/inputs';
import { MMR_LAMBDA, pickSimilarity, selectDiversePicks } from '@/lib/suggest/select';
import type { Candidate, TraitKind, TraitTemperature } from '@/lib/suggest/types';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';
import { makeTraits } from './fixtures/suggestMenu';

// COFFEY-SPEC §4.4 — three DIFFERENT picks: kind coverage, then MMR
// (argmax score − 0.12·maxSim), returned best score first.

interface CandidateSpec {
  id: string;
  score?: number;
  category?: string;
  kind?: TraitKind;
  temperature?: TraitTemperature;
  name?: string;
  notes?: string[];
}

function cand(spec: CandidateSpec): Candidate {
  return {
    menuItemId: spec.id,
    name: spec.name ?? spec.id,
    score: spec.score ?? 0.5,
    minPriceInr: 100,
    maxPriceInr: 100,
    category: spec.category ?? 'Coffee',
    description: '',
    sugarAdjustable: false,
    traits: makeTraits({
      menu_item_id: spec.id,
      kind: spec.kind ?? 'drink',
      temperature: spec.temperature ?? 'hot',
      flavor_notes: spec.notes ?? [],
    }),
  };
}

function ranked(specs: CandidateSpec[]) {
  return specs.map((s) => ({ candidate: cand(s), score: s.score ?? 0.5 }));
}

const drinksOnly = withInputDefaults({ kinds: ['drink'] });
const ids = (picks: Candidate[]) => picks.map((p) => p.menuItemId);

describe('MMR_LAMBDA', () => {
  it('is the spec constant', () => {
    expect(MMR_LAMBDA).toBe(0.12);
  });
});

describe('pickSimilarity — 0.5·sameCategory + 0.3·sharesFamily + 0.2·(sameKind && sameTemperature)', () => {
  const base: CandidateSpec = { id: 'a', category: 'Coffee', kind: 'drink', temperature: 'hot', notes: [] };
  // Each `other` differs from `base` in everything except the one thing under test.
  const different: Partial<CandidateSpec> = { category: 'Waffles', kind: 'dessert', temperature: 'ambient' };

  it('is 1 for a twin: same category, a shared flavour family, same kind and temperature', () => {
    const a = cand({ ...base, notes: ['chocolate'] });
    const b = cand({ ...base, id: 'b', notes: ['cocoa'] });
    expect(pickSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  it('is 0 when nothing is shared', () => {
    expect(pickSimilarity(cand(base), cand({ ...different, id: 'b' }))).toBe(0);
  });

  it('weighs the same category at 0.5', () => {
    expect(pickSimilarity(cand(base), cand({ ...different, id: 'b', category: 'Coffee' }))).toBeCloseTo(0.5, 10);
  });

  it('weighs a shared flavour family at 0.3 — by NAME or by note', () => {
    const a = cand({ ...base, notes: ['chocolate'] });
    expect(pickSimilarity(a, cand({ ...different, id: 'b', notes: ['dark chocolate'] }))).toBeCloseTo(0.3, 10);
    // An item's own name counts, as it does for the scorer ("Nutella" is chocolatey).
    expect(pickSimilarity(a, cand({ ...different, id: 'b', name: 'Nutella Waffle' }))).toBeCloseTo(0.3, 10);
    // Different families share nothing.
    expect(pickSimilarity(a, cand({ ...different, id: 'b', notes: ['strawberry'] }))).toBe(0);
  });

  it('weighs "same kind AND same temperature" at 0.2 — one without the other scores nothing', () => {
    expect(pickSimilarity(cand(base), cand({ ...different, id: 'b', kind: 'drink', temperature: 'hot' }))).toBeCloseTo(0.2, 10);
    expect(pickSimilarity(cand(base), cand({ ...different, id: 'b', kind: 'drink', temperature: 'iced' }))).toBe(0);
    expect(pickSimilarity(cand(base), cand({ ...different, id: 'b', kind: 'dessert', temperature: 'hot' }))).toBe(0);
  });

  it('adds the parts up', () => {
    const a = cand({ ...base, notes: ['caramel'] });
    // same category + same kind/temperature
    expect(pickSimilarity(a, cand({ ...base, id: 'b' }))).toBeCloseTo(0.7, 10);
    // same category + shared family
    expect(pickSimilarity(a, cand({ ...base, id: 'b', notes: ['toffee'], temperature: 'iced' }))).toBeCloseTo(0.8, 10);
  });

  it('is symmetric', () => {
    const a = cand({ ...base, notes: ['chocolate'] });
    const b = cand({ ...different, id: 'b', category: 'Coffee', notes: ['chocolate'] });
    expect(pickSimilarity(a, b)).toBeCloseTo(pickSimilarity(b, a), 10);
  });
});

describe('selectDiversePicks — ordering', () => {
  it('returns SUGGEST_LIMITS.picks by default, best score first', () => {
    const picks = selectDiversePicks(
      ranked([
        { id: 'a', score: 0.9, category: 'C1' },
        { id: 'b', score: 0.8, category: 'C2' },
        { id: 'c', score: 0.7, category: 'C3' },
        { id: 'd', score: 0.6, category: 'C4' },
      ]),
      drinksOnly,
    );
    expect(picks).toHaveLength(SUGGEST_LIMITS.picks);
    expect(ids(picks)).toEqual(['a', 'b', 'c']);
  });

  it('sorts defensively: a list handed over in any order gives the same answer', () => {
    const specs: CandidateSpec[] = [
      { id: 'a', score: 0.9, category: 'C1' },
      { id: 'b', score: 0.8, category: 'C2' },
      { id: 'c', score: 0.7, category: 'C3' },
      { id: 'd', score: 0.6, category: 'C4' },
    ];
    const forward = ids(selectDiversePicks(ranked(specs), drinksOnly));
    const backward = ids(selectDiversePicks(ranked([...specs].reverse()), drinksOnly));
    const shuffled = ids(selectDiversePicks(ranked([specs[2], specs[0], specs[3], specs[1]]), drinksOnly));
    expect(backward).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('is stable: equal scores keep the caller\'s order', () => {
    const specs: CandidateSpec[] = [
      { id: 'x', score: 0.5, category: 'C1' },
      { id: 'y', score: 0.5, category: 'C2' },
      { id: 'z', score: 0.5, category: 'C3' },
    ];
    expect(ids(selectDiversePicks(ranked(specs), drinksOnly, 2))).toEqual(['x', 'y']);
    expect(ids(selectDiversePicks(ranked([...specs].reverse()), drinksOnly, 2))).toEqual(['z', 'y']);
  });

  it("orders the result by the ranked score, even when MMR picked out of order", () => {
    // 'b' is a near-twin of 'a', so MMR takes the unrelated 'c' second — but the
    // answer still reads best score first.
    const picks = selectDiversePicks(
      ranked([
        { id: 'a', score: 0.9, notes: ['chocolate'] },
        { id: 'b', score: 0.85, notes: ['chocolate'] },
        { id: 'c', score: 0.8, category: 'Iced Non-Coffee', temperature: 'iced', notes: ['lemon'] },
        { id: 'd', score: 0.7, category: 'Cold Brew', temperature: 'either' },
      ]),
      drinksOnly,
    );
    // The MMR picks are {a, c, b} in that order (b, a twin, comes last); the answer
    // is reordered a (0.9), b (0.85), c (0.8).
    expect(ids(picks)).toEqual(['a', 'b', 'c']);
  });

  it("ranks by the caller's score, not candidate.score (Jev's blended score is not the deterministic one)", () => {
    const low = cand({ id: 'low', score: 0.9, category: 'C1' }); // deterministic score high…
    const high = cand({ id: 'high', score: 0.1, category: 'C2' }); // …and low
    const picks = selectDiversePicks(
      [
        { candidate: low, score: 0.2 },
        { candidate: high, score: 0.95 },
      ],
      drinksOnly,
      1,
    );
    expect(ids(picks)).toEqual(['high']);
  });

  it('respects `count`, and returns everything there is when there are fewer candidates', () => {
    const specs: CandidateSpec[] = [
      { id: 'a', score: 0.9, category: 'C1' },
      { id: 'b', score: 0.8, category: 'C2' },
    ];
    expect(selectDiversePicks(ranked(specs), drinksOnly, 1)).toHaveLength(1);
    expect(selectDiversePicks(ranked(specs), drinksOnly, 3)).toHaveLength(2);
    expect(selectDiversePicks(ranked([]), drinksOnly)).toEqual([]);
    expect(selectDiversePicks(ranked(specs), drinksOnly, 0)).toEqual([]);
  });

  it('never picks the same item twice, even if it is listed twice', () => {
    const a = cand({ id: 'a', category: 'C1' });
    const b = cand({ id: 'b', category: 'C2' });
    const picks = selectDiversePicks(
      [
        { candidate: a, score: 0.9 },
        { candidate: a, score: 0.9 },
        { candidate: b, score: 0.8 },
      ],
      drinksOnly,
    );
    expect(ids(picks)).toEqual(['a', 'b']);
  });

  it('treats a non-finite score as the lowest score rather than breaking the sort', () => {
    const picks = selectDiversePicks(
      [
        { candidate: cand({ id: 'nan', category: 'C1' }), score: Number.NaN },
        { candidate: cand({ id: 'ok', category: 'C2' }), score: 0.4 },
      ],
      drinksOnly,
      1,
    );
    expect(ids(picks)).toEqual(['ok']);
  });

  it('keeps the concrete candidate type', () => {
    type Tagged = Candidate & { tag: string };
    const t: Tagged = { ...cand({ id: 'a' }), tag: 'kept' };
    const picks: Tagged[] = selectDiversePicks([{ candidate: t, score: 1 }], drinksOnly);
    expect(picks[0].tag).toBe('kept');
  });
});

describe('selectDiversePicks — MMR', () => {
  // A and B are twins (same category, same family, same kind and temperature):
  // similarity 1. C and D are unrelated to A and to each other.
  const pool: CandidateSpec[] = [
    { id: 'a', score: 0.9, category: 'Coffee', temperature: 'hot', notes: ['chocolate'] },
    { id: 'b', score: 0.89, category: 'Coffee', temperature: 'hot', notes: ['chocolate'] },
    { id: 'c', score: 0.8, category: 'Iced Non-Coffee', temperature: 'iced', notes: ['lemon'] },
    { id: 'd', score: 0.78, category: 'Cold Brew', temperature: 'either', notes: ['vanilla'] },
  ];

  it('demotes a near-duplicate: the twin of a pick loses to lower-scored but different items', () => {
    const picks = selectDiversePicks(ranked(pool), drinksOnly);
    // b (0.89) would be #2 on raw score; MMR marks it down by 0.12·1.0 = 0.77,
    // below c (0.80) and d (0.78).
    expect(ids(picks)).toEqual(['a', 'c', 'd']);
    expect(ids(picks)).not.toContain('b');
  });

  describe('is exactly argmax(score − MMR_LAMBDA · maxSim)', () => {
    // a is picked first; c (0.80) second. Then the twin b competes with d (0.70) for
    // the last slot at b − 0.12·1.0 versus 0.70 — so b needs a raw score above 0.82.
    const boundary = (twinScore: number) =>
      ranked([
        { id: 'a', score: 0.9, category: 'Coffee', temperature: 'hot', notes: ['chocolate'] },
        { id: 'b', score: twinScore, category: 'Coffee', temperature: 'hot', notes: ['chocolate'] },
        { id: 'c', score: 0.8, category: 'Iced Non-Coffee', temperature: 'iced', notes: ['lemon'] },
        { id: 'd', score: 0.7, category: 'Cold Brew', temperature: 'either', notes: ['vanilla'] },
      ]);

    it('a twin whose marked-down score still beats the alternative is picked', () => {
      const picks = selectDiversePicks(boundary(0.7 + MMR_LAMBDA + 0.01), drinksOnly);
      expect(ids(picks)).toEqual(['a', 'b', 'c']);
    });

    it('a twin whose marked-down score falls just short is not', () => {
      const picks = selectDiversePicks(boundary(0.7 + MMR_LAMBDA - 0.01), drinksOnly);
      expect(ids(picks)).toEqual(['a', 'c', 'd']);
    });
  });

  it('never promotes a poor item over a good one just for variety: a clear score gap wins', () => {
    const picks = selectDiversePicks(
      ranked([
        { id: 'a', score: 0.95, category: 'Coffee', notes: ['chocolate'] },
        { id: 'b', score: 0.94, category: 'Coffee', notes: ['chocolate'] }, // twin, but far better…
        { id: 'c', score: 0.3, category: 'Tea', temperature: 'iced', notes: ['lemon'] }, // …than this
        { id: 'd', score: 0.2, category: 'Cold Brew', temperature: 'either' },
      ]),
      drinksOnly,
    );
    expect(ids(picks)).toEqual(['a', 'b', 'c']);
  });

  it('measures similarity to EVERY pick so far, not just the last', () => {
    // After a and c, e is a twin of the FIRST pick a — not of c, the last one. It is
    // still marked down (0.84 − 0.12 = 0.72), so the unrelated f (0.77) overtakes it.
    const picks = selectDiversePicks(
      ranked([
        { id: 'a', score: 0.9, category: 'Coffee', temperature: 'hot', notes: ['chocolate'] },
        { id: 'c', score: 0.85, category: 'Iced Non-Coffee', temperature: 'iced', notes: ['lemon'] },
        { id: 'e', score: 0.84, category: 'Coffee', temperature: 'hot', notes: ['chocolate'] },
        { id: 'f', score: 0.77, category: 'Cold Brew', temperature: 'either', notes: ['vanilla'] },
      ]),
      drinksOnly,
    );
    expect(ids(picks)).toEqual(['a', 'c', 'f']);
  });

  it('with no penalty to apply (nothing similar), it is plain score order', () => {
    const picks = selectDiversePicks(
      ranked([
        { id: 'a', score: 0.3, category: 'C1', temperature: 'hot' },
        { id: 'b', score: 0.9, category: 'C2', temperature: 'iced' },
        { id: 'c', score: 0.6, category: 'C3', temperature: 'either' },
      ]),
      drinksOnly,
    );
    expect(ids(picks)).toEqual(['b', 'c', 'a']);
  });
});

describe('selectDiversePicks — kind coverage', () => {
  const pool: CandidateSpec[] = [
    { id: 'd1', score: 0.95, category: 'Coffee', kind: 'drink' },
    { id: 'd2', score: 0.94, category: 'Iced Coffee', kind: 'drink', temperature: 'iced' },
    { id: 'd3', score: 0.93, category: 'Cold Brew', kind: 'drink', temperature: 'either' },
    { id: 's1', score: 0.4, category: 'Cheesecakes', kind: 'dessert', temperature: 'ambient' },
    { id: 'f1', score: 0.3, category: 'Savouries', kind: 'food', temperature: 'hot' },
  ];

  it('asked for drink + dessert + food: one of each, even though drinks dominate the scores', () => {
    const picks = selectDiversePicks(ranked(pool), withInputDefaults({ kinds: ['drink', 'dessert', 'food'] }));
    expect(ids(picks)).toEqual(['d1', 's1', 'f1']); // and still best score first
  });

  it("takes each kind's BEST candidate", () => {
    const picks = selectDiversePicks(
      ranked([
        ...pool,
        { id: 's2', score: 0.6, category: 'Cupcakes', kind: 'dessert', temperature: 'ambient' },
        { id: 'f2', score: 0.5, category: 'Waffles', kind: 'food', temperature: 'hot' },
      ]),
      withInputDefaults({ kinds: ['drink', 'dessert', 'food'] }),
    );
    expect(ids(picks)).toEqual(['d1', 's2', 'f2']);
  });

  it('drink + dessert: a drink and a dessert first, then MMR for the last slot', () => {
    const picks = selectDiversePicks(ranked(pool), withInputDefaults({ kinds: ['drink', 'dessert'] }));
    expect(ids(picks)).toContain('d1');
    expect(ids(picks)).toContain('s1');
    expect(ids(picks)).not.toContain('f1'); // never a kind they did not ask for
    expect(picks).toHaveLength(3);
  });

  it('goes in KINDS order (drink, dessert, food), whatever order the customer ticked them', () => {
    // With only two slots, coverage runs out after drink and dessert.
    const picks = selectDiversePicks(ranked(pool), withInputDefaults({ kinds: ['food', 'dessert', 'drink'] }), 2);
    expect(ids(picks)).toEqual(['d1', 's1']);
  });

  it('skips a requested kind that has no candidate, and fills the slot by MMR', () => {
    const noFood = pool.filter((p) => p.kind !== 'food');
    const picks = selectDiversePicks(ranked(noFood), withInputDefaults({ kinds: ['drink', 'dessert', 'food'] }));
    expect(picks).toHaveLength(3);
    expect(ids(picks)).toContain('s1');
    expect(picks.some((p) => p.traits.kind === 'food')).toBe(false);
  });

  it('applies to a single kind not at all: it is just MMR over what there is', () => {
    const picks = selectDiversePicks(ranked(pool), withInputDefaults({ kinds: ['drink'] }));
    // s1 and f1 score far below three drinks, and coverage is off with one kind.
    expect(ids(picks)).toEqual(['d1', 'd2', 'd3']);
  });

  it('coverage picks are chosen before MMR can second-guess them', () => {
    // The only dessert is a near-twin of the top drink; coverage still takes it.
    const picks = selectDiversePicks(
      ranked([
        { id: 'd1', score: 0.95, category: 'Bakery', kind: 'drink', temperature: 'ambient', notes: ['chocolate'] },
        { id: 's1', score: 0.2, category: 'Bakery', kind: 'dessert', temperature: 'ambient', notes: ['chocolate'] },
        { id: 'd2', score: 0.9, category: 'Coffee', kind: 'drink' },
      ]),
      withInputDefaults({ kinds: ['drink', 'dessert'] }),
    );
    expect(ids(picks)).toContain('s1');
  });
});
