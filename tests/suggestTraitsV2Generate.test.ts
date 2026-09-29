import { beforeEach, describe, expect, it, vi } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.3) — POST /api/owner/suggest/traits/generate
// as the owner's REGENERATE button. Handler-level, with a fake Supabase client
// (the style of tests/suggestRoute.test.ts): what is probed, which items are
// sent to Jev and in what order, which rows are written how, and what the race
// guard and `remaining` say. Jev itself is mocked out — the tagger's own
// behaviour is in tests/suggestJevTraits.test.ts.

import type { MenuItemForTagging, TagTraitsResult } from '@/lib/suggest/traitsPrompt';
import type { ValidatedTraitRowV2 } from '@/lib/suggest/traitsValidate';

type DbError = { code?: string; message: string } | null;
type Row = Record<string, unknown>;

const state = {
  owner: { id: 'owner-1' } as { id: string } | null,
  rateLimitOk: true,
};

const db = {
  probeError: null as DbError,
  menuRows: [] as Row[],
  menuError: null as DbError,
  /** Successive answers to the four-column menu_item_traits read: [first read, recheck]. The last one repeats. */
  traitReads: [] as Row[][],
  firstReadError: null as DbError,
  recheckError: null as DbError,
  upsertError: null as DbError,
  updateErrorFor: new Map<string, DbError>(),
  // What the route did:
  log: [] as string[],
  reads: 0,
  upserts: [] as { rows: Row[]; options: unknown }[],
  updates: [] as { payload: Row; column: string; value: unknown }[],
};

const tagMock = vi.fn<(items: MenuItemForTagging[]) => Promise<TagTraitsResult>>();

function thenable<T>(result: T) {
  return {
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    limit: () => thenable(result),
  };
}

const fakeAdmin = {
  from(table: string) {
    if (table === 'menu_items') {
      return {
        select: (columns: string) => {
          db.log.push(`menu_items.select`);
          expect(columns).toContain('menu_item_variants'); // the embed the menu loader uses
          expect(columns).toContain('addon_groups');
          return thenable({ data: db.menuError ? null : db.menuRows, error: db.menuError });
        },
      };
    }
    if (table === 'menu_item_traits') {
      return {
        select: (columns: string) => {
          if (columns === 'traits_version') {
            db.log.push('probe');
            return thenable({ data: [], error: db.probeError });
          }
          // both the first read and the race guard's re-read: `sweetness` is what an owner row's merge needs
          expect(columns).toBe('menu_item_id, confirmed, source, traits_version, sweetness');
          const call = db.reads++;
          db.log.push(call === 0 ? 'read' : 'recheck');
          const error = call === 0 ? db.firstReadError : db.recheckError;
          const rows = db.traitReads[Math.min(call, db.traitReads.length - 1)] ?? [];
          return thenable({ data: error ? null : rows, error });
        },
        upsert: (rows: Row[], options: unknown) => {
          db.log.push('upsert');
          db.upserts.push({ rows, options });
          return Promise.resolve({ error: db.upsertError });
        },
        update: (payload: Row) => ({
          eq: (column: string, value: unknown) => {
            db.log.push('update');
            db.updates.push({ payload, column, value });
            return Promise.resolve({ error: db.updateErrorFor.get(value as string) ?? null });
          },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  },
};

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => fakeAdmin }));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(state.rateLimitOk) }));
// Everything real except the Jev call itself (withRelatedDescriptions stays real).
vi.mock('@/lib/suggest/traitsPrompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/suggest/traitsPrompt')>();
  return { ...actual, tagMenuItemTraits: (items: MenuItemForTagging[]) => tagMock(items) };
});

const { POST } = await import('@/app/api/owner/suggest/traits/generate/route');

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface MenuSpec {
  description?: string | null;
  variants?: { label: string; price_inr: number }[];
  groups?: { name: string; display_name: string; options: string[] }[];
}

/** A menu_items row exactly as `select(MENU_ITEM_SELECT)` nests it. */
function menuRow(id: string, name: string, spec: MenuSpec = {}): Row {
  return {
    id,
    name,
    description: spec.description === undefined ? '' : spec.description,
    category: 'Coffee',
    parent_category: 'Hot',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    menu_item_variants: (spec.variants ?? [{ label: 'Regular', price_inr: 100 }]).map((v, i) => ({
      id: `${id}-v${i}`,
      menu_item_id: id,
      label: v.label,
      price_inr: v.price_inr,
      sort_order: i * 10,
    })),
    menu_item_addon_groups: (spec.groups ?? []).map((g, gi) => ({
      addon_groups: {
        id: `${id}-g${gi}`,
        name: g.name,
        display_name: g.display_name,
        selection_type: 'single',
        min_select: 1,
        max_select: 1,
        sort_order: gi,
        options: g.options.map((o, oi) => ({ id: `${id}-g${gi}-o${oi}`, addon_group_id: `${id}-g${gi}`, name: o, price_inr: 0, sort_order: oi * 10 })),
      },
    })),
  };
}

const traitState = (id: string, confirmed: boolean, source: 'opus' | 'owner', version: number, sweetness = 1): Row => ({
  menu_item_id: id,
  confirmed,
  source,
  traits_version: version,
  sweetness,
});

/** The row Jev's tagger would return for an item. */
function tagged(id: string, overrides: Partial<ValidatedTraitRowV2> = {}): ValidatedTraitRowV2 {
  return {
    menu_item_id: id,
    temperature: 'iced',
    caffeine: 'medium',
    is_coffee: true,
    sweetness: 1,
    body: 'medium',
    kind: 'drink',
    moods: ['cool', 'focus'],
    dayparts: ['afternoon'],
    flavor_notes: ['espresso'],
    sweetness_level: 3,
    intensity: 2,
    refreshment: 3,
    indulgence: 1,
    novelty: 0,
    textures: ['icy'],
    mood_fit: { cool: 2.8, focus: 2.1 },
    traits_version: 2,
    ...overrides,
  };
}

function tagResult(rows: ValidatedTraitRowV2[], extra: Partial<TagTraitsResult> = {}): TagTraitsResult {
  return {
    rows,
    usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsdMicros: 42 },
    batches: rows.length,
    failedBatches: 0,
    needsReview: [],
    ...extra,
  };
}

const V2_KEYS = ['sweetness_level', 'intensity', 'refreshment', 'indulgence', 'novelty', 'textures', 'mood_fit', 'traits_version'];
const V1_AND_PROVENANCE_KEYS = ['temperature', 'caffeine', 'is_coffee', 'sweetness', 'body', 'kind', 'moods', 'dayparts', 'flavor_notes', 'source', 'confirmed', 'updated_at', 'menu_item_id'];

/** The menu the scenarios share (in this order):
 *   current1   confirmed, model-tagged, already v2   → never a target
 *   ownerCur   confirmed, owner-edited, already v2   → never a target
 *   unconf1    unconfirmed, v2                       → a target (worked last)
 *   owner1     confirmed, owner-edited, v1           → target: v2 columns only
 *   bulk1      confirmed, model-tagged, v1           → target: fully re-tagged
 *   missing1   no traits row                         → target: fully tagged
 *   unconfV1   unconfirmed, v1                       → target: fully re-tagged
 */
function standardScenario() {
  db.menuRows = ['current1', 'ownerCur', 'unconf1', 'owner1', 'bulk1', 'missing1', 'unconfV1'].map((id) => menuRow(id, id));
  db.traitReads = [
    [
      traitState('current1', true, 'opus', 2),
      traitState('ownerCur', true, 'owner', 2),
      traitState('unconf1', false, 'opus', 2),
      traitState('owner1', true, 'owner', 1),
      traitState('bulk1', true, 'opus', 1),
      traitState('unconfV1', false, 'opus', 1),
    ],
  ];
}

/** Sets the stored legacy sweetness of `id` in the scenario's first read (and, unless told otherwise, the re-read). */
function ownerSweetness(id: string, sweetness: number, reads: number[] = [0, 1]) {
  // The scenario has one read that the fake repeats for the re-read; split it so the two can differ.
  if (db.traitReads.length < 2) db.traitReads = [db.traitReads[0], db.traitReads[0]];
  for (const i of reads) {
    db.traitReads[i] = db.traitReads[i].map((r) => (r.menu_item_id === id ? { ...r, sweetness } : r));
  }
}

const sentIds = () => (tagMock.mock.calls[0]?.[0] ?? []).map((i) => i.id);
const post = async () => {
  const res = await POST();
  return { res, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  tagMock.mockReset();
  state.owner = { id: 'owner-1' };
  state.rateLimitOk = true;
  Object.assign(db, {
    probeError: null,
    menuRows: [],
    menuError: null,
    traitReads: [[]],
    firstReadError: null,
    recheckError: null,
    upsertError: null,
    updateErrorFor: new Map(),
    log: [],
    reads: 0,
    upserts: [],
    updates: [],
  });
  delete process.env.SUGGEST_LLM;
  process.env.TYPESAFE_API_KEY = 'test-key';
});

// ---------------------------------------------------------------------------

describe('POST /api/owner/suggest/traits/generate — gates (unchanged)', () => {
  it('403s a non-owner before touching anything', async () => {
    state.owner = null;
    const { res, body } = await post();
    expect(res.status).toBe(403);
    expect(body.error).toBe('Owner access required');
    expect(db.log).toEqual([]);
    expect(tagMock).not.toHaveBeenCalled();
  });

  it('429s past the hourly limit', async () => {
    state.rateLimitOk = false;
    const { res } = await post();
    expect(res.status).toBe(429);
    expect(tagMock).not.toHaveBeenCalled();
  });

  it('503s — not a 500 — when Jev is not configured', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const { res, body } = await post();
    expect(res.status).toBe(503);
    expect(body.error).toMatch(/TYPESAFE_API_KEY/);
    expect(tagMock).not.toHaveBeenCalled();
  });

  it('503s when Jev turns out to be unavailable mid-request', async () => {
    standardScenario();
    tagMock.mockRejectedValue(new Error('TYPESAFE_API_KEY is not set'));
    const { res } = await post();
    expect(res.status).toBe(503);
    expect(db.upserts).toEqual([]);
  });
});

describe('POST /api/owner/suggest/traits/generate — before the migration', () => {
  const MESSAGE = 'Apply supabase/2026-10-coffey-traits-v2.sql in Supabase, then press Regenerate again.';

  it.each([
    ['Postgres 42703', { code: '42703', message: 'column menu_item_traits.traits_version does not exist' }],
    ['PostgREST PGRST204', { code: 'PGRST204', message: "Could not find the 'traits_version' column of 'menu_item_traits' in the schema cache" }],
    ['a schema-cache message with no code', { message: "Could not find the 'traits_version' column of 'menu_item_traits' in the schema cache" }],
    ['a "does not exist" message with no code', { message: 'column "traits_version" does not exist' }],
  ])('answers 409 with what to do, on %s', async (_label, error) => {
    standardScenario();
    db.probeError = error;
    const { res, body } = await post();
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: MESSAGE });
  });

  it('probes first and stops there: no menu load, no Jev call, no write', async () => {
    standardScenario();
    db.probeError = { code: '42703', message: 'column menu_item_traits.traits_version does not exist' };
    await post();
    expect(db.log).toEqual(['probe']);
    expect(tagMock).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('also answers 409 — never 500 — when the traits table itself is missing', async () => {
    db.probeError = { code: 'PGRST205', message: "Could not find the table 'public.menu_item_traits' in the schema cache" };
    const { res, body } = await post();
    expect(res.status).toBe(409);
    expect(String(body.error)).toContain('2026-09-suggestion-engine.sql');
    expect(String(body.error)).toContain('2026-10-coffey-traits-v2.sql');
  });

  it('a genuinely different probe failure is a 500 with its message', async () => {
    db.probeError = { code: '57014', message: 'canceling statement due to statement timeout' };
    const { res, body } = await post();
    expect(res.status).toBe(500);
    expect(body.error).toBe('canceling statement due to statement timeout');
    expect(tagMock).not.toHaveBeenCalled();
  });

  it('probes traits_version — the column the migration adds', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([]));
    await post();
    expect(db.log[0]).toBe('probe');
  });
});

describe('POST /api/owner/suggest/traits/generate — which items are targets', () => {
  it('targets missing rows, unconfirmed rows and rows below the current version — never a confirmed current row', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([]));
    await post();
    expect([...sentIds()].sort()).toEqual(['bulk1', 'missing1', 'owner1', 'unconf1', 'unconfV1']);
    expect(sentIds()).not.toContain('current1');
    expect(sentIds()).not.toContain('ownerCur');
  });

  it('works rows still below the current version FIRST, then unconfirmed current ones — menu order within each', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([]));
    await post();
    // menu order: current1, ownerCur, unconf1, owner1, bulk1, missing1, unconfV1
    expect(sentIds()).toEqual(['owner1', 'bulk1', 'missing1', 'unconfV1', 'unconf1']);
  });

  it('a row with no version on record is version 1', async () => {
    db.menuRows = [menuRow('legacy', 'Legacy')];
    db.traitReads = [[{ menu_item_id: 'legacy', confirmed: true, source: 'opus' }]];
    tagMock.mockResolvedValue(tagResult([]));
    await post();
    expect(sentIds()).toEqual(['legacy']);
  });

  it('sends the item as Jev needs to see it: sizes with prices, customisation groups with option names', async () => {
    db.menuRows = [
      menuRow('latte-iced', 'Latte Iced', {
        description: 'Iced Latte is a smooth espresso paired with creamy chilled milk.',
        variants: [
          { label: 'Regular', price_inr: 180 },
          { label: 'Large', price_inr: 210 },
        ],
        groups: [
          { name: 'Sugar', display_name: 'Choice of Sugar', options: ['Stevia (sugarfree)', 'Brown Sugar', 'No Sugar', 'Normal'] },
          { name: 'ADD ON Milk', display_name: '', options: ['Oat', 'Almond'] },
        ],
      }),
    ];
    tagMock.mockResolvedValue(tagResult([]));
    await post();
    expect(tagMock.mock.calls[0][0]).toEqual([
      {
        id: 'latte-iced',
        name: 'Latte Iced',
        description: 'Iced Latte is a smooth espresso paired with creamy chilled milk.',
        category: 'Coffee',
        parent_category: 'Hot',
        sizes: [
          { label: 'Regular', price_inr: 180 },
          { label: 'Large', price_inr: 210 },
        ],
        customisations: [
          { group: 'Choice of Sugar', options: ['Stevia (sugarfree)', 'Brown Sugar', 'No Sugar', 'Normal'] },
          { group: 'ADD ON Milk', options: ['Oat', 'Almond'] }, // no display name → the group's name
        ],
      },
    ]);
  });

  it('a null description reaches Jev as an empty string', async () => {
    db.menuRows = [menuRow('x', 'Some Waffle', { description: null })];
    tagMock.mockResolvedValue(tagResult([]));
    await post();
    expect(tagMock.mock.calls[0][0][0].description).toBe('');
  });

  it('fills related_description from the WHOLE menu — including items that are not being re-tagged', async () => {
    db.menuRows = [
      menuRow('oreo-heaven', 'Oreo-Heaven', { description: 'A dreamy waffle with an Oreo-infused base.' }),
      menuRow('cupcake', 'Oreo Heaven Cupcake'),
    ];
    db.traitReads = [[traitState('oreo-heaven', true, 'opus', 2)]]; // current and confirmed: NOT a target
    tagMock.mockResolvedValue(tagResult([]));
    await post();
    expect(sentIds()).toEqual(['cupcake']);
    // the source item's NAME travels with its description, so Jev knows it describes a different item
    expect(tagMock.mock.calls[0][0][0].related_description).toBe(
      'From the related menu item "Oreo-Heaven": A dreamy waffle with an Oreo-infused base.',
    );
  });

  it('with nothing to do it answers straight away — no Jev call, remaining 0', async () => {
    db.menuRows = [menuRow('a', 'A'), menuRow('b', 'B')];
    db.traitReads = [[traitState('a', true, 'opus', 2), traitState('b', true, 'owner', 2)]];
    const { res, body } = await post();
    expect(res.status).toBe(200);
    expect(body).toEqual({ tagged: 0, requested: 0, batches: 0, failedBatches: 0, costUsd: 0, needsReview: [], remaining: 0 });
    expect(tagMock).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });
});

describe('POST /api/owner/suggest/traits/generate — write rules', () => {
  it('an owner-edited row gets ONLY the v2 columns and traits_version, by UPDATE — never an upsert', async () => {
    standardScenario();
    ownerSweetness('owner1', 2); // Jev's level 7 below is legacy 2 too, so its finer level is written as-is
    tagMock.mockResolvedValue(tagResult([tagged('owner1', { sweetness_level: 7, intensity: 3, textures: ['silky', 'creamy'], mood_fit: { boost: 2.5 } })]));
    const { res } = await post();
    expect(res.status).toBe(200);

    expect(db.updates).toHaveLength(1);
    const [update] = db.updates;
    expect(update.column).toBe('menu_item_id');
    expect(update.value).toBe('owner1');
    expect(update.payload).toEqual({
      sweetness_level: 7,
      intensity: 3,
      refreshment: 3,
      indulgence: 1,
      novelty: 0,
      textures: ['silky', 'creamy'],
      mood_fit: { boost: 2.5 },
      traits_version: 2,
    });
    expect(Object.keys(update.payload).sort()).toEqual([...V2_KEYS].sort());
    // every v1 column, source, confirmed and updated_at stay exactly as the owner left them
    for (const key of V1_AND_PROVENANCE_KEYS) expect(update.payload).not.toHaveProperty(key);
    expect(db.upserts.flatMap((u) => u.rows.map((r) => r.menu_item_id))).not.toContain('owner1');
  });

  it('a bulk-confirmed MODEL row is fully re-tagged: every field, source opus, confirmed false, version 2', async () => {
    standardScenario();
    const row = tagged('bulk1', { temperature: 'hot', caffeine: 'high', sweetness_level: 0, sweetness: 0, kind: 'drink' });
    tagMock.mockResolvedValue(tagResult([row]));
    await post();

    expect(db.updates).toEqual([]);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].options).toEqual({ onConflict: 'menu_item_id' });
    expect(db.upserts[0].rows).toEqual([
      {
        menu_item_id: 'bulk1',
        temperature: 'hot',
        caffeine: 'high',
        is_coffee: true,
        sweetness: 0,
        body: 'medium',
        kind: 'drink',
        moods: ['cool', 'focus'],
        dayparts: ['afternoon'],
        flavor_notes: ['espresso'],
        sweetness_level: 0,
        intensity: 2,
        refreshment: 3,
        indulgence: 1,
        novelty: 0,
        textures: ['icy'],
        mood_fit: { cool: 2.8, focus: 2.1 },
        traits_version: 2,
        source: 'opus',
        confirmed: false,
        updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    ]);
  });

  it('missing and unconfirmed rows are upserted in one batch, all stamped opus / unconfirmed / current version', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('missing1'), tagged('unconfV1'), tagged('unconf1')]));
    await post();
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].rows.map((r) => r.menu_item_id).sort()).toEqual(['missing1', 'unconf1', 'unconfV1']);
    for (const r of db.upserts[0].rows) {
      expect(r).toMatchObject({ source: 'opus', confirmed: false, traits_version: 2 });
      expect(r.updated_at).toEqual(db.upserts[0].rows[0].updated_at); // one timestamp for the run
    }
  });

  it('writes the version the CODE says is current, not whatever the row carries', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('bulk1', { traits_version: 9 }), tagged('owner1', { traits_version: 9 })]));
    await post();
    expect(db.upserts[0].rows[0].traits_version).toBe(2);
    expect(db.updates[0].payload.traits_version).toBe(2);
  });

  it('a confirmed row already at the current version is byte-identical afterwards — never written', async () => {
    standardScenario();
    // Jev even returns rows for them (it should never have been asked):
    tagMock.mockResolvedValue(tagResult([tagged('current1'), tagged('ownerCur'), tagged('bulk1')]));
    await post();
    const written = [...db.upserts.flatMap((u) => u.rows.map((r) => r.menu_item_id)), ...db.updates.map((u) => u.value)];
    // (the route only writes what it asked Jev about AND got back — but it must never have asked)
    expect(sentIds()).not.toContain('current1');
    expect(sentIds()).not.toContain('ownerCur');
    expect(written).toContain('bulk1');
  });

  it('runs one UPDATE per owner row, and a full batch for the rest', async () => {
    db.menuRows = Array.from({ length: 25 }, (_, i) => menuRow(`o${i}`, `Owner ${i}`)).concat([menuRow('m', 'Model')]);
    db.traitReads = [[...Array.from({ length: 25 }, (_, i) => traitState(`o${i}`, true, 'owner', 1)), traitState('m', true, 'opus', 1)]];
    tagMock.mockImplementation(async (items) => tagResult(items.map((i) => tagged(i.id))));
    const { body } = await post();
    expect(db.updates.map((u) => u.value).sort()).toEqual(Array.from({ length: 25 }, (_, i) => `o${i}`).sort());
    expect(db.upserts[0].rows.map((r) => r.menu_item_id)).toEqual(['m']);
    expect(body.tagged).toBe(26);
    expect(body.remaining).toBe(0);
  });

  it('500s with the message if the upsert fails, and does not go on to the merges', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('bulk1'), tagged('owner1')]));
    db.upsertError = { message: 'boom' };
    const { res, body } = await post();
    expect(res.status).toBe(500);
    expect(body.error).toBe('boom');
    expect(db.updates).toEqual([]);
  });

  it('500s with the message if an owner-row update fails', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('owner1')]));
    db.updateErrorFor.set('owner1', { message: 'update failed' });
    const { res, body } = await post();
    expect(res.status).toBe(500);
    expect(body.error).toBe('update failed');
  });

  it('writes nothing when Jev tagged nothing', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([], { failedBatches: 5, firstError: '401 bad key' }));
    const { res, body } = await post();
    expect(res.status).toBe(200);
    expect(db.upserts).toEqual([]);
    expect(db.updates).toEqual([]);
    expect(body).toMatchObject({ tagged: 0, requested: 5, failedBatches: 5, error: '401 bad key' });
  });
});

describe("POST /api/owner/suggest/traits/generate — an owner row keeps its own sweetness", () => {
  // Written out here rather than imported, so this is an independent statement
  // of COFFEY-SPEC §3.1: which 0–3 bucket a 0–10 level falls in, and where each
  // bucket sits on the 0–10 scale.
  const bucketOf = (level: number) => (level <= 1 ? 0 : level <= 4 ? 1 : level <= 7 ? 2 : 3);
  const LEVEL_OF_BUCKET = [0, 3, 6, 9];

  /** The sweetness_level an owner row's merge writes, given the owner's stored sweetness and Jev's level. */
  async function mergedLevel(owner: number, jevLevel: number): Promise<unknown> {
    // self-contained: several of these run inside one test
    Object.assign(db, { log: [], reads: 0, upserts: [], updates: [] });
    tagMock.mockReset();
    standardScenario();
    ownerSweetness('owner1', owner);
    tagMock.mockResolvedValue(tagResult([tagged('owner1', { sweetness_level: jevLevel, sweetness: bucketOf(jevLevel) })]));
    await post();
    expect(db.updates).toHaveLength(1);
    return db.updates[0].payload.sweetness_level;
  }

  it("writes Jev's finer level when it agrees with the owner's sweetness", async () => {
    expect(await mergedLevel(0, 1)).toBe(1);
    expect(await mergedLevel(1, 3)).toBe(3);
    expect(await mergedLevel(1, 4)).toBe(4);
    expect(await mergedLevel(2, 6)).toBe(6);
    expect(await mergedLevel(2, 7)).toBe(7);
    expect(await mergedLevel(3, 10)).toBe(10);
  });

  it("writes the owner's own value on the 0–10 scale when Jev's level disagrees — the owner wins", async () => {
    expect(await mergedLevel(3, 3)).toBe(9); // owner: very sweet; Jev: level 3 (legacy 1)
    expect(await mergedLevel(0, 8)).toBe(0); // owner: not sweet; Jev: level 8 (legacy 3)
    expect(await mergedLevel(2, 1)).toBe(6);
    expect(await mergedLevel(1, 10)).toBe(3);
    expect(await mergedLevel(3, 0)).toBe(9);
  });

  it('holds for every owner sweetness against every Jev level', async () => {
    for (const owner of [0, 1, 2, 3]) {
      for (let jev = 0; jev <= 10; jev++) {
        const expected = bucketOf(jev) === owner ? jev : LEVEL_OF_BUCKET[owner];
        expect(await mergedLevel(owner, jev), `owner ${owner}, Jev level ${jev}`).toBe(expected);
      }
    }
  });

  it("goes by the owner's CURRENT sweetness: the re-read beats the first read, in either direction", async () => {
    standardScenario();
    ownerSweetness('owner1', 1, [0]); // the owner had said 1…
    ownerSweetness('owner1', 3, [1]); // …and changed it to 3 while Jev was tagging
    tagMock.mockResolvedValue(tagResult([tagged('owner1', { sweetness_level: 3, sweetness: 1 })]));
    await post();
    expect(db.updates[0].payload.sweetness_level).toBe(9);

    Object.assign(db, { log: [], reads: 0, upserts: [], updates: [] });
    standardScenario();
    ownerSweetness('owner1', 3, [0]);
    ownerSweetness('owner1', 1, [1]);
    await post();
    expect(db.updates[0].payload.sweetness_level).toBe(3); // now agrees with Jev's level 3 (legacy 1)
  });

  it("falls back to the first read's sweetness when the re-read no longer lists the row", async () => {
    standardScenario();
    ownerSweetness('owner1', 3, [0]);
    db.traitReads = [db.traitReads[0], db.traitReads[0].filter((r) => r.menu_item_id !== 'owner1')];
    tagMock.mockResolvedValue(tagResult([tagged('owner1', { sweetness_level: 3, sweetness: 1 })]));
    await post();
    expect(db.updates[0].payload.sweetness_level).toBe(9);
  });

  it("a row the owner edited mid-run is judged on the sweetness they just set", async () => {
    standardScenario();
    // bulk1 was a model row at the first read; by the re-read it is the owner's, with sweetness 3
    db.traitReads = [db.traitReads[0], db.traitReads[0].map((r) => (r.menu_item_id === 'bulk1' ? traitState('bulk1', true, 'owner', 1, 3) : r))];
    tagMock.mockResolvedValue(tagResult([tagged('bulk1', { sweetness_level: 3, sweetness: 1 })]));
    await post();
    expect(db.upserts).toEqual([]);
    expect(db.updates[0].payload.sweetness_level).toBe(9);
  });

  it("only ever moves the v2 level: the owner's legacy sweetness is never in the payload", async () => {
    standardScenario();
    ownerSweetness('owner1', 3);
    tagMock.mockResolvedValue(tagResult([tagged('owner1', { sweetness_level: 3, sweetness: 1 })]));
    await post();
    const payload = db.updates[0].payload;
    expect(payload).not.toHaveProperty('sweetness');
    expect(Object.keys(payload).sort()).toEqual([...V2_KEYS].sort());
    expect(payload.sweetness_level).toBe(9);
  });

  it("each owner row is judged on its own sweetness", async () => {
    db.menuRows = [0, 1, 2, 3].map((n) => menuRow(`o${n}`, `Owner ${n}`));
    db.traitReads = [[0, 1, 2, 3].map((n) => traitState(`o${n}`, true, 'owner', 1, n))];
    // Jev says level 3 (legacy 1) for all four
    tagMock.mockImplementation(async (items) => tagResult(items.map((i) => tagged(i.id, { sweetness_level: 3, sweetness: 1 }))));
    await post();
    const levels = Object.fromEntries(db.updates.map((u) => [u.value, u.payload.sweetness_level]));
    expect(levels).toEqual({ o0: 0, o1: 3, o2: 6, o3: 9 });
  });

  it("does not touch model rows: they get Jev's level and its derived legacy value whatever was stored", async () => {
    standardScenario();
    ownerSweetness('bulk1', 3); // a model row that happened to be tagged very sweet
    tagMock.mockResolvedValue(tagResult([tagged('bulk1', { sweetness_level: 3, sweetness: 1 })]));
    await post();
    expect(db.updates).toEqual([]);
    expect(db.upserts[0].rows[0]).toMatchObject({ menu_item_id: 'bulk1', sweetness_level: 3, sweetness: 1, source: 'opus', confirmed: false });
  });

  it("an owner row whose sweetness cannot be read keeps Jev's level", async () => {
    standardScenario();
    db.traitReads = db.traitReads.map((rows) =>
      rows.map((r) => {
        if (r.menu_item_id !== 'owner1') return r;
        const { sweetness: _unread, ...rest } = r;
        return rest;
      }),
    );
    tagMock.mockResolvedValue(tagResult([tagged('owner1', { sweetness_level: 7, sweetness: 2 })]));
    await post();
    expect(db.updates[0].payload.sweetness_level).toBe(7);
  });

  it('the merged row still counts as tagged, and is no longer remaining', async () => {
    standardScenario();
    ownerSweetness('owner1', 3);
    tagMock.mockResolvedValue(tagResult([tagged('owner1', { sweetness_level: 3, sweetness: 1 })]));
    const { body } = await post();
    expect(body.tagged).toBe(1);
    expect(body.remaining).toBe(3); // bulk1, missing1, unconfV1 were not returned by Jev
  });
});

describe('POST /api/owner/suggest/traits/generate — the race guard', () => {
  it('re-reads (confirmed, source, traits_version) AFTER Jev has answered, before writing', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('bulk1')]));
    await post();
    expect(db.log).toEqual(['probe', 'menu_items.select', 'read', 'recheck', 'upsert']);
  });

  it('drops a row the owner confirmed while Jev was tagging (unconfirmed at the first read)', async () => {
    standardScenario();
    db.traitReads = [db.traitReads[0], [traitState('unconfV1', true, 'opus', 1), ...db.traitReads[0].filter((r) => r.menu_item_id !== 'unconfV1')]];
    tagMock.mockResolvedValue(tagResult([tagged('unconfV1'), tagged('missing1')]));
    const { body } = await post();
    expect(db.upserts[0].rows.map((r) => r.menu_item_id)).toEqual(['missing1']);
    expect(body.tagged).toBe(1);
    // …and it is still below the current version, so it still counts as remaining
    expect(body.remaining).toBeGreaterThanOrEqual(1);
  });

  it('drops a row the owner edited (and so confirmed) mid-run', async () => {
    standardScenario();
    db.traitReads = [db.traitReads[0], [traitState('unconfV1', true, 'owner', 1), ...db.traitReads[0].filter((r) => r.menu_item_id !== 'unconfV1')]];
    tagMock.mockResolvedValue(tagResult([tagged('unconfV1')]));
    await post();
    expect(db.upserts).toEqual([]);
    expect(db.updates).toEqual([]); // dropped outright, not even merged: it was not an owner row at the first read
  });

  it('drops a row that did not exist at the first read but was created and confirmed during the run', async () => {
    standardScenario();
    db.traitReads = [db.traitReads[0], [...db.traitReads[0], traitState('missing1', true, 'owner', 1)]];
    tagMock.mockResolvedValue(tagResult([tagged('missing1')]));
    await post();
    expect(db.upserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('does NOT drop a row that was already confirmed at the first read — bulk-confirmed model rows are the point', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('bulk1')]));
    await post();
    expect(db.upserts[0].rows.map((r) => r.menu_item_id)).toEqual(['bulk1']);
  });

  it('an owner row still gets its v2-only merge', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('owner1')]));
    await post();
    expect(db.updates.map((u) => u.value)).toEqual(['owner1']);
    expect(db.upserts).toEqual([]);
  });

  it('decides "owner row" at the FIRST read: it is merged even if the re-read no longer lists it', async () => {
    standardScenario();
    db.traitReads = [db.traitReads[0], db.traitReads[0].filter((r) => r.menu_item_id !== 'owner1')];
    tagMock.mockResolvedValue(tagResult([tagged('owner1')]));
    await post();
    expect(db.upserts).toEqual([]); // never a full upsert that could bring back v1 fields
    expect(db.updates.map((u) => u.value)).toEqual(['owner1']);
  });

  it('a row the owner edited mid-run (confirmed, model-tagged at the first read) is merged, not overwritten', async () => {
    standardScenario();
    db.traitReads = [db.traitReads[0], [traitState('bulk1', true, 'owner', 1), ...db.traitReads[0].filter((r) => r.menu_item_id !== 'bulk1')]];
    tagMock.mockResolvedValue(tagResult([tagged('bulk1')]));
    await post();
    expect(db.upserts).toEqual([]);
    expect(db.updates).toHaveLength(1);
    expect(Object.keys(db.updates[0].payload).sort()).toEqual([...V2_KEYS].sort());
  });

  it('500s, writing nothing, if the re-read fails', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('bulk1')]));
    db.recheckError = { message: 'recheck failed' };
    const { res, body } = await post();
    expect(res.status).toBe(500);
    expect(body.error).toBe('recheck failed');
    expect(db.upserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });
});

describe('POST /api/owner/suggest/traits/generate — the response', () => {
  it('keeps the v1 fields and adds remaining', async () => {
    standardScenario();
    tagMock.mockResolvedValue(
      tagResult([tagged('owner1'), tagged('bulk1'), tagged('missing1'), tagged('unconfV1'), tagged('unconf1')], {
        batches: 5,
        failedBatches: 0,
        needsReview: ['bulk1'],
        usage: { inputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsdMicros: 84_000 },
      }),
    );
    const { res, body } = await post();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      tagged: 5,
      requested: 5,
      batches: 5,
      failedBatches: 0,
      costUsd: 0.084,
      needsReview: ['bulk1'],
      remaining: 0,
    });
  });

  it('remaining counts the targets still below the current version', async () => {
    standardScenario();
    // Jev only got through two of the four rows that need the upgrade (and the unconfirmed current one).
    tagMock.mockResolvedValue(tagResult([tagged('owner1'), tagged('bulk1'), tagged('unconf1')], { batches: 5, failedBatches: 2, firstError: 'jev trait tagging: overall time budget exhausted' }));
    const { body } = await post();
    expect(body.requested).toBe(5);
    expect(body.tagged).toBe(3);
    expect(body.remaining).toBe(2); // missing1 and unconfV1
    expect(body.failedBatches).toBe(2);
    expect(body.error).toBe('jev trait tagging: overall time budget exhausted');
  });

  it('does not count unconfirmed rows that are already current as remaining, even when they were not re-tagged', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('owner1'), tagged('bulk1'), tagged('missing1'), tagged('unconfV1')])); // unconf1 not returned
    const { body } = await post();
    expect(body.requested).toBe(5);
    expect(body.tagged).toBe(4);
    expect(body.remaining).toBe(0);
  });

  it('a row dropped by the race guard is not tagged and is still remaining', async () => {
    standardScenario();
    db.traitReads = [db.traitReads[0], [traitState('missing1', true, 'owner', 1), ...db.traitReads[0]]];
    tagMock.mockResolvedValue(tagResult([tagged('owner1'), tagged('bulk1'), tagged('missing1'), tagged('unconfV1'), tagged('unconf1')]));
    const { body } = await post();
    expect(body.tagged).toBe(4);
    expect(body.remaining).toBe(1);
  });

  it('remaining is 0 once every row is current, and requested shrinks to the unconfirmed ones', async () => {
    db.menuRows = [menuRow('a', 'A'), menuRow('b', 'B')];
    db.traitReads = [[traitState('a', true, 'opus', 2), traitState('b', false, 'opus', 2)]];
    tagMock.mockResolvedValue(tagResult([tagged('b')]));
    const { body } = await post();
    expect(body).toMatchObject({ requested: 1, tagged: 1, remaining: 0 });
    expect(sentIds()).toEqual(['b']);
  });

  it('omits error when nothing failed, and carries the first error when something did', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('bulk1')]));
    expect((await post()).body).not.toHaveProperty('error');

    db.reads = 0;
    tagMock.mockResolvedValue(tagResult([tagged('bulk1')], { failedBatches: 1, firstError: '429 rate limited' }));
    expect((await post()).body.error).toBe('429 rate limited');
  });

  it('costUsd is the tagger\'s micro-dollars in dollars', async () => {
    standardScenario();
    tagMock.mockResolvedValue(tagResult([tagged('bulk1')], { usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsdMicros: 1234 } }));
    expect((await post()).body.costUsd).toBeCloseTo(0.001234, 9);
  });
});

describe('POST /api/owner/suggest/traits/generate — read failures', () => {
  it('500s with the message when the menu cannot be read', async () => {
    db.menuError = { message: 'menu down' };
    const { res, body } = await post();
    expect(res.status).toBe(500);
    expect(body.error).toBe('menu down');
    expect(tagMock).not.toHaveBeenCalled();
  });

  it('500s with the message when the traits cannot be read', async () => {
    db.menuRows = [menuRow('a', 'A')];
    db.firstReadError = { message: 'traits down' };
    const { res, body } = await post();
    expect(res.status).toBe(500);
    expect(body.error).toBe('traits down');
    expect(tagMock).not.toHaveBeenCalled();
  });
});
