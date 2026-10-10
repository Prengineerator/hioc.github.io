import { beforeEach, describe, expect, it, vi } from 'vitest';

// Coffey add-ons (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2.3) — the owner route
// /api/owner/suggest/addon-traits: GET lists every option with its derived and
// resolved traits, PATCH upserts one override, DELETE resets it, all owner-only,
// and while supabase/2026-10-coffey-addons-pairings.sql is not applied a write
// is a 409 with what to do (never a 500) and GET still answers with the derived
// traits. Handler-level, with a fake Supabase client (the style of
// tests/suggestTraitsV2Patch.test.ts).

type DbError = { code?: string; message: string } | null;
type Row = Record<string, unknown>;

const state = { owner: { id: 'owner-1' } as { id: string } | null };

const db = {
  groups: [] as Row[],
  groupsError: null as DbError,
  overrides: [] as Row[],
  overridesError: null as DbError,
  option: null as Row | null, // the addon_options row (with its embedded addon_group) the lookup finds
  optionError: null as DbError,
  upsertError: null as DbError,
  deleteError: null as DbError,
  log: [] as string[],
  lookups: [] as { select: string; column: string; value: unknown }[],
  upserts: [] as { table: string; row: Row; options: unknown }[],
  deletes: [] as { table: string; column: string; value: unknown }[],
};

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      db.log.push(table);
      if (table === 'addon_groups') {
        return {
          select: () => ({
            order: () => Promise.resolve({ data: db.groupsError ? null : db.groups, error: db.groupsError }),
          }),
        };
      }
      if (table === 'addon_options') {
        return {
          select: (select: string) => ({
            eq: (column: string, value: unknown) => {
              db.lookups.push({ select, column, value });
              return { maybeSingle: () => Promise.resolve({ data: db.optionError ? null : db.option, error: db.optionError }) };
            },
          }),
        };
      }
      if (table === 'addon_option_traits') {
        return {
          select: () => Promise.resolve({ data: db.overridesError ? null : db.overrides, error: db.overridesError }),
          upsert: (row: Row, options: unknown) => {
            db.upserts.push({ table, row, options });
            return Promise.resolve({ error: db.upsertError });
          },
          delete: () => ({
            eq: (column: string, value: unknown) => {
              db.deletes.push({ table, column, value });
              return Promise.resolve({ error: db.deleteError });
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

const { GET, PATCH, DELETE } = await import('@/app/api/owner/suggest/addon-traits/route');
const { deriveAddonTraits } = await import('@/lib/suggest/addonTraits');
const { ADDON_ROLES } = await import('@/lib/suggest/types');

const MIGRATION = 'Apply supabase/2026-10-coffey-addons-pairings.sql in Supabase, then try again.';
const MISSING_TABLE = { code: 'PGRST205', message: "Could not find the table 'public.addon_option_traits' in the schema cache" };

const OPT_HAZELNUT = '3dd077ea-b036-58f0-9a3b-dab3746e894c';
const OPT_VANILLA = '8f6a0c1e-9a5f-4a8e-9d3c-1c8d2e7b6a11';
const OPT_CHOC = '0b6d3f52-4c1a-4e0f-8f6d-5a7c9b2e4d33';
const OPT_NO_SUGAR = 'c4b1f6a2-7d3e-4f5a-9b8c-2d1e0f3a4b55';
const UNKNOWN = '11111111-2222-4333-8444-555555555555';

const syrupGroup = { id: 'g-syrup', name: 'Syrup', display_name: 'Add a Syrup', sort_order: 20 };
const sugarGroup = { id: 'g-sugar', name: 'Sugar', display_name: 'Choice of Sugar', sort_order: 10 };
const sauceGroup = { id: 'g-cond', name: 'Condiments', display_name: 'Add Condiments', sort_order: 30 };

const optionRow = (id: string, groupId: string, name: string, price: number, sort: number, extra: Row = {}): Row => ({
  id,
  addon_group_id: groupId,
  name,
  price_inr: price,
  sort_order: sort,
  ...extra,
});

function seedMenu() {
  // Deliberately out of order, to prove the route sorts by sort_order.
  db.groups = [
    {
      ...sauceGroup,
      options: [optionRow(OPT_CHOC, 'g-cond', 'Chocolate Sauce', 30, 10)],
    },
    {
      ...syrupGroup,
      options: [
        optionRow(OPT_VANILLA, 'g-syrup', 'Vanilla', 35, 20),
        optionRow(OPT_HAZELNUT, 'g-syrup', 'Hazelnut', 35, 10),
      ],
    },
    {
      ...sugarGroup,
      options: [optionRow(OPT_NO_SUGAR, 'g-sugar', 'No Sugar', 0, 0, { is_available: false })],
    },
  ];
}

const hazelnutLookup = () => ({ ...optionRow(OPT_HAZELNUT, 'g-syrup', 'Hazelnut', 35, 10), addon_group: syrupGroup });

const patchBody = (over: Row = {}): Row => ({
  optionId: OPT_HAZELNUT,
  role: 'topping',
  flavour_families: ['caramel', 'nutty'],
  sweetness_delta: 1,
  intensity_delta: 0,
  indulgence_delta: 2,
  textures: ['crunchy'],
  ...over,
});

const patch = async (body: unknown, raw = false) => {
  const res = await PATCH(
    new Request('http://t/api/owner/suggest/addon-traits', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
};

const del = (query: string) => DELETE(new Request(`http://t/api/owner/suggest/addon-traits${query}`, { method: 'DELETE' }));

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  Object.assign(db, {
    groups: [],
    groupsError: null,
    overrides: [],
    overridesError: null,
    option: null,
    optionError: null,
    upsertError: null,
    deleteError: null,
    log: [],
    lookups: [],
    upserts: [],
    deletes: [],
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------

describe('owner-only', () => {
  it('GET, PATCH and DELETE refuse a non-owner (403) and never touch the database', async () => {
    state.owner = null;
    expect((await GET()).status).toBe(403);
    expect((await patch(patchBody())).res.status).toBe(403);
    expect((await del(`?optionId=${OPT_HAZELNUT}`)).status).toBe(403);
    expect(db.log).toEqual([]);
  });

  it('answers the same JSON error shape the other owner routes use', async () => {
    state.owner = null;
    expect(await (await GET()).json()).toEqual({ error: 'Owner access required' });
  });
});

describe('GET', () => {
  it('lists every group and option, ordered by sort_order, with the derived traits', async () => {
    seedMenu();
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.menuMissing).toBe(false);
    expect(json.groups.map((g: Row) => g.id)).toEqual(['g-sugar', 'g-syrup', 'g-cond']);
    expect(json.groups[1].options.map((o: Row) => o.name)).toEqual(['Hazelnut', 'Vanilla']);
    expect(json.groups[1]).toMatchObject({ name: 'Syrup', display_name: 'Add a Syrup' });
  });

  it('describes an option: id, name, price, availability, label, derived, traits, overridden', async () => {
    seedMenu();
    const json = await (await GET()).json();
    const hazelnut = json.groups[1].options[0];
    expect(hazelnut).toEqual({
      id: OPT_HAZELNUT,
      name: 'Hazelnut',
      price_inr: 35,
      is_available: true,
      label: 'Hazelnut syrup',
      derived: deriveAddonTraits(syrupGroup, { name: 'Hazelnut' }),
      traits: deriveAddonTraits(syrupGroup, { name: 'Hazelnut' }),
      overridden: false,
    });
    expect(hazelnut.derived).toEqual({
      role: 'flavour',
      flavour_families: ['nutty'],
      sweetness_delta: 2,
      intensity_delta: 0,
      indulgence_delta: 0,
      textures: [],
    });
  });

  it('is_available reads false only when the option is switched off (a missing column is on)', async () => {
    seedMenu();
    const json = await (await GET()).json();
    expect(json.groups[0].options[0].is_available).toBe(false); // No Sugar, switched off
    expect(json.groups[1].options[0].is_available).toBe(true); // no column at all
  });

  it('an override wins in `traits`, `derived` stays what the names give, and only that option is `overridden`', async () => {
    seedMenu();
    db.overrides = [
      {
        option_id: OPT_HAZELNUT,
        role: 'topping',
        flavour_families: ['caramel', 'nutty'],
        sweetness_delta: 4,
        intensity_delta: 1,
        indulgence_delta: 2,
        textures: ['crunchy', 'soft'],
        updated_at: '2026-10-10T00:00:00Z',
      },
    ];
    const json = await (await GET()).json();
    const [hazelnut, vanilla] = json.groups[1].options;
    expect(hazelnut.overridden).toBe(true);
    expect(hazelnut.traits).toEqual({
      role: 'topping',
      flavour_families: ['caramel', 'nutty'],
      sweetness_delta: 4,
      intensity_delta: 1,
      indulgence_delta: 2,
      textures: ['crunchy', 'soft'],
    });
    expect(hazelnut.derived).toEqual(deriveAddonTraits(syrupGroup, { name: 'Hazelnut' }));
    expect(vanilla.overridden).toBe(false);
    expect(vanilla.traits).toEqual(vanilla.derived);
    expect(json.groups.flatMap((g: Row) => g.options as Row[]).filter((o: Row) => o.overridden)).toHaveLength(1);
  });

  it('the override columns are returned as AddonTraits only: no option_id or updated_at in `traits`', async () => {
    seedMenu();
    db.overrides = [
      { option_id: OPT_VANILLA, role: 'flavour', flavour_families: [], sweetness_delta: 0, intensity_delta: 0, indulgence_delta: 0, textures: [], updated_at: 'x' },
    ];
    const vanilla = (await (await GET()).json()).groups[1].options[1];
    expect(Object.keys(vanilla.traits).sort()).toEqual(['flavour_families', 'indulgence_delta', 'intensity_delta', 'role', 'sweetness_delta', 'textures']);
  });

  it('an override row with an unknown role is ignored, not shown', async () => {
    seedMenu();
    db.overrides = [{ option_id: OPT_HAZELNUT, role: 'bogus', flavour_families: [], sweetness_delta: 0, intensity_delta: 0, indulgence_delta: 0, textures: [] }];
    const hazelnut = (await (await GET()).json()).groups[1].options[0];
    expect(hazelnut.overridden).toBe(false);
    expect(ADDON_ROLES).not.toContain('bogus');
  });

  it('strips the "(newly Launched)" suffix and adds "syrup" in the label', async () => {
    db.groups = [{ ...syrupGroup, options: [optionRow(OPT_VANILLA, 'g-syrup', 'Salted Caramel (newly Launched)', 35, 0)] }];
    const option = (await (await GET()).json()).groups[0].options[0];
    expect(option.name).toBe('Salted Caramel (newly Launched)');
    expect(option.label).toBe('Salted Caramel syrup');
  });

  it('keeps a group with no options (the editor skips it)', async () => {
    db.groups = [{ ...syrupGroup, options: [] }];
    const json = await (await GET()).json();
    expect(json.groups).toEqual([{ id: 'g-syrup', name: 'Syrup', display_name: 'Add a Syrup', options: [] }]);
  });

  it('with no groups at all, answers an empty list', async () => {
    expect(await (await GET()).json()).toEqual({ groups: [], menuMissing: false });
  });

  describe('before the migration (addon_option_traits is missing)', () => {
    it.each([
      ['PGRST205', MISSING_TABLE],
      ['42P01', { code: '42P01', message: 'relation "addon_option_traits" does not exist' }],
      ['a message only', { message: 'relation "public.addon_option_traits" does not exist' }],
    ])('still answers 200 with menuMissing: true (%s)', async (_label, error) => {
      seedMenu();
      db.overridesError = error;
      const res = await GET();
      expect(res.status).toBe(200);
      expect((await res.json()).menuMissing).toBe(true);
    });

    it('returns the derived traits everywhere, with overridden: false', async () => {
      seedMenu();
      db.overridesError = MISSING_TABLE;
      const json = await (await GET()).json();
      const options = json.groups.flatMap((g: Row) => g.options as Row[]) as { overridden: boolean; traits: unknown; derived: unknown; label: string }[];
      expect(options).toHaveLength(4);
      for (const o of options) {
        expect(o.overridden).toBe(false);
        expect(o.traits).toEqual(o.derived);
      }
      expect(json.groups[1].options[0].derived.role).toBe('flavour');
    });

    it('a different override-read failure is a 500 with no database text, not a quiet "derived"', async () => {
      seedMenu();
      db.overridesError = { code: '57014', message: 'canceling statement due to statement timeout' };
      const res = await GET();
      expect(res.status).toBe(500);
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain('statement timeout');
    });
  });

  it('a failure reading the groups is a 500 with no database text', async () => {
    db.groupsError = { code: '08006', message: 'connection to server lost' };
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('connection');
  });
});

describe('PATCH — validation', () => {
  it('400 for a body that is not a JSON object, with nothing looked up or written', async () => {
    for (const raw of ['not json', '[]', '"x"', 'null']) {
      const { res, body } = await patch(raw, true);
      expect(res.status, raw).toBe(400);
      expect(body).toEqual({ error: 'Request body must be a JSON object' });
    }
    expect(db.lookups).toEqual([]);
    expect(db.upserts).toEqual([]);
  });

  it.each([
    [{ optionId: 'nope' }, 'A valid option id is required'],
    [{ optionId: undefined }, 'A valid option id is required'],
    [{ role: 'bogus' }, 'Invalid value for "role"'],
    [{ flavour_families: ['nutty', 'caramel', 'fruity'] }, 'Invalid value for "flavour_families"'],
    [{ flavour_families: ['nutty', 'nutty'] }, 'Invalid value for "flavour_families"'],
    [{ sweetness_delta: 6 }, 'Invalid value for "sweetness_delta"'],
    [{ intensity_delta: 3 }, 'Invalid value for "intensity_delta"'],
    [{ indulgence_delta: -1 }, 'Invalid value for "indulgence_delta"'],
    [{ textures: ['silky', 'creamy', 'frothy'] }, 'Invalid value for "textures"'],
    [{ textures: undefined }, 'Missing value for "textures"'],
    [{ source: 'owner' }, 'Unknown field "source"'],
  ])('400 for %j, nothing looked up or written', async (over, message) => {
    const body = patchBody(over);
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    const res = await patch(body);
    expect(res.res.status).toBe(400);
    expect(res.body).toEqual({ error: message });
    expect(db.lookups).toEqual([]);
    expect(db.upserts).toEqual([]);
  });
});

describe('PATCH — saving an override', () => {
  beforeEach(() => {
    db.option = hazelnutLookup();
  });

  it('looks the option up by id, with its group', async () => {
    await patch(patchBody());
    expect(db.lookups).toHaveLength(1);
    expect(db.lookups[0]).toMatchObject({ column: 'id', value: OPT_HAZELNUT });
    expect(db.lookups[0].select).toContain('addon_groups');
  });

  it('upserts into addon_option_traits, on option_id, with ONLY the AddonTraits columns, option_id and updated_at', async () => {
    const before = Date.now();
    const { res } = await patch(patchBody());
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(db.upserts).toHaveLength(1);
    const { table, row, options } = db.upserts[0];
    expect(table).toBe('addon_option_traits');
    expect(options).toEqual({ onConflict: 'option_id' });
    expect(Object.keys(row).sort()).toEqual(
      ['flavour_families', 'indulgence_delta', 'intensity_delta', 'option_id', 'role', 'sweetness_delta', 'textures', 'updated_at'].sort(),
    );
    expect(row).toMatchObject({
      option_id: OPT_HAZELNUT,
      role: 'topping',
      flavour_families: ['caramel', 'nutty'],
      sweetness_delta: 1,
      intensity_delta: 0,
      indulgence_delta: 2,
      textures: ['crunchy'],
    });
    const stamped = Date.parse(String(row.updated_at));
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('writes the families in FLAVOUR_FAMILIES order whatever order they were sent in', async () => {
    await patch(patchBody({ flavour_families: ['nutty', 'chocolatey'] }));
    expect(db.upserts[0].row.flavour_families).toEqual(['chocolatey', 'nutty']);
  });

  it('can save an empty profile (no families, no textures, every lift 0)', async () => {
    const { res } = await patch(patchBody({ role: 'other', flavour_families: [], sweetness_delta: 0, indulgence_delta: 0, textures: [] }));
    expect(res.status).toBe(200);
    expect(db.upserts[0].row).toMatchObject({ role: 'other', flavour_families: [], sweetness_delta: 0, intensity_delta: 0, indulgence_delta: 0, textures: [] });
  });

  it('answers the refreshed option: the saved traits win, derived stays derived, overridden is true', async () => {
    const { res, body } = await patch(patchBody());
    expect(res.status).toBe(200);
    expect(body).toEqual({
      option: {
        id: OPT_HAZELNUT,
        name: 'Hazelnut',
        price_inr: 35,
        is_available: true,
        label: 'Hazelnut syrup',
        derived: deriveAddonTraits(syrupGroup, { name: 'Hazelnut' }),
        traits: {
          role: 'topping',
          flavour_families: ['caramel', 'nutty'],
          sweetness_delta: 1,
          intensity_delta: 0,
          indulgence_delta: 2,
          textures: ['crunchy'],
        },
        overridden: true,
      },
    });
  });

  it('a second save of the same option is just another upsert (replace, not append)', async () => {
    await patch(patchBody());
    await patch(patchBody({ sweetness_delta: 3 }));
    expect(db.upserts).toHaveLength(2);
    expect(db.upserts[1].row.sweetness_delta).toBe(3);
    expect(db.upserts[1].row.option_id).toBe(OPT_HAZELNUT);
  });

  it('reads the option the id names, and writes only that id (a body cannot redirect the write)', async () => {
    await patch(patchBody({ optionId: OPT_HAZELNUT }));
    expect(db.upserts[0].row.option_id).toBe(OPT_HAZELNUT);
    expect(db.lookups[0].value).toBe(OPT_HAZELNUT);
  });
});

describe('PATCH — failures', () => {
  it('404 when the option does not exist, and nothing is written', async () => {
    db.option = null;
    const { res, body } = await patch(patchBody({ optionId: UNKNOWN }));
    expect(res.status).toBe(404);
    expect(String(body.error)).toMatch(/no longer exists/);
    expect(db.upserts).toEqual([]);
  });

  it('404 when the option vanished between the lookup and the write (foreign-key violation)', async () => {
    db.option = hazelnutLookup();
    db.upsertError = { code: '23503', message: 'insert or update on table "addon_option_traits" violates foreign key constraint' };
    const { res } = await patch(patchBody());
    expect(res.status).toBe(404);
  });

  it.each([
    ['PGRST205', MISSING_TABLE],
    ['42P01', { code: '42P01', message: 'relation "addon_option_traits" does not exist' }],
    ['a stale schema cache', { code: 'PGRST204', message: "Could not find the 'updated_at' column of 'addon_option_traits' in the schema cache" }],
  ])('409 with what to do when the table is missing (%s) — never a 500', async (_label, error) => {
    db.option = hazelnutLookup();
    db.upsertError = error;
    const { res, body } = await patch(patchBody());
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: MIGRATION });
  });

  it('a missing table is still 404 for an option that does not exist (the lookup comes first)', async () => {
    db.option = null;
    db.upsertError = MISSING_TABLE;
    expect((await patch(patchBody({ optionId: UNKNOWN }))).res.status).toBe(404);
  });

  it('any other write error is a 500 that does not leak the database message', async () => {
    db.option = hazelnutLookup();
    db.upsertError = { code: '23514', message: 'new row for relation "addon_option_traits" violates check constraint "addon_option_traits_role_check"' };
    const { res, body } = await patch(patchBody());
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('check constraint');
  });

  it('a failed option lookup is a 500 and nothing is written', async () => {
    db.optionError = { code: '57014', message: 'timeout' };
    const { res } = await patch(patchBody());
    expect(res.status).toBe(500);
    expect(db.upserts).toEqual([]);
  });
});

describe('DELETE — Reset to derived', () => {
  it('deletes the override of that option and answers 204 with no body', async () => {
    const res = await del(`?optionId=${OPT_HAZELNUT}`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(db.deletes).toEqual([{ table: 'addon_option_traits', column: 'option_id', value: OPT_HAZELNUT }]);
  });

  it('is idempotent: resetting an option with no override (or that does not exist) is 204 again', async () => {
    expect((await del(`?optionId=${OPT_HAZELNUT}`)).status).toBe(204);
    expect((await del(`?optionId=${OPT_HAZELNUT}`)).status).toBe(204);
    expect((await del(`?optionId=${UNKNOWN}`)).status).toBe(204);
    expect(db.deletes).toHaveLength(3);
  });

  it('deletes only the override table — never the option itself', async () => {
    await del(`?optionId=${OPT_HAZELNUT}`);
    expect(db.log).toEqual(['addon_option_traits']);
  });

  it.each(['', '?', '?optionId=', '?optionId=nope', `?optionId=${OPT_HAZELNUT}0`, '?id=3dd077ea-b036-58f0-9a3b-dab3746e894c', "?optionId=' or 1=1 --"])(
    '400 for %j, nothing deleted',
    async (query) => {
      const res = await del(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'A valid option id is required' });
      expect(db.deletes).toEqual([]);
    },
  );

  it.each([
    ['PGRST205', MISSING_TABLE],
    ['42P01', { code: '42P01', message: 'relation "addon_option_traits" does not exist' }],
  ])('409 with what to do when the table is missing (%s)', async (_label, error) => {
    db.deleteError = error;
    const res = await del(`?optionId=${OPT_HAZELNUT}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: MIGRATION });
  });

  it('any other failure is a 500 that does not leak the database message', async () => {
    db.deleteError = { code: '57014', message: 'canceling statement due to statement timeout' };
    const res = await del(`?optionId=${OPT_HAZELNUT}`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('statement timeout');
  });
});

describe('the route module', () => {
  it('is dynamic, like the traits route', async () => {
    const mod = await import('@/app/api/owner/suggest/addon-traits/route');
    expect(mod.dynamic).toBe('force-dynamic');
    expect(Object.keys(mod).sort()).toEqual(['DELETE', 'GET', 'PATCH', 'dynamic']);
  });
});
