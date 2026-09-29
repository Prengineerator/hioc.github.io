import { describe, expect, it } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.2) — how Jev's answers become a trait row,
// and which rows get a "please check this" hint. Pure: the answers are plain
// objects, no SDK and no network. tests/suggestJevTraits.test.ts drives the
// same rules end to end through the mocked client.

import { jevNeedsReview, traitRowFromAnswers, type JevAnswers } from '@/lib/suggest/traitsPrompt';
import { buildJevTraitQuestions } from '@/lib/suggest/traitsPrompt';
import { FLAVOR_VOCABULARY, TEXTURES } from '@/lib/suggest/traitVocabulary';
import { CURRENT_TRAITS_VERSION, DAYPARTS, MOODS } from '@/lib/suggest/types';

/** An answer for every question — confident, valid, and neutral. */
function answers(overrides: JevAnswers = {}): JevAnswers {
  const out: JevAnswers = {};
  for (const [key, question] of Object.entries(buildJevTraitQuestions())) {
    if (question.type === 'noul') out[key] = { noul: 0 };
    else if (question.type === 'score') out[key] = { score: 0, confidence: 0.9 };
    else out[key] = { choice: Object.keys(question.criteria)[0], confidence: 0.9 };
  }
  Object.assign(out, {
    temperature: { choice: 'iced', confidence: 0.9 },
    caffeine: { choice: 'medium', confidence: 0.9 },
    is_coffee: { noul: 0.9 },
    kind: { choice: 'drink', confidence: 0.9 },
    body: { choice: 'medium', confidence: 0.9 },
    sweetness: { score: 2, confidence: 0.9 },
  });
  return { ...out, ...overrides };
}

const row = (overrides: JevAnswers = {}) => {
  const r = traitRowFromAnswers('item-1', answers(overrides));
  if (!r) throw new Error('expected a valid row');
  return r;
};

const flavor = (note: string) => `flavor_${FLAVOR_VOCABULARY.findIndex((f) => f.note === note)}`;

describe('traitRowFromAnswers — the choice fields', () => {
  it('takes temperature, caffeine, kind and body straight from the choice', () => {
    const r = row();
    expect(r).toMatchObject({ menu_item_id: 'item-1', temperature: 'iced', caffeine: 'medium', kind: 'drink', body: 'medium' });
  });

  it('is_coffee is P(yes) >= 0.5', () => {
    expect(row({ is_coffee: { noul: 0.5 } }).is_coffee).toBe(true);
    expect(row({ is_coffee: { noul: 0.4999 } }).is_coffee).toBe(false);
  });

  it('stamps every row with the current trait version', () => {
    expect(row().traits_version).toBe(CURRENT_TRAITS_VERSION);
  });

  it('returns null when a choice is missing or outside the vocabulary', () => {
    expect(traitRowFromAnswers('item-1', answers({ temperature: { confidence: 0.9 } }))).toBeNull();
    expect(traitRowFromAnswers('item-1', answers({ caffeine: { choice: 'extreme', confidence: 0.9 } }))).toBeNull();
    expect(traitRowFromAnswers('item-1', answers({ kind: { choice: 'beverage', confidence: 0.9 } }))).toBeNull();
  });
});

describe('traitRowFromAnswers — sweetness (COFFEY-SPEC §3.2: clamp(round(score x 2), 0, 10))', () => {
  const levelFor = (score: number) => row({ sweetness: { score, confidence: 0.9 } }).sweetness_level;

  it.each([
    [0, 0],
    [0.2, 0], // 0.4 → 0
    [0.25, 1], // 0.5 rounds up
    [1, 2],
    [2, 4],
    [2.5, 5],
    [2.6, 5], // 5.2
    [2.75, 6], // 5.5 rounds up
    [4, 8],
    [4.7, 9], // 9.4
    [5, 10],
  ])('score %f → level %i', (score, level) => {
    expect(levelFor(score)).toBe(level);
  });

  it('clamps below 0 and above 10', () => {
    expect(levelFor(-1)).toBe(0);
    expect(levelFor(-0.3)).toBe(0);
    expect(levelFor(5.4)).toBe(10);
    expect(levelFor(7)).toBe(10);
  });

  it('derives the legacy 0–3 sweetness from the level: <=1 → 0, <=4 → 1, <=7 → 2, else 3', () => {
    const legacyFor = (level: number) => row({ sweetness: { score: level / 2, confidence: 0.9 } }).sweetness;
    expect([0, 1].map(legacyFor)).toEqual([0, 0]);
    expect([2, 3, 4].map(legacyFor)).toEqual([1, 1, 1]);
    expect([5, 6, 7].map(legacyFor)).toEqual([2, 2, 2]);
    expect([8, 9, 10].map(legacyFor)).toEqual([3, 3, 3]);
  });

  it('a missing sweetness answer is level 0, not a dropped row', () => {
    const a = answers();
    delete a.sweetness;
    expect(traitRowFromAnswers('item-1', a)?.sweetness_level).toBe(0);
  });
});

describe('traitRowFromAnswers — intensity, refreshment, indulgence, novelty (clamp(round(score), 0, 3))', () => {
  it.each([
    [0, 0],
    [0.49, 0],
    [0.5, 1],
    [1.4, 1],
    [1.5, 2],
    [2.6, 3],
    [3, 3],
    [3.7, 3],
    [-0.4, 0],
  ])('score %f → %i', (score, expected) => {
    const r = row({
      intensity: { score, confidence: 0.9 },
      refreshment: { score, confidence: 0.9 },
      indulgence: { score, confidence: 0.9 },
      novelty: { score, confidence: 0.9 },
    });
    expect([r.intensity, r.refreshment, r.indulgence, r.novelty]).toEqual([expected, expected, expected, expected]);
  });
});

describe('traitRowFromAnswers — mood_fit and moods', () => {
  it('stores a fit for every mood, one decimal each', () => {
    const r = row({ mood_boost: { score: 2.26 }, mood_focus: { score: 0.04 }, mood_cool: { score: 3 } });
    expect(Object.keys(r.mood_fit).sort()).toEqual([...MOODS].sort());
    expect(r.mood_fit).toMatchObject({ boost: 2.3, focus: 0, cool: 3, cosy: 0 });
  });

  it('rounds half up to one decimal: 1.25 → 1.3, 2.34 → 2.3, 2.36 → 2.4', () => {
    const r = row({ mood_cosy: { score: 1.25 }, mood_comfort: { score: 2.34 }, mood_celebrate: { score: 2.36 } });
    expect(r.mood_fit).toMatchObject({ cosy: 1.3, comfort: 2.3, celebrate: 2.4 });
  });

  it('a mood score that is not a number drops the row — garbage does not quietly become "no fit"', () => {
    expect(traitRowFromAnswers('item-1', answers({ mood_cool: { score: Number.NaN } }))).toBeNull();
  });

  it('clamps a fit into 0–3', () => {
    const r = row({ mood_boost: { score: 3.4 }, mood_cool: { score: -0.2 } });
    expect(r.mood_fit.boost).toBe(3);
    expect(r.mood_fit.cool).toBe(0);
  });

  it('moods are those with fit >= 2, highest first', () => {
    const r = row({ mood_cool: { score: 2.4 }, mood_boost: { score: 2.9 }, mood_cosy: { score: 2 }, mood_comfort: { score: 1.99 } });
    // comfort 1.99 rounds to 2.0 in the stored fit, so it qualifies too — but only the best three are kept
    expect(r.moods).toEqual(['boost', 'cool', 'cosy']);
  });

  it('caps moods at three, best fit first', () => {
    const r = row({
      mood_boost: { score: 2.5 },
      mood_focus: { score: 2.6 },
      mood_cosy: { score: 2.7 },
      mood_comfort: { score: 2.8 },
      mood_celebrate: { score: 2.9 },
    });
    expect(r.moods).toEqual(['celebrate', 'comfort', 'cosy']);
  });

  it('breaks ties in MOODS order', () => {
    const r = row({ mood_surprise: { score: 2.5 }, mood_focus: { score: 2.5 }, mood_cool: { score: 2.5 }, mood_boost: { score: 2.5 } });
    // MOODS = boost, focus, unwind, cosy, comfort, celebrate, cool, surprise
    expect(r.moods).toEqual(['boost', 'focus', 'cool']);
  });

  it('a fit of exactly 2 qualifies; 1.94 (rounds to 1.9) does not', () => {
    expect(row({ mood_cosy: { score: 2 } }).moods).toEqual(['cosy']);
    expect(row({ mood_cosy: { score: 1.94 }, mood_boost: { score: 1.5 } }).moods).toEqual(['cosy']); // none reach 2 → the single best
  });

  it('when none reach 2, keeps only the single best', () => {
    const r = row({ mood_comfort: { score: 1.4 }, mood_cosy: { score: 1.3 }, mood_boost: { score: 0.2 } });
    expect(r.moods).toEqual(['comfort']);
  });

  it('when none reach 2 and all tie, the single best is the first mood', () => {
    expect(row().moods).toEqual(['boost']);
  });

  it('can tag the new "focus" and "unwind" moods', () => {
    expect(row({ mood_focus: { score: 2.7 } }).moods).toEqual(['focus']);
    expect(row({ mood_unwind: { score: 2.7 } }).moods).toEqual(['unwind']);
    expect(row({ mood_unwind: { score: 2.7 } }).mood_fit.unwind).toBe(2.7);
  });

  it('"unwind" sits after "focus" in the tie-break order', () => {
    expect(row({ mood_unwind: { score: 2.5 }, mood_focus: { score: 2.5 }, mood_cosy: { score: 2.5 } }).moods).toEqual(['focus', 'unwind', 'cosy']);
  });
});

describe('traitRowFromAnswers — dayparts (P >= 0.6, best first, max 3, else the single best)', () => {
  const dayparts = (a: Partial<Record<(typeof DAYPARTS)[number], number>>) =>
    row(Object.fromEntries(DAYPARTS.map((d) => [`daypart_${d}`, { noul: a[d] ?? 0 }]))).dayparts;

  it('keeps those at or above 0.6, highest first', () => {
    expect(dayparts({ morning: 0.6, afternoon: 0.9 })).toEqual(['afternoon', 'morning']);
  });

  it('drops one just under 0.6', () => {
    expect(dayparts({ morning: 0.599, afternoon: 0.8 })).toEqual(['afternoon']);
  });

  it('caps at three', () => {
    expect(dayparts({ morning: 0.7, afternoon: 0.8, evening: 0.9, late: 0.75 })).toEqual(['evening', 'afternoon', 'late']);
  });

  it('breaks ties in DAYPARTS order', () => {
    expect(dayparts({ evening: 0.8, morning: 0.8, late: 0.8 })).toEqual(['morning', 'evening', 'late']);
  });

  it('when none qualify, keeps the single best', () => {
    expect(dayparts({ morning: 0.1, afternoon: 0.3, evening: 0.55, late: 0.2 })).toEqual(['evening']);
  });

  it('when none qualify and all are zero, keeps the first', () => {
    expect(dayparts({})).toEqual(['morning']);
  });
});

describe('traitRowFromAnswers — textures (P >= 0.6, best first, max 3)', () => {
  const textures = (a: Record<string, number>) => row(Object.fromEntries(Object.entries(a).map(([t, p]) => [`texture_${t}`, { noul: p }]))).textures;

  it('is empty when nothing qualifies — there is no forced best', () => {
    expect(textures({ silky: 0.5, creamy: 0.59 })).toEqual([]);
  });

  it('keeps those at or above 0.6, highest first', () => {
    expect(textures({ silky: 0.6, creamy: 0.95, icy: 0.3 })).toEqual(['creamy', 'silky']);
  });

  it('caps at three', () => {
    expect(textures({ silky: 0.7, creamy: 0.8, frothy: 0.9, thick: 0.85 })).toEqual(['frothy', 'thick', 'creamy']);
  });

  it('breaks ties in TEXTURES order', () => {
    expect(textures({ chewy: 0.9, silky: 0.9, gooey: 0.9, creamy: 0.9 })).toEqual(['silky', 'creamy', 'gooey']);
    expect(TEXTURES.indexOf('silky')).toBeLessThan(TEXTURES.indexOf('gooey'));
  });
});

describe('traitRowFromAnswers — flavour notes (P >= 0.6, best first, max 5)', () => {
  const notes = (a: Record<string, number>) => row(Object.fromEntries(Object.entries(a).map(([n, p]) => [flavor(n), { noul: p }]))).flavor_notes;

  it('is empty when nothing qualifies', () => {
    expect(notes({ chocolate: 0.59 })).toEqual([]);
  });

  it('returns the note strings — including two-word ones — not the keys', () => {
    expect(notes({ 'white chocolate': 0.8, 'chai spice': 0.7, 'mixed berry': 0.9 })).toEqual(['mixed berry', 'white chocolate', 'chai spice']);
  });

  it('caps at five', () => {
    const r = notes({ chocolate: 0.61, caramel: 0.62, hazelnut: 0.63, vanilla: 0.64, espresso: 0.65, honey: 0.66, mango: 0.67 });
    expect(r).toEqual(['mango', 'honey', 'espresso', 'vanilla', 'hazelnut']);
  });

  it('breaks ties in vocabulary order', () => {
    expect(notes({ vanilla: 0.9, chocolate: 0.9, caramel: 0.9 })).toEqual(['chocolate', 'caramel', 'vanilla']);
  });

  it('every kept note fits the 24-character column the validator enforces', () => {
    for (const f of FLAVOR_VOCABULARY) expect(f.note.length).toBeLessThanOrEqual(24);
  });
});

describe('traitRowFromAnswers — defaults for questions Jev skipped', () => {
  it('treats a missing noul as 0 and a missing score as 0', () => {
    const a = answers();
    for (const key of Object.keys(a)) if (key.startsWith('texture_') || key.startsWith('flavor_') || key.startsWith('mood_')) delete a[key];
    const r = traitRowFromAnswers('item-1', a);
    expect(r).not.toBeNull();
    expect(r?.textures).toEqual([]);
    expect(r?.flavor_notes).toEqual([]);
    expect(r?.moods).toEqual(['boost']);
    expect(Object.values(r?.mood_fit ?? {}).every((v) => v === 0)).toBe(true);
  });
});

describe('jevNeedsReview (COFFEY-SPEC §3.2)', () => {
  const flagged = (overrides: JevAnswers) => jevNeedsReview(answers(overrides));

  it('does not flag a confident, decisive item', () => {
    expect(flagged({})).toBe(false);
  });

  it.each(['temperature', 'caffeine', 'kind'])('flags a %s choice with confidence below 0.6', (key) => {
    const choice = key === 'temperature' ? 'hot' : key === 'caffeine' ? 'high' : 'drink';
    expect(flagged({ [key]: { choice, confidence: 0.59 } })).toBe(true);
    expect(flagged({ [key]: { choice, confidence: 0.6 } })).toBe(false); // the bar is "< 0.6"
  });

  it('does not flag on the BODY choice confidence — it is not one of the three', () => {
    expect(flagged({ body: { choice: 'rich', confidence: 0.1 } })).toBe(false);
  });

  it('flags is_coffee strictly inside (0.35, 0.65)', () => {
    expect(flagged({ is_coffee: { noul: 0.36 } })).toBe(true);
    expect(flagged({ is_coffee: { noul: 0.5 } })).toBe(true);
    expect(flagged({ is_coffee: { noul: 0.64 } })).toBe(true);
    expect(flagged({ is_coffee: { noul: 0.35 } })).toBe(false);
    expect(flagged({ is_coffee: { noul: 0.65 } })).toBe(false);
    expect(flagged({ is_coffee: { noul: 0.05 } })).toBe(false);
    expect(flagged({ is_coffee: { noul: 0.99 } })).toBe(false);
  });

  it('flags a sweetness confidence below 0.5 — a lower bar than the choices', () => {
    expect(flagged({ sweetness: { score: 3, confidence: 0.49 } })).toBe(true);
    expect(flagged({ sweetness: { score: 3, confidence: 0.5 } })).toBe(false);
    expect(flagged({ sweetness: { score: 3, confidence: 0.55 } })).toBe(false); // would be flagged if it used 0.6
  });

  it('does not flag on the other score questions', () => {
    expect(flagged({ intensity: { score: 1, confidence: 0.1 }, novelty: { score: 1, confidence: 0.1 }, mood_boost: { score: 1, confidence: 0.1 } })).toBe(false);
  });

  it('treats a missing confidence as confident', () => {
    expect(flagged({ temperature: { choice: 'hot' }, sweetness: { score: 3 } })).toBe(false);
  });
});
