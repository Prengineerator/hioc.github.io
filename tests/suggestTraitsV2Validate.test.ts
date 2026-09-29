import { describe, expect, it } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.1) — the v2 trait-field validators: what
// the owner PATCH and the Jev tagger may write into the new columns. Pure. Each
// bound here mirrors a CHECK in supabase/2026-10-coffey-traits-v2.sql (that
// correspondence is itself pinned in tests/suggestTraitsV2Migration.test.ts).

import {
  classifyTraitsSchemaError,
  isMissingColumnError,
  moodsFromFit,
  roundFit,
  TRAIT_V1_FIELDS,
  TRAIT_V2_FIELDS,
  validateModelTraitRowsV2,
  validateTraitContentV2,
  validateTraitPatch,
  type TraitContentV2,
} from '@/lib/suggest/traitsValidate';
import { MOODS } from '@/lib/suggest/types';
import { TEXTURES } from '@/lib/suggest/traitVocabulary';

const V2_CONTENT: TraitContentV2 = {
  temperature: 'iced',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 1,
  body: 'medium',
  kind: 'drink',
  moods: ['cool', 'boost'],
  dayparts: ['afternoon'],
  flavor_notes: ['espresso', 'vanilla'],
  sweetness_level: 4,
  intensity: 2,
  refreshment: 3,
  indulgence: 1,
  novelty: 0,
  textures: ['creamy', 'icy'],
  mood_fit: { boost: 2.4, cool: 2.9, cosy: 0.5 },
};

const patchOf = (input: Record<string, unknown>) => validateTraitPatch(input);

describe('the field lists', () => {
  it('v1 has nine fields, v2 has seven, and they do not overlap', () => {
    expect(TRAIT_V1_FIELDS).toHaveLength(9);
    expect(TRAIT_V2_FIELDS).toHaveLength(7);
    expect(TRAIT_V1_FIELDS.filter((f) => (TRAIT_V2_FIELDS as readonly string[]).includes(f))).toEqual([]);
    expect(Object.keys(V2_CONTENT).sort()).toEqual([...TRAIT_V1_FIELDS, ...TRAIT_V2_FIELDS].sort());
  });

  it('traits_version is provenance, not content', () => {
    expect(TRAIT_V1_FIELDS).not.toContain('traits_version');
    expect((TRAIT_V2_FIELDS as readonly string[]).includes('traits_version')).toBe(false);
  });
});

describe('sweetness_level: an integer 0–10', () => {
  it.each([0, 1, 5, 9, 10])('accepts %i', (n) => {
    expect(patchOf({ sweetness_level: n })).toEqual({ patch: { sweetness_level: n }, error: null });
  });

  it.each([-1, 11, 100, 5.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, true, [], {}])('rejects %j', (bad) => {
    const { patch, error } = patchOf({ sweetness_level: bad });
    expect(error).toBe('Invalid value for "sweetness_level"');
    expect(patch).toEqual({});
  });
});

describe.each(['intensity', 'refreshment', 'indulgence', 'novelty'])('%s: an integer 0–3', (field) => {
  it.each([0, 1, 2, 3])('accepts %i', (n) => {
    expect(patchOf({ [field]: n })).toEqual({ patch: { [field]: n }, error: null });
  });

  it.each([-1, 4, 10, 1.5, 2.9, Number.NaN, '2', null, false])('rejects %j', (bad) => {
    expect(patchOf({ [field]: bad }).error).toBe(`Invalid value for "${field}"`);
  });
});

describe('textures: a subset of TEXTURES, at most 3, de-duplicated', () => {
  it('accepts none, one, or three', () => {
    expect(patchOf({ textures: [] }).patch).toEqual({ textures: [] });
    expect(patchOf({ textures: ['silky'] }).patch).toEqual({ textures: ['silky'] });
    expect(patchOf({ textures: ['silky', 'creamy', 'frothy'] }).patch).toEqual({ textures: ['silky', 'creamy', 'frothy'] });
  });

  it('accepts every word of the vocabulary, one at a time', () => {
    for (const t of TEXTURES) expect(patchOf({ textures: [t] }).error).toBeNull();
  });

  it('rejects a fourth texture', () => {
    expect(patchOf({ textures: ['silky', 'creamy', 'frothy', 'thick'] }).error).toBe('Invalid value for "textures"');
  });

  it('rejects a word outside the vocabulary', () => {
    expect(patchOf({ textures: ['gritty'] }).error).toBe('Invalid value for "textures"');
    expect(patchOf({ textures: ['silky', 'Silky'] }).error).toBe('Invalid value for "textures"'); // case matters
  });

  it('rejects a non-array or a non-string entry', () => {
    for (const bad of ['silky', null, 3, { 0: 'silky' }, [1], [null], [['silky']]]) {
      expect(patchOf({ textures: bad }).error, JSON.stringify(bad)).toBe('Invalid value for "textures"');
    }
  });

  it('de-duplicates, keeping the first occurrence in order', () => {
    expect(patchOf({ textures: ['creamy', 'silky', 'creamy'] }).patch).toEqual({ textures: ['creamy', 'silky'] });
  });

  it('counts the stored (de-duplicated) array against the limit of three', () => {
    expect(patchOf({ textures: ['silky', 'silky', 'silky', 'silky'] }).patch).toEqual({ textures: ['silky'] });
    expect(patchOf({ textures: ['silky', 'creamy', 'silky', 'creamy', 'frothy'] }).patch).toEqual({ textures: ['silky', 'creamy', 'frothy'] });
  });
});

describe('mood_fit: a plain object, keys from MOODS, values 0–3 rounded to one decimal', () => {
  it('accepts an empty object ("not graded yet")', () => {
    expect(patchOf({ mood_fit: {} })).toEqual({ patch: { mood_fit: {} }, error: null });
  });

  it('accepts a fit for every mood, including focus and unwind', () => {
    const fit = Object.fromEntries(MOODS.map((m, i) => [m, i % 4]));
    expect(patchOf({ mood_fit: fit }).patch).toEqual({ mood_fit: fit });
    expect(patchOf({ mood_fit: { focus: 2, unwind: 3 } }).error).toBeNull();
  });

  it('accepts the 0 and 3 bounds', () => {
    expect(patchOf({ mood_fit: { boost: 0, cool: 3 } }).patch).toEqual({ mood_fit: { boost: 0, cool: 3 } });
  });

  it('rounds to one decimal', () => {
    expect(patchOf({ mood_fit: { boost: 2.34, cool: 2.36, cosy: 1.04, comfort: 2.999 } }).patch).toEqual({
      mood_fit: { boost: 2.3, cool: 2.4, cosy: 1, comfort: 3 },
    });
  });

  it('turns -0 into 0', () => {
    const fit = patchOf({ mood_fit: { boost: -0 } }).patch.mood_fit;
    expect(Object.is(fit?.boost, 0)).toBe(true);
  });

  it('rejects a key that is not a mood', () => {
    for (const key of ['angry', 'savoury', 'Boost', '__proto__', '']) {
      expect(patchOf({ mood_fit: JSON.parse(`{"${key}": 1}`) }).error, key).toBe('Invalid value for "mood_fit"');
    }
  });

  it('rejects a value outside 0–3 or not a finite number', () => {
    for (const bad of [-0.1, 3.1, 4, 100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '2', null, true, [2], {}]) {
      expect(patchOf({ mood_fit: { boost: bad } }).error, String(bad)).toBe('Invalid value for "mood_fit"');
    }
  });

  it('rejects anything that is not a plain object', () => {
    for (const bad of [null, [], [['boost', 2]], 'boost', 2, true, new Date(), new Map()]) {
      expect(patchOf({ mood_fit: bad }).error, String(bad)).toBe('Invalid value for "mood_fit"');
    }
  });

  it('one bad mood fails the whole object', () => {
    expect(patchOf({ mood_fit: { boost: 2, cool: 9 } })).toEqual({ patch: {}, error: 'Invalid value for "mood_fit"' });
  });
});

describe('moods allow the new feelings', () => {
  it('accepts focus and unwind in a v1 moods patch', () => {
    expect(patchOf({ moods: ['focus', 'unwind'] }).patch).toEqual({ moods: ['focus', 'unwind'] });
  });
});

describe('validateTraitPatch — v1 and v2 together', () => {
  it('validates every present field and ignores the rest', () => {
    const { patch, error } = patchOf({ ...V2_CONTENT, traits_version: 1, source: 'opus', confirmed: false, id: 'x' });
    expect(error).toBeNull();
    expect(patch).toEqual(V2_CONTENT);
  });

  it('one invalid v2 field fails the call even when v1 is fine', () => {
    const { patch, error } = patchOf({ caffeine: 'none', novelty: 9 });
    expect(error).toBe('Invalid value for "novelty"');
    expect(patch).toEqual({});
  });

  it('never returns provenance, whatever is sent', () => {
    const { patch } = patchOf({ traits_version: 9, source: 'owner', confirmed: true, updated_at: 'now', menu_item_id: 'abc' });
    expect(Object.keys(patch)).toEqual([]);
  });
});

describe('validateTraitContentV2 — a full row, every field required', () => {
  it('accepts a complete row', () => {
    expect(validateTraitContentV2(V2_CONTENT)).toEqual(V2_CONTENT);
  });

  it.each([...TRAIT_V1_FIELDS, ...TRAIT_V2_FIELDS])('rejects a row missing %s', (field) => {
    const partial: Record<string, unknown> = { ...V2_CONTENT };
    delete partial[field];
    expect(validateTraitContentV2(partial)).toBeNull();
  });

  it('rejects a row with an invalid v2 field', () => {
    expect(validateTraitContentV2({ ...V2_CONTENT, sweetness_level: 11 })).toBeNull();
    expect(validateTraitContentV2({ ...V2_CONTENT, textures: ['a', 'b', 'c', 'd'] })).toBeNull();
    expect(validateTraitContentV2({ ...V2_CONTENT, mood_fit: { boost: 4 } })).toBeNull();
  });

  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 'row', 3, []]) expect(validateTraitContentV2(bad)).toBeNull();
  });

  it('coerces on the way through: textures de-duplicated, mood_fit rounded', () => {
    const out = validateTraitContentV2({ ...V2_CONTENT, textures: ['icy', 'icy'], mood_fit: { boost: 2.26 } });
    expect(out?.textures).toEqual(['icy']);
    expect(out?.mood_fit).toEqual({ boost: 2.3 });
  });
});

describe('validateModelTraitRowsV2', () => {
  const allowed = new Set(['item-1', 'item-2']);

  it('keeps valid rows whose id was in the batch', () => {
    const rows = validateModelTraitRowsV2(
      [
        { menu_item_id: 'item-1', ...V2_CONTENT },
        { menu_item_id: 'item-2', ...V2_CONTENT, temperature: 'hot' },
      ],
      allowed,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ menu_item_id: 'item-1', ...V2_CONTENT });
    expect(rows[1].temperature).toBe('hot');
  });

  it('accepts the allowed ids as an array too', () => {
    expect(validateModelTraitRowsV2([{ menu_item_id: 'item-1', ...V2_CONTENT }], ['item-1'])).toHaveLength(1);
  });

  it('drops a row whose id was never in the batch — never trusts an invented id', () => {
    expect(validateModelTraitRowsV2([{ menu_item_id: 'item-999', ...V2_CONTENT }], allowed)).toEqual([]);
    expect(validateModelTraitRowsV2([{ ...V2_CONTENT }], allowed)).toEqual([]); // no id at all
    expect(validateModelTraitRowsV2([{ menu_item_id: 42, ...V2_CONTENT }], allowed)).toEqual([]);
  });

  it('requires every v2 field: a v1-only row is dropped', () => {
    const { sweetness_level, intensity, refreshment, indulgence, novelty, textures, mood_fit, ...v1 } = V2_CONTENT;
    expect(validateModelTraitRowsV2([{ menu_item_id: 'item-1', ...v1 }], allowed)).toEqual([]);
  });

  it('requires every v1 field too', () => {
    const { kind, ...rest } = V2_CONTENT;
    expect(validateModelTraitRowsV2([{ menu_item_id: 'item-1', ...rest }], allowed)).toEqual([]);
  });

  it('drops a row with any invalid field', () => {
    expect(validateModelTraitRowsV2([{ menu_item_id: 'item-1', ...V2_CONTENT, intensity: 7 }], allowed)).toEqual([]);
    expect(validateModelTraitRowsV2([{ menu_item_id: 'item-1', ...V2_CONTENT, moods: ['boost', 'angry'] }], allowed)).toEqual([]);
  });

  it('keeps only the first occurrence of a duplicate id', () => {
    const rows = validateModelTraitRowsV2(
      [
        { menu_item_id: 'item-1', ...V2_CONTENT, temperature: 'hot' },
        { menu_item_id: 'item-1', ...V2_CONTENT, temperature: 'iced' },
      ],
      allowed,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].temperature).toBe('hot');
  });

  it('a later valid row is not blocked by an earlier INVALID one with the same id', () => {
    const rows = validateModelTraitRowsV2(
      [
        { menu_item_id: 'item-1', ...V2_CONTENT, intensity: 99 },
        { menu_item_id: 'item-1', ...V2_CONTENT },
      ],
      allowed,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].intensity).toBe(2);
  });

  it('returns an empty array when the model output is not an array', () => {
    expect(validateModelTraitRowsV2(undefined, allowed)).toEqual([]);
    expect(validateModelTraitRowsV2({ items: [] }, allowed)).toEqual([]);
    expect(validateModelTraitRowsV2(null, allowed)).toEqual([]);
  });

  it('skips non-object entries without failing the batch', () => {
    const rows = validateModelTraitRowsV2([null, 3, 'x', { menu_item_id: 'item-1', ...V2_CONTENT }], allowed);
    expect(rows).toHaveLength(1);
  });

  it('carries traits_version through when it is a positive integer', () => {
    const rows = validateModelTraitRowsV2([{ menu_item_id: 'item-1', ...V2_CONTENT, traits_version: 2 }], allowed);
    expect(rows[0].traits_version).toBe(2);
  });

  it('does not require traits_version', () => {
    const [row] = validateModelTraitRowsV2([{ menu_item_id: 'item-1', ...V2_CONTENT }], allowed);
    expect(row).not.toHaveProperty('traits_version');
  });

  it.each([0, -1, 1.5, '2', null])('drops a row whose traits_version is %j', (bad) => {
    expect(validateModelTraitRowsV2([{ menu_item_id: 'item-1', ...V2_CONTENT, traits_version: bad }], allowed)).toEqual([]);
  });
});

describe('roundFit / moodsFromFit', () => {
  it('roundFit rounds to one decimal', () => {
    expect(roundFit(2.26)).toBe(2.3);
    expect(roundFit(2.24)).toBe(2.2);
    expect(roundFit(3)).toBe(3);
    expect(roundFit(0)).toBe(0);
    expect(Object.is(roundFit(-0), 0)).toBe(true);
    expect(Number.isNaN(roundFit(Number.NaN))).toBe(true); // stays NaN, for the validator to reject
  });

  it('moodsFromFit: fit >= 2, best first, max 3', () => {
    expect(moodsFromFit({ boost: 2, cool: 2.5, cosy: 1.9, surprise: 3 })).toEqual(['surprise', 'cool', 'boost']);
    expect(moodsFromFit({ boost: 3, focus: 3, unwind: 3, cosy: 3 })).toEqual(['boost', 'focus', 'unwind']);
  });

  it('moodsFromFit: none reach 2 → the single best; ties → MOODS order', () => {
    expect(moodsFromFit({ cosy: 1.5, cool: 1.5 })).toEqual(['cosy']);
    expect(moodsFromFit({ comfort: 0.1 })).toEqual(['comfort']);
    expect(moodsFromFit({})).toEqual(['boost']);
  });

  it('moodsFromFit ignores moods that are absent (0)', () => {
    expect(moodsFromFit({ surprise: 2 })).toEqual(['surprise']);
  });
});

describe('migration probes: classifyTraitsSchemaError / isMissingColumnError', () => {
  it.each([
    [{ code: '42703', message: 'column menu_item_traits.traits_version does not exist' }],
    [{ code: 'PGRST204', message: "Could not find the 'traits_version' column of 'menu_item_traits' in the schema cache" }],
    [{ code: '', message: "Could not find the 'traits_version' column of 'menu_item_traits' in the schema cache" }],
    [{ message: 'column "traits_version" does not exist' }],
    [{ message: 'COLUMN menu_item_traits.traits_version DOES NOT EXIST' }],
    [{ code: '42703' }],
  ])('%j is a missing column', (error) => {
    expect(classifyTraitsSchemaError(error)).toBe('missing_column');
    expect(isMissingColumnError(error)).toBe(true);
  });

  it.each([
    [{ code: '42P01', message: 'relation "menu_item_traits" does not exist' }],
    [{ code: 'PGRST205', message: "Could not find the table 'public.menu_item_traits' in the schema cache" }],
    [{ message: 'relation "public.menu_item_traits" does not exist' }],
    [{ message: "Could not find the table 'public.menu_item_traits' in the schema cache" }],
  ])('%j is a missing TABLE — a different fix, so not a missing column', (error) => {
    expect(classifyTraitsSchemaError(error)).toBe('missing_table');
    expect(isMissingColumnError(error)).toBe(false);
  });

  it.each([
    [{ code: '57014', message: 'canceling statement due to statement timeout' }],
    [{ code: '42501', message: 'permission denied for table menu_item_traits' }],
    [{ message: 'fetch failed' }],
    [{}],
  ])('%j is some other failure', (error) => {
    expect(classifyTraitsSchemaError(error)).toBe('other');
    expect(isMissingColumnError(error)).toBe(false);
  });

  it('no error is no problem', () => {
    expect(classifyTraitsSchemaError(null)).toBeNull();
    expect(classifyTraitsSchemaError(undefined)).toBeNull();
    expect(isMissingColumnError(null)).toBe(false);
  });
});
