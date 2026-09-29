import { describe, expect, it } from 'vitest';
import { isLegacyInputsBody, moodsOf, upgradeV1Inputs, withInputDefaults } from '@/lib/suggest/inputs';
import type { LegacyExtra, LegacyNeed, LegacySuggestInputs, Mood } from '@/lib/suggest/types';
import { BUDGETS, KINDS, LEGACY_BUDGETS, LEGACY_EXTRAS, MOODS } from '@/lib/suggest/types';

/** The six moods v1 had — 'focus' and 'unwind' are new in Coffey. */
const V1_MOODS = MOODS.filter((m): m is Exclude<Mood, 'focus' | 'unwind'> => m !== 'focus' && m !== 'unwind');

// COFFEY-SPEC §2 — the v1 → v2 mapping, one case per row of the table, plus the
// precedence rules the table calls out. The mapping is "a lossless mapping of v1
// BEHAVIOUR", so the last block re-derives v1's composition rule and checks the
// upgrade admits exactly the same kinds.

function legacy(over: Partial<LegacySuggestInputs> = {}): LegacySuggestInputs {
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

describe('upgradeV1Inputs — the §2 table', () => {
  it('a bare v1 body becomes a neutral v2 request for a drink, carrying the untouched fields across', () => {
    const v2 = upgradeV1Inputs(
      legacy({ temperature: 'iced', base: 'coffee', budget: 'under_150', mood: 'cosy', note: 'studying' }),
    );
    expect(v2).toEqual({
      mood: 'cosy',
      secondaryMood: null, // row 1: mood → mood; secondaryMood null
      kinds: ['drink'], // row 2: kinds starts as ['drink']
      temperature: 'iced',
      base: 'coffee',
      strength: 'any', // last row: strength 'any'
      sweetness: 'any', // …sweetness 'any'
      body: 'any', // …and body 'any' unless set
      flavours: [],
      needs: [],
      budget: 'under_150',
      note: 'studying',
    });
  });

  it('extras: eat → kinds += dessert, food', () => {
    const v2 = upgradeV1Inputs(legacy({ extras: ['eat'] }));
    expect(v2.kinds).toEqual(['drink', 'dessert', 'food']);
    expect(v2.body).toBe('any');
    expect(v2.sweetness).toBe('any');
  });

  it("extras: filling → kinds += dessert, food; body 'rich'", () => {
    const v2 = upgradeV1Inputs(legacy({ extras: ['filling'] }));
    expect(v2.kinds).toEqual(['drink', 'dessert', 'food']);
    expect(v2.body).toBe('rich');
  });

  it("extras: light → body 'light', and no extra kinds", () => {
    const v2 = upgradeV1Inputs(legacy({ extras: ['light'] }));
    expect(v2.body).toBe('light');
    expect(v2.kinds).toEqual(['drink']);
  });

  it("extras: light AND filling → body 'any' (they cancel), but filling still admits food and dessert", () => {
    const v2 = upgradeV1Inputs(legacy({ extras: ['light', 'filling'] }));
    expect(v2.body).toBe('any');
    expect(v2.kinds).toEqual(['drink', 'dessert', 'food']);
    // …in either order.
    expect(upgradeV1Inputs(legacy({ extras: ['filling', 'light'] })).body).toBe('any');
  });

  it("extras: sweet → kinds += dessert (never food); sweetness 'sweet'", () => {
    const v2 = upgradeV1Inputs(legacy({ extras: ['sweet'] }));
    expect(v2.kinds).toEqual(['drink', 'dessert']);
    expect(v2.sweetness).toBe('sweet');
  });

  it('mood: celebrate → kinds += dessert (the v1 composition rule) — and no other mood does', () => {
    expect(upgradeV1Inputs(legacy({ mood: 'celebrate' })).kinds).toEqual(['drink', 'dessert']);
    for (const mood of V1_MOODS.filter((m) => m !== 'celebrate')) {
      expect(upgradeV1Inputs(legacy({ mood })).kinds, mood).toEqual(['drink']);
    }
  });

  it('extras: chocolatey / fruity → flavours += chocolatey / fruity, and they are soft: no kinds, no filters', () => {
    expect(upgradeV1Inputs(legacy({ extras: ['chocolatey'] })).flavours).toEqual(['chocolatey']);
    expect(upgradeV1Inputs(legacy({ extras: ['fruity'] })).flavours).toEqual(['fruity']);
    const both = upgradeV1Inputs(legacy({ extras: ['fruity', 'chocolatey'] }));
    // FLAVOUR_FAMILIES order, whatever order the extras came in.
    expect(both.flavours).toEqual(['chocolatey', 'fruity']);
    expect(both.kinds).toEqual(['drink']);
  });

  it("needs: less_sugar → sweetness 'light', and is removed from needs", () => {
    const v2 = upgradeV1Inputs(legacy({ needs: ['less_sugar'] }));
    expect(v2.sweetness).toBe('light');
    expect(v2.needs).toEqual([]);
  });

  it('needs: no_caffeine survives, whatever else is in needs', () => {
    expect(upgradeV1Inputs(legacy({ needs: ['no_caffeine'] })).needs).toEqual(['no_caffeine']);
    expect(upgradeV1Inputs(legacy({ needs: ['less_sugar', 'no_caffeine'] })).needs).toEqual(['no_caffeine']);
    expect(upgradeV1Inputs(legacy({ needs: ['no_caffeine', 'less_sugar'] })).needs).toEqual(['no_caffeine']);
  });
});

describe('upgradeV1Inputs — budget: v1 bands and "Treat myself" become ceilings (§2, §1)', () => {
  it('under_150 stays under_150 — the one v1 budget that was already a ceiling', () => {
    expect(upgradeV1Inputs(legacy({ budget: 'under_150' })).budget).toBe('under_150');
  });

  it('150_300 → any: the band hid every item under ₹150, so it cannot be kept as a ceiling of 300', () => {
    expect(upgradeV1Inputs(legacy({ budget: '150_300' })).budget).toBe('any');
  });

  it('treat → any: "Treat myself" never filtered anything', () => {
    expect(upgradeV1Inputs(legacy({ budget: 'treat' })).budget).toBe('any');
  });

  it('any → any', () => {
    expect(upgradeV1Inputs(legacy({ budget: 'any' })).budget).toBe('any');
  });

  it('every v1 budget lands on a valid v2 budget', () => {
    for (const budget of LEGACY_BUDGETS) {
      expect(BUDGETS as readonly string[], budget).toContain(upgradeV1Inputs(legacy({ budget })).budget);
    }
  });

  it('never invents the ceilings v1 had no way to ask for', () => {
    for (const budget of LEGACY_BUDGETS) {
      expect(['under_100', 'under_200'], budget).not.toContain(upgradeV1Inputs(legacy({ budget })).budget);
    }
  });
});

describe('upgradeV1Inputs — precedence rules', () => {
  it("less_sugar wins over extras: sweet (the customer's limit beats the soft preference)", () => {
    const v2 = upgradeV1Inputs(legacy({ extras: ['sweet'], needs: ['less_sugar'] }));
    expect(v2.sweetness).toBe('light');
    // 'sweet' still did its other job: v1 admitted dessert for it.
    expect(v2.kinds).toEqual(['drink', 'dessert']);
    // …and order in the arrays is irrelevant.
    expect(upgradeV1Inputs(legacy({ extras: ['sweet', 'eat'], needs: ['no_caffeine', 'less_sugar'] })).sweetness).toBe('light');
  });

  it('kinds is de-duplicated, in KINDS order, and always starts with drink', () => {
    const v2 = upgradeV1Inputs(legacy({ extras: ['filling', 'sweet', 'eat'], mood: 'celebrate' }));
    expect(v2.kinds).toEqual(['drink', 'dessert', 'food']);
    expect(new Set(v2.kinds).size).toBe(v2.kinds.length);
    for (const extras of [[], ['eat'], ['sweet'], ['filling', 'eat']] as LegacyExtra[][]) {
      for (const mood of ['boost', 'celebrate'] as const) {
        const kinds = upgradeV1Inputs(legacy({ extras, mood })).kinds;
        expect(kinds[0]).toBe('drink');
        expect(kinds).toEqual(KINDS.filter((k) => kinds.includes(k)));
      }
    }
  });

  it('does not mutate the v1 body it was handed', () => {
    const v1 = legacy({ extras: ['eat', 'light'], needs: ['less_sugar', 'no_caffeine'] });
    const before = JSON.parse(JSON.stringify(v1));
    upgradeV1Inputs(v1);
    expect(v1).toEqual(before);
  });
});

describe('upgradeV1Inputs — a lossless mapping of v1 BEHAVIOUR', () => {
  // v1's composition rule (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.2.2): food
  // for eat|filling; dessert for eat|sweet|filling or a celebrating mood; else
  // drinks only. The upgraded `kinds` must admit exactly what it admitted.
  const subsets = (all: readonly LegacyExtra[]): LegacyExtra[][] =>
    all.reduce<LegacyExtra[][]>((acc, e) => [...acc, ...acc.map((s) => [...s, e])], [[]]);

  it('admits the same kinds as v1 for every extras subset × mood', () => {
    for (const extras of subsets(LEGACY_EXTRAS)) {
      for (const mood of V1_MOODS) {
        for (const needs of [[], ['less_sugar'], ['no_caffeine', 'less_sugar']] as LegacyNeed[][]) {
          const v1 = legacy({ extras, mood, needs });
          const v2 = upgradeV1Inputs(v1);
          const wantsFood = extras.includes('eat') || extras.includes('filling');
          const wantsDessert = wantsFood || extras.includes('sweet') || mood === 'celebrate';
          const label = `${extras.join('+') || 'none'} / ${mood} / ${needs.join('+') || 'none'}`;
          expect(v2.kinds.includes('food'), `food: ${label}`).toBe(wantsFood);
          expect(v2.kinds.includes('dessert'), `dessert: ${label}`).toBe(wantsDessert);
          expect(v2.kinds.includes('drink'), `drink: ${label}`).toBe(true);
        }
      }
    }
  });

  it('never invents a v2-only preference: strength and secondaryMood are always neutral', () => {
    for (const extras of subsets(LEGACY_EXTRAS)) {
      const v2 = upgradeV1Inputs(legacy({ extras }));
      expect(v2.strength).toBe('any');
      expect(v2.secondaryMood).toBeNull();
    }
  });
});

describe('isLegacyInputsBody', () => {
  it('is true when the body has neither `kinds` nor `sweetness`', () => {
    expect(isLegacyInputsBody({ temperature: 'hot', extras: [] })).toBe(true);
    expect(isLegacyInputsBody({})).toBe(true);
  });

  it('is false as soon as either v2-only field is present', () => {
    expect(isLegacyInputsBody({ kinds: ['drink'] })).toBe(false);
    expect(isLegacyInputsBody({ sweetness: 'any' })).toBe(false);
    expect(isLegacyInputsBody({ kinds: ['drink'], sweetness: 'any', extras: [] })).toBe(false);
  });

  it('counts a present-but-wrong value as v2, so it fails v2 validation with a v2 message', () => {
    expect(isLegacyInputsBody({ kinds: null })).toBe(false);
    expect(isLegacyInputsBody({ sweetness: null })).toBe(false);
  });
});

describe('withInputDefaults', () => {
  it('is neutral: surprise, no second feeling, a drink, and no preference on anything else', () => {
    expect(withInputDefaults()).toEqual({
      mood: 'surprise',
      secondaryMood: null,
      kinds: ['drink'],
      temperature: 'either',
      base: 'either',
      strength: 'any',
      sweetness: 'any',
      body: 'any',
      flavours: [],
      needs: [],
      budget: 'any',
      note: '',
    });
  });

  it('applies overrides on top', () => {
    const inputs = withInputDefaults({ mood: 'boost', secondaryMood: 'cool', kinds: ['drink', 'dessert'], sweetness: 'none' });
    expect(inputs.mood).toBe('boost');
    expect(inputs.secondaryMood).toBe('cool');
    expect(inputs.kinds).toEqual(['drink', 'dessert']);
    expect(inputs.sweetness).toBe('none');
    expect(inputs.temperature).toBe('either');
  });

  it('hands back fresh arrays every call, so one test cannot leak state into the next', () => {
    const a = withInputDefaults();
    a.kinds.push('food');
    a.flavours.push('nutty');
    a.needs.push('no_caffeine');
    const b = withInputDefaults();
    expect(b.kinds).toEqual(['drink']);
    expect(b.flavours).toEqual([]);
    expect(b.needs).toEqual([]);
  });
});

describe('moodsOf', () => {
  it('is [mood] alone, or [mood, secondaryMood] with the primary first', () => {
    expect(moodsOf({ mood: 'boost', secondaryMood: null })).toEqual(['boost']);
    expect(moodsOf({ mood: 'boost', secondaryMood: 'cool' })).toEqual(['boost', 'cool']);
    expect(moodsOf(withInputDefaults({ mood: 'focus', secondaryMood: 'boost' }))).toEqual(['focus', 'boost']);
  });
});
