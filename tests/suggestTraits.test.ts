import { describe, expect, it } from 'vitest';

// Pure — no Supabase, no 'server-only'. Validates the same rules the migration's
// CHECK constraints enforce (SUG-2), for both the Opus batch path and the
// owner PATCH path.
import { validateOpusTraitRows, validateTraitContent, validateTraitPatch } from '@/lib/suggest/traitsValidate';

const VALID_ROW = {
  temperature: 'iced',
  caffeine: 'medium',
  is_coffee: true,
  sweetness: 2,
  body: 'medium',
  kind: 'drink',
  moods: ['cool', 'boost'],
  dayparts: ['afternoon'],
  flavor_notes: ['nutty', 'chocolate'],
};

describe('validateTraitContent', () => {
  it('accepts a fully valid row', () => {
    expect(validateTraitContent(VALID_ROW)).toEqual(VALID_ROW);
  });

  it('rejects an out-of-enum temperature', () => {
    expect(validateTraitContent({ ...VALID_ROW, temperature: 'lukewarm' })).toBeNull();
  });

  it('rejects an out-of-range sweetness', () => {
    expect(validateTraitContent({ ...VALID_ROW, sweetness: 4 })).toBeNull();
    expect(validateTraitContent({ ...VALID_ROW, sweetness: -1 })).toBeNull();
    expect(validateTraitContent({ ...VALID_ROW, sweetness: 1.5 })).toBeNull();
  });

  it('rejects a mood outside the six-mood vocabulary', () => {
    expect(validateTraitContent({ ...VALID_ROW, moods: ['boost', 'angry'] })).toBeNull();
  });

  it('rejects a daypart outside the vocabulary', () => {
    expect(validateTraitContent({ ...VALID_ROW, dayparts: ['brunch'] })).toBeNull();
  });

  it('rejects more than 5 flavor notes', () => {
    expect(validateTraitContent({ ...VALID_ROW, flavor_notes: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBeNull();
  });

  it('rejects a missing required field', () => {
    const { kind, ...rest } = VALID_ROW;
    expect(validateTraitContent(rest)).toBeNull();
  });

  it('rejects a non-object input', () => {
    expect(validateTraitContent(null)).toBeNull();
    expect(validateTraitContent('nope')).toBeNull();
    expect(validateTraitContent(42)).toBeNull();
  });

  it('dedupes moods and dayparts', () => {
    const result = validateTraitContent({ ...VALID_ROW, moods: ['boost', 'boost', 'cool'] });
    expect(result?.moods).toEqual(['boost', 'cool']);
  });
});

describe('validateTraitPatch', () => {
  it('accepts a partial patch with only the fields present', () => {
    const { patch, error } = validateTraitPatch({ caffeine: 'none' });
    expect(error).toBeNull();
    expect(patch).toEqual({ caffeine: 'none' });
  });

  it('ignores unknown keys', () => {
    const { patch, error } = validateTraitPatch({ caffeine: 'none', menu_item_id: 'should-be-ignored', confirm: true });
    expect(error).toBeNull();
    expect(patch).toEqual({ caffeine: 'none' });
  });

  it('fails the whole call when one present field is invalid', () => {
    const { patch, error } = validateTraitPatch({ caffeine: 'none', sweetness: 9 });
    expect(error).toContain('sweetness');
    expect(patch).toEqual({});
  });

  it('returns an empty patch with no error when nothing relevant is present', () => {
    const { patch, error } = validateTraitPatch({});
    expect(error).toBeNull();
    expect(patch).toEqual({});
  });
});

describe('validateOpusTraitRows', () => {
  const allowedIds = new Set(['item-1', 'item-2']);

  it('keeps valid rows whose id was in the batch', () => {
    const rows = validateOpusTraitRows(
      [
        { menu_item_id: 'item-1', ...VALID_ROW },
        { menu_item_id: 'item-2', ...VALID_ROW, temperature: 'hot' },
      ],
      allowedIds,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ menu_item_id: 'item-1', ...VALID_ROW });
    expect(rows[1].temperature).toBe('hot');
  });

  it('drops a row whose id was never in the batch — never trusts an invented id', () => {
    const rows = validateOpusTraitRows([{ menu_item_id: 'item-999', ...VALID_ROW }], allowedIds);
    expect(rows).toEqual([]);
  });

  it('drops a row with invalid content even if the id is in the batch', () => {
    const rows = validateOpusTraitRows([{ menu_item_id: 'item-1', ...VALID_ROW, kind: 'beverage' }], allowedIds);
    expect(rows).toEqual([]);
  });

  it('keeps only the first occurrence of a duplicate id', () => {
    const rows = validateOpusTraitRows(
      [
        { menu_item_id: 'item-1', ...VALID_ROW, temperature: 'hot' },
        { menu_item_id: 'item-1', ...VALID_ROW, temperature: 'iced' },
      ],
      allowedIds,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].temperature).toBe('hot');
  });

  it('returns an empty array when the model output is not an array', () => {
    expect(validateOpusTraitRows(undefined, allowedIds)).toEqual([]);
    expect(validateOpusTraitRows({ items: [] }, allowedIds)).toEqual([]);
  });
});
