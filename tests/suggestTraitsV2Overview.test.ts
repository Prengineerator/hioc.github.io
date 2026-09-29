import { beforeEach, describe, expect, it, vi } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.4) — getTraitsOverview, the read behind the
// owner Traits tab: the v2 fields ride along when present, `needsUpgrade`
// counts what still needs Coffey's taste profile, `migrationApplied` says
// whether supabase/2026-10-coffey-traits-v2.sql has been run — and it never
// throws before it has. Fake Supabase client, no network.

type DbError = { code?: string; message: string } | null;
type Row = Record<string, unknown>;

const db = {
  items: [] as Row[],
  itemsError: null as DbError,
  traits: [] as Row[],
  traitsError: null as DbError,
  probeError: null as DbError,
  probeThrows: false,
  log: [] as string[],
};

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'menu_items') {
        return {
          select: () => ({
            order: () => ({
              order: () => {
                db.log.push('items');
                return Promise.resolve({ data: db.itemsError ? null : db.items, error: db.itemsError });
              },
            }),
          }),
        };
      }
      if (table === 'menu_item_traits') {
        return {
          select: (columns: string) => {
            if (columns === '*') {
              db.log.push('traits');
              return Promise.resolve({ data: db.traitsError ? null : db.traits, error: db.traitsError });
            }
            expect(columns).toBe('traits_version');
            db.log.push('probe');
            return {
              limit: () => {
                if (db.probeThrows) throw new Error('probe blew up');
                return Promise.resolve({ data: [], error: db.probeError });
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { getTraitsOverview } = await import('@/lib/suggest/queries');

const item = (id: string): Row => ({ id, name: `Item ${id}`, category: 'Coffee', parent_category: 'Hot', is_veg: true, is_available: true });

/** A pre-migration traits row: v1 columns only. */
const v1Row = (id: string, confirmed = true): Row => ({
  menu_item_id: id,
  temperature: 'hot',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 0,
  body: 'light',
  kind: 'drink',
  moods: ['boost'],
  dayparts: ['morning'],
  flavor_notes: [],
  source: 'opus',
  confirmed,
  updated_at: '2026-09-01T00:00:00Z',
});

/** A post-migration row. */
const v2Row = (id: string, version: number, confirmed = true): Row => ({
  ...v1Row(id, confirmed),
  sweetness_level: 2,
  intensity: 3,
  refreshment: 1,
  indulgence: 0,
  novelty: 0,
  textures: ['silky'],
  mood_fit: { boost: 2.8 },
  traits_version: version,
});

beforeEach(() => {
  Object.assign(db, { items: [], itemsError: null, traits: [], traitsError: null, probeError: null, probeThrows: false, log: [] });
});

describe('getTraitsOverview — before the migration', () => {
  it('reports the migration as not applied, and every item as needing the new profile', async () => {
    db.items = [item('a'), item('b'), item('c')];
    db.traits = [v1Row('a'), v1Row('b', false)]; // c has no row at all
    const overview = await getTraitsOverview();
    expect(overview).toMatchObject({
      migrationApplied: false,
      needsUpgrade: 3, // a and b are version 1 (no column), c is missing
      unconfirmedCount: 1,
      missingCount: 1,
      missingTables: false,
    });
    expect(overview.rows).toHaveLength(3);
  });

  it('infers it from the rows it already read — no probe query', async () => {
    db.items = [item('a')];
    db.traits = [v1Row('a')];
    await getTraitsOverview();
    expect(db.log).not.toContain('probe');
  });

  it('passes a v1 row through unchanged: the v2 fields are simply absent', async () => {
    db.items = [item('a')];
    db.traits = [v1Row('a')];
    const [row] = (await getTraitsOverview()).rows;
    expect(row.traits).toEqual(v1Row('a'));
    expect(row.traits).not.toHaveProperty('traits_version');
  });

  it('with NO traits rows at all it probes — and a missing column means not applied', async () => {
    db.items = [item('a'), item('b')];
    db.probeError = { code: '42703', message: 'column menu_item_traits.traits_version does not exist' };
    const overview = await getTraitsOverview();
    expect(db.log).toContain('probe');
    expect(overview).toMatchObject({ migrationApplied: false, needsUpgrade: 2, missingCount: 2 });
  });

  it('never throws, even if the probe itself blows up', async () => {
    db.items = [item('a')];
    db.probeThrows = true;
    await expect(getTraitsOverview()).resolves.toMatchObject({ migrationApplied: false, needsUpgrade: 1 });
  });

  it('treats a schema-cache "column missing" from the probe as not applied', async () => {
    db.items = [item('a')];
    db.probeError = { code: 'PGRST204', message: "Could not find the 'traits_version' column of 'menu_item_traits' in the schema cache" };
    expect((await getTraitsOverview()).migrationApplied).toBe(false);
  });
});

describe('getTraitsOverview — after the migration', () => {
  it('reports it applied, from the rows', async () => {
    db.items = [item('a')];
    db.traits = [v2Row('a', 2)];
    expect((await getTraitsOverview()).migrationApplied).toBe(true);
  });

  it('needsUpgrade counts rows below the current version, plus missing rows', async () => {
    db.items = ['a', 'b', 'c', 'd', 'e'].map(item);
    db.traits = [v2Row('a', 2), v2Row('b', 1), v2Row('c', 1, false), v2Row('d', 2, false)]; // e is missing
    const overview = await getTraitsOverview();
    expect(overview.needsUpgrade).toBe(3); // b, c (version 1) and e (missing) — d is current, just unconfirmed
    expect(overview.missingCount).toBe(1);
    expect(overview.unconfirmedCount).toBe(2); // c and d
  });

  it('is 0 when every item is current', async () => {
    db.items = [item('a'), item('b')];
    db.traits = [v2Row('a', 2), v2Row('b', 2, false)];
    expect((await getTraitsOverview()).needsUpgrade).toBe(0);
  });

  it('returns the v2 fields on each row', async () => {
    db.items = [item('a')];
    db.traits = [v2Row('a', 2)];
    const [row] = (await getTraitsOverview()).rows;
    expect(row.traits).toMatchObject({
      sweetness_level: 2,
      intensity: 3,
      refreshment: 1,
      indulgence: 0,
      novelty: 0,
      textures: ['silky'],
      mood_fit: { boost: 2.8 },
      traits_version: 2,
    });
  });

  it('with NO traits rows, a successful probe means applied', async () => {
    db.items = [item('a')];
    const overview = await getTraitsOverview();
    expect(db.log).toContain('probe');
    expect(overview).toMatchObject({ migrationApplied: true, needsUpgrade: 1, missingCount: 1 });
  });

  it('a probe that fails for another reason is not read as "not applied"', async () => {
    db.items = [item('a')];
    db.probeError = { code: '57014', message: 'statement timeout' };
    expect((await getTraitsOverview()).migrationApplied).toBe(true);
  });
});

describe('getTraitsOverview — the rest of the shape', () => {
  it('joins items to their traits and keeps each item\'s fields', async () => {
    db.items = [item('a'), item('b')];
    db.traits = [v2Row('b', 2)];
    const { rows } = await getTraitsOverview();
    expect(rows.map((r) => [r.menuItemId, r.name, r.category, r.parentCategory, r.isVeg, r.isAvailable, r.traits === null])).toEqual([
      ['a', 'Item a', 'Coffee', 'Hot', true, true, true],
      ['b', 'Item b', 'Coffee', 'Hot', true, true, false],
    ]);
  });

  it('degrades — never throws — when the traits table is missing', async () => {
    db.items = [item('a')];
    db.traitsError = { code: 'PGRST205', message: "Could not find the table 'public.menu_item_traits' in the schema cache" };
    expect(await getTraitsOverview()).toEqual({
      rows: [],
      unconfirmedCount: 0,
      missingCount: 0,
      needsUpgrade: 0,
      migrationApplied: false,
      missingTables: true,
    });
  });

  it('degrades when the menu cannot be read', async () => {
    db.itemsError = { message: 'menu down' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await getTraitsOverview()).toEqual({
        rows: [],
        unconfirmedCount: 0,
        missingCount: 0,
        needsUpgrade: 0,
        migrationApplied: false,
        missingTables: false,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('degrades when the traits read fails for another reason', async () => {
    db.items = [item('a')];
    db.traitsError = { code: '57014', message: 'statement timeout' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await getTraitsOverview()).toMatchObject({ rows: [], missingTables: false, migrationApplied: false });
    } finally {
      consoleError.mockRestore();
    }
  });
});
