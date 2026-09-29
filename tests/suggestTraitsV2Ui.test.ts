import { describe, expect, it } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.4) — the owner Traits tab's pure helpers:
// what an inline edit sends to PATCH, and which moods a row's read-out shows.
// (The component itself renders in the browser; these are the parts with rules.)
// The payloads are also run through the PATCH route's own validator, so the tab
// and the route can't drift apart.

import { buildSavePayload, toEditState, topMoodFits, type EditState } from '@/components/owner/suggestions/TraitsTab';
import { validateTraitPatch } from '@/lib/suggest/traitsValidate';
import { MOODS, type MenuItemTraits } from '@/lib/suggest/types';

const V1: MenuItemTraits = {
  menu_item_id: 'm1',
  temperature: 'hot',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 1,
  body: 'light',
  kind: 'drink',
  moods: ['boost', 'cosy'],
  dayparts: ['morning'],
  flavor_notes: ['espresso', 'vanilla'],
  source: 'opus',
  confirmed: true,
  updated_at: '2026-09-01T00:00:00Z',
};

const V2: MenuItemTraits = {
  ...V1,
  sweetness_level: 4,
  intensity: 3,
  refreshment: 1,
  indulgence: 0,
  novelty: 2,
  textures: ['silky', 'frothy'],
  mood_fit: { boost: 2.8, focus: 2.1, cosy: 1.4 },
  traits_version: 2,
};

const payload = (edit: EditState, migrated: boolean) => {
  const result = buildSavePayload('m1', edit, migrated);
  if (typeof result === 'string') throw new Error(`expected a payload, got: ${result}`);
  return result;
};

/** What the PATCH route would make of a payload. */
const serverVerdict = (body: Record<string, unknown>) => {
  const { id: _ignored, ...rest } = body;
  return validateTraitPatch(rest);
};

describe('toEditState', () => {
  it('reads a pre-migration row: the v2 fields are null / empty, and there is no graded fit', () => {
    const e = toEditState(V1);
    expect(e).toMatchObject({
      temperature: 'hot',
      caffeine: 'high',
      is_coffee: true,
      sweetness: 1,
      moods: ['boost', 'cosy'],
      flavor_notes: 'espresso, vanilla',
      sweetness_level: null,
      intensity: null,
      refreshment: null,
      indulgence: null,
      novelty: null,
      textures: [],
      hasMoodFit: false,
    });
  });

  it('reads a v2 row', () => {
    const e = toEditState(V2);
    expect(e).toMatchObject({ sweetness_level: 4, intensity: 3, refreshment: 1, indulgence: 0, novelty: 2, textures: ['silky', 'frothy'], hasMoodFit: true });
  });

  it('gives every mood an input, blank where the row has no fit for it', () => {
    const e = toEditState(V2);
    expect(Object.keys(e.mood_fit)).toEqual([...MOODS]);
    expect(e.mood_fit).toMatchObject({ boost: '2.8', focus: '2.1', cosy: '1.4', unwind: '', cool: '' });
  });

  it('an empty mood_fit is "not graded"', () => {
    expect(toEditState({ ...V2, mood_fit: {} }).hasMoodFit).toBe(false);
  });
});

describe('buildSavePayload — before the migration', () => {
  it('sends the v1 fields and the legacy 0–3 sweetness — nothing of v2', () => {
    const body = payload({ ...toEditState(V1), sweetness: 2, caffeine: 'none' }, false);
    expect(body).toEqual({
      id: 'm1',
      temperature: 'hot',
      caffeine: 'none',
      is_coffee: true,
      sweetness: 2,
      body: 'light',
      kind: 'drink',
      moods: ['boost', 'cosy'],
      dayparts: ['morning'],
      flavor_notes: ['espresso', 'vanilla'],
    });
  });

  it('never sends a v2 field, even when the row somehow has one', () => {
    const body = payload(toEditState(V2), false);
    for (const key of ['sweetness_level', 'intensity', 'refreshment', 'indulgence', 'novelty', 'textures', 'mood_fit']) expect(body).not.toHaveProperty(key);
    expect(serverVerdict(body).error).toBeNull();
  });
});

describe('buildSavePayload — after the migration', () => {
  it('a v2 row: sweetness on the 0–10 scale (not the legacy value), the four scores, textures and the graded fit', () => {
    const body = payload({ ...toEditState(V2), sweetness_level: 7, novelty: 3, textures: ['icy'] }, true);
    expect(body).toMatchObject({ sweetness_level: 7, intensity: 3, refreshment: 1, indulgence: 0, novelty: 3, textures: ['icy'] });
    expect(body).not.toHaveProperty('sweetness'); // the route derives it
    expect(body.mood_fit).toEqual({ boost: 2.8, focus: 2.1, cosy: 1.4 });
  });

  it('moods follow the fit: those at 2 or more, best first — the row\'s old chips are not sent', () => {
    const body = payload(toEditState(V2), true);
    expect(body.moods).toEqual(['boost', 'focus']);
    const raised = payload({ ...toEditState(V2), mood_fit: { ...toEditState(V2).mood_fit, cosy: '2.9', unwind: '2.5' } }, true);
    expect(raised.moods).toEqual(['cosy', 'boost', 'unwind']);
    expect(raised.mood_fit).toMatchObject({ cosy: 2.9, unwind: 2.5 });
  });

  it('when no fit reaches 2, the single best mood remains', () => {
    const e = toEditState(V2);
    const body = payload({ ...e, mood_fit: { ...e.mood_fit, boost: '1.2', focus: '0.4', cosy: '1.9' } }, true);
    expect(body.moods).toEqual(['cosy']);
  });

  it('rounds the fit to one decimal and skips blank boxes', () => {
    const e = toEditState({ ...V2, mood_fit: {} });
    const body = payload({ ...e, hasMoodFit: true, mood_fit: { ...e.mood_fit, boost: '2.26', cool: '  ', surprise: '3' } }, true);
    expect(body.mood_fit).toEqual({ boost: 2.3, surprise: 3 });
  });

  it('an emptied grid is "not graded": mood_fit {} and the moods as they were', () => {
    const e = toEditState(V2);
    const blank = Object.fromEntries(MOODS.map((m) => [m, ''])) as EditState['mood_fit'];
    const body = payload({ ...e, mood_fit: blank }, true);
    expect(body.mood_fit).toEqual({});
    expect(body.moods).toEqual(['boost', 'cosy']);
  });

  it.each(['abc', '3.5', '-0.1', '4', '1e9'])('refuses the fit "%s" with a message naming the mood', (bad) => {
    const e = toEditState(V2);
    const result = buildSavePayload('m1', { ...e, mood_fit: { ...e.mood_fit, cool: bad } }, true);
    expect(typeof result).toBe('string');
    expect(result).toContain('cool');
  });

  it('a row not yet tagged at v2 leaves its null fields out, keeps the chips for moods, and sends the level it has', () => {
    const e = toEditState({ ...V1, sweetness_level: 3, traits_version: 1 });
    const body = payload({ ...e, moods: ['cool'] }, true);
    expect(body).toMatchObject({ sweetness_level: 3, moods: ['cool'], textures: [] });
    for (const key of ['intensity', 'refreshment', 'indulgence', 'novelty', 'mood_fit']) expect(body).not.toHaveProperty(key);
    expect(serverVerdict(body).error).toBeNull();
  });

  it('with no level at all, it falls back to the legacy sweetness rather than sending null', () => {
    const body = payload(toEditState(V1), true);
    expect(body).toMatchObject({ sweetness: 1 });
    expect(body).not.toHaveProperty('sweetness_level');
  });

  it('a 0 is a value, not "unset"', () => {
    const body = payload({ ...toEditState(V2), intensity: 0, indulgence: 0 }, true);
    expect(body).toMatchObject({ intensity: 0, indulgence: 0 });
  });
});

describe('buildSavePayload — flavour notes', () => {
  it('splits on commas, trims, drops blanks and keeps at most five', () => {
    const body = payload({ ...toEditState(V1), flavor_notes: ' a , b,, c ,d,e, f ,' }, false);
    expect(body.flavor_notes).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('buildSavePayload — what the route makes of it', () => {
  it('the PATCH validator accepts every payload the tab can build from a valid edit', () => {
    const edits: [EditState, boolean][] = [
      [toEditState(V1), false],
      [toEditState(V1), true],
      [toEditState(V2), true],
      [{ ...toEditState(V2), textures: ['silky', 'creamy', 'frothy'] }, true],
      [{ ...toEditState(V2), sweetness_level: 0 }, true],
      [{ ...toEditState(V2), sweetness_level: 10, intensity: 3, refreshment: 3, indulgence: 3, novelty: 3 }, true],
    ];
    for (const [edit, migrated] of edits) {
      const body = payload(edit, migrated);
      expect(serverVerdict(body).error, JSON.stringify(body)).toBeNull();
    }
  });
});

describe('topMoodFits', () => {
  it('shows the moods that fit at least "could work" (1), best first, at most three', () => {
    expect(topMoodFits({ boost: 2.8, focus: 2.1, cosy: 1.4, cool: 1, comfort: 0.9, surprise: 0.2 })).toEqual([
      { mood: 'boost', fit: 2.8 },
      { mood: 'focus', fit: 2.1 },
      { mood: 'cosy', fit: 1.4 },
    ]);
  });

  it('breaks ties in MOODS order', () => {
    expect(topMoodFits({ surprise: 2, cool: 2, unwind: 2, boost: 2 }).map((m) => m.mood)).toEqual(['boost', 'unwind', 'cool']);
  });

  it('shows the single best when none reach 1', () => {
    expect(topMoodFits({ comfort: 0.6, cosy: 0.3 })).toEqual([{ mood: 'comfort', fit: 0.6 }]);
    expect(topMoodFits({})).toEqual([{ mood: 'boost', fit: 0 }]);
  });

  it('includes the new moods', () => {
    expect(topMoodFits({ unwind: 2.5 })).toEqual([{ mood: 'unwind', fit: 2.5 }]);
  });
});
