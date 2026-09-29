import { beforeEach, describe, expect, it, vi } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.1, §3.4) — PATCH /api/owner/suggest/traits:
// the owner may edit v2 fields, sweetness stays consistent between its two
// columns, provenance is never patchable, and before the migration a v2 edit is
// a 409 with what to do — never a 500. Handler-level, with a fake Supabase
// client (the style of tests/suggestRoute.test.ts).

type DbError = { code?: string; message: string } | null;
type Row = Record<string, unknown>;

const state = { owner: { id: 'owner-1' } as { id: string } | null };

const db = {
  probeError: null as DbError,
  updateError: null as DbError,
  updateRow: undefined as Row | null | undefined, // undefined → echo the payload; null → "no such row"
  bulkRows: [] as Row[],
  log: [] as string[],
  updates: [] as { payload: Row; column: string; value: unknown }[],
  bulk: [] as { payload: Row; ids: unknown[] }[],
};

const overview = {
  rows: [],
  unconfirmedCount: 1,
  missingCount: 2,
  needsUpgrade: 3,
  migrationApplied: true,
  missingTables: false,
};

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (table !== 'menu_item_traits') throw new Error(`unexpected table ${table}`);
      return {
        select: (columns: string) => {
          expect(columns).toBe('traits_version');
          db.log.push('probe');
          const result = { data: [], error: db.probeError };
          return { limit: () => Promise.resolve(result) };
        },
        update: (payload: Row) => ({
          eq: (column: string, value: unknown) => {
            db.log.push('update');
            db.updates.push({ payload, column, value });
            return {
              select: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: db.updateError ? null : db.updateRow === undefined ? { menu_item_id: value, ...payload } : db.updateRow,
                    error: db.updateError,
                  }),
              }),
            };
          },
          in: (_column: string, ids: unknown[]) => {
            db.log.push('bulk');
            db.bulk.push({ payload, ids });
            return { select: () => Promise.resolve({ data: db.bulkRows, error: null }) };
          },
        }),
      };
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));
vi.mock('@/lib/suggest/queries', () => ({ getTraitsOverview: () => Promise.resolve(overview) }));

const { GET, PATCH } = await import('@/app/api/owner/suggest/traits/route');

const ID = '3dd077ea-b036-58f0-9a3b-dab3746e894c';

const patch = async (body: unknown) => {
  const res = await PATCH(
    new Request('http://t/api/owner/suggest/traits', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
};

const written = () => db.updates[0]?.payload ?? {};
const MISSING_COLUMN = { code: '42703', message: 'column menu_item_traits.traits_version does not exist' };
const PENDING = 'Apply supabase/2026-10-coffey-traits-v2.sql in Supabase, then save again.';

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  Object.assign(db, { probeError: null, updateError: null, updateRow: undefined, bulkRows: [], log: [], updates: [], bulk: [] });
});

describe('GET /api/owner/suggest/traits', () => {
  it('is owner-only', async () => {
    state.owner = null;
    expect((await GET()).status).toBe(403);
  });

  it('returns the overview, including needsUpgrade and migrationApplied', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(overview);
  });
});

describe('PATCH — sweetness stays consistent between its two columns', () => {
  it('sweetness_level set → the legacy sweetness is derived from it', async () => {
    const { res } = await patch({ id: ID, sweetness_level: 7 });
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ sweetness_level: 7, sweetness: 2 });
  });

  it.each([
    [0, 0],
    [1, 0],
    [2, 1],
    [4, 1],
    [5, 2],
    [7, 2],
    [8, 3],
    [10, 3],
  ])('level %i → legacy %i (legacySweetnessFromLevel)', async (level, legacy) => {
    await patch({ id: ID, sweetness_level: level });
    expect(written()).toMatchObject({ sweetness_level: level, sweetness: legacy });
  });

  it('the level wins when an older client sends both and they disagree', async () => {
    await patch({ id: ID, sweetness_level: 9, sweetness: 0 });
    expect(written()).toMatchObject({ sweetness_level: 9, sweetness: 3 });
  });

  it('ONLY the legacy sweetness set (after the migration) → the 0–10 level is set too, from SWEETNESS_SCALE.legacyToLevel', async () => {
    const seen: number[] = [];
    for (const legacy of [0, 1, 2, 3]) {
      db.updates = [];
      await patch({ id: ID, sweetness: legacy });
      expect(written()).toMatchObject({ sweetness: legacy });
      seen.push(written().sweetness_level as number);
    }
    expect(seen).toEqual([0, 3, 6, 9]);
  });

  it('ONLY the legacy sweetness set BEFORE the migration → sweetness_level is not sent, the column is missing', async () => {
    db.probeError = MISSING_COLUMN;
    const { res } = await patch({ id: ID, sweetness: 2 });
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ sweetness: 2, source: 'owner', confirmed: true });
    expect(written()).not.toHaveProperty('sweetness_level');
  });

  it('a schema-cache "column missing" from the probe counts the same as 42703', async () => {
    db.probeError = { code: 'PGRST204', message: "Could not find the 'traits_version' column of 'menu_item_traits' in the schema cache" };
    await patch({ id: ID, sweetness: 1 });
    expect(written()).not.toHaveProperty('sweetness_level');
  });

  it('a probe that fails for another reason does not stop the edit, and the level is still sent', async () => {
    db.probeError = { code: '57014', message: 'statement timeout' };
    const { res } = await patch({ id: ID, sweetness: 3 });
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ sweetness: 3, sweetness_level: 9 });
  });

  it('sweetness_level set BEFORE the migration is refused with 409 and written nowhere', async () => {
    db.probeError = MISSING_COLUMN;
    const { res, body } = await patch({ id: ID, sweetness_level: 5 });
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: PENDING });
    expect(db.updates).toEqual([]);
  });

  it('rejects an out-of-range level or legacy value with 400 naming the field', async () => {
    expect((await patch({ id: ID, sweetness_level: 11 })).body.error).toContain('sweetness_level');
    expect((await patch({ id: ID, sweetness: 4 })).body.error).toContain('sweetness');
    expect(db.updates).toEqual([]);
  });

  it('a v1-only edit sends no sweetness at all', async () => {
    await patch({ id: ID, caffeine: 'none' });
    expect(written()).not.toHaveProperty('sweetness');
    expect(written()).not.toHaveProperty('sweetness_level');
  });
});

describe('PATCH — v2 fields', () => {
  it('accepts every v2 field alongside v1 ones, marks the row owner-edited and confirmed', async () => {
    const { res, body } = await patch({
      id: ID,
      caffeine: 'none',
      intensity: 3,
      refreshment: 2,
      indulgence: 1,
      novelty: 0,
      textures: ['silky', 'creamy'],
      mood_fit: { unwind: 2.7, focus: 1 },
    });
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({
      caffeine: 'none',
      intensity: 3,
      refreshment: 2,
      indulgence: 1,
      novelty: 0,
      textures: ['silky', 'creamy'],
      mood_fit: { unwind: 2.7, focus: 1 },
      source: 'owner',
      confirmed: true,
    });
    expect(written().updated_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(db.updates[0].column).toBe('menu_item_id');
    expect(db.updates[0].value).toBe(ID);
    expect(body).toHaveProperty('traits');
  });

  it('coerces on the way in: textures de-duplicated, mood_fit rounded', async () => {
    await patch({ id: ID, textures: ['icy', 'icy'], mood_fit: { cool: 2.36 } });
    expect(written()).toMatchObject({ textures: ['icy'], mood_fit: { cool: 2.4 } });
  });

  it('never lets a body set traits_version, source or confirmed', async () => {
    await patch({ id: ID, caffeine: 'none', traits_version: 1, source: 'opus', confirmed: false });
    expect(written()).toMatchObject({ source: 'owner', confirmed: true });
    expect(written()).not.toHaveProperty('traits_version');
  });

  it.each([
    [{ intensity: 4 }, 'intensity'],
    [{ novelty: -1 }, 'novelty'],
    [{ textures: ['silky', 'creamy', 'frothy', 'thick'] }, 'textures'],
    [{ textures: ['gritty'] }, 'textures'],
    [{ mood_fit: { angry: 1 } }, 'mood_fit'],
    [{ mood_fit: { boost: 3.5 } }, 'mood_fit'],
    [{ refreshment: '2' }, 'refreshment'],
  ])('rejects %j with 400 naming "%s"', async (fields, name) => {
    const { res, body } = await patch({ id: ID, ...fields });
    expect(res.status).toBe(400);
    expect(String(body.error)).toContain(name);
    expect(db.updates).toEqual([]);
  });

  it('BEFORE the migration a v2 field is a 409 with what to do, and nothing is written', async () => {
    db.probeError = MISSING_COLUMN;
    for (const fields of [{ intensity: 2 }, { textures: ['silky'] }, { mood_fit: { boost: 2 } }, { caffeine: 'none', novelty: 1 }]) {
      const { res, body } = await patch({ id: ID, ...fields });
      expect(res.status, JSON.stringify(fields)).toBe(409);
      expect(body).toEqual({ error: PENDING });
    }
    expect(db.updates).toEqual([]);
  });

  it('AFTER the migration landed between the probe and the write, the write\'s own missing-column error is a 409 too', async () => {
    db.updateError = MISSING_COLUMN;
    const { res, body } = await patch({ id: ID, intensity: 2 });
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: PENDING });
  });

  it('any other write error is a 500 with its message', async () => {
    db.updateError = { code: '23514', message: 'violates check constraint' };
    const { res, body } = await patch({ id: ID, caffeine: 'none' });
    expect(res.status).toBe(500);
    expect(body.error).toBe('violates check constraint');
  });

  it('404s when the item has no traits row', async () => {
    db.updateRow = null;
    expect((await patch({ id: ID, intensity: 1 })).res.status).toBe(404);
  });

  it('v1 edits still work before the migration, and need no probe', async () => {
    db.probeError = MISSING_COLUMN;
    const { res } = await patch({ id: ID, caffeine: 'none', moods: ['boost', 'cosy'], flavor_notes: ['vanilla'] });
    expect(res.status).toBe(200);
    expect(db.log).toEqual(['update']);
    expect(written()).toMatchObject({ caffeine: 'none', moods: ['boost', 'cosy'], source: 'owner', confirmed: true });
  });

  // The migration also widens the `moods` CHECK to allow the two new feelings;
  // before it, the database would reject them with a constraint violation.
  it.each([['focus'], ['unwind'], ['boost', 'unwind']])('BEFORE the migration the new mood(s) %j are a 409, not a 500', async (...moods) => {
    db.probeError = MISSING_COLUMN;
    const { res, body } = await patch({ id: ID, moods });
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: PENDING });
    expect(db.updates).toEqual([]);
  });

  it('AFTER the migration the new moods are accepted like any other', async () => {
    const { res } = await patch({ id: ID, moods: ['focus', 'unwind', 'cosy'] });
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ moods: ['focus', 'unwind', 'cosy'] });
    expect(db.log).toEqual(['probe', 'update']);
  });
});

describe('PATCH — unchanged behaviour', () => {
  it('is owner-only', async () => {
    state.owner = null;
    expect((await patch({ id: ID, caffeine: 'none' })).res.status).toBe(403);
    expect(db.updates).toEqual([]);
  });

  it('needs a valid id', async () => {
    expect((await patch({ caffeine: 'none' })).res.status).toBe(400);
    expect((await patch({ id: 'not-a-uuid', caffeine: 'none' })).res.status).toBe(400);
  });

  it('needs something to do', async () => {
    const { res, body } = await patch({ id: ID });
    expect(res.status).toBe(400);
    expect(String(body.error)).toMatch(/Nothing to update/);
  });

  it('confirm: true alone just confirms — no probe, no content, source untouched', async () => {
    const { res } = await patch({ id: ID, confirm: true });
    expect(res.status).toBe(200);
    expect(written()).toEqual({ confirmed: true });
    expect(db.log).toEqual(['update']);
  });

  it('bulk confirm marks the rows confirmed and reports how many', async () => {
    db.bulkRows = [{ menu_item_id: ID }, { menu_item_id: 'b' }];
    const { res, body } = await patch({ confirmIds: [ID, 'nope', 'b'] });
    expect(res.status).toBe(200);
    expect(body).toEqual({ confirmed: 2 });
    expect(db.bulk[0].payload).toEqual({ confirmed: true });
    expect(db.bulk[0].ids).toEqual([ID]); // only the valid uuid was sent on
  });
});
