import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.1) — supabase/2026-10-coffey-traits-v2.sql
// and the code that writes to it must say the same thing. The validators mirror
// the migration's CHECKs ("change both together or neither"), and nothing in a
// mocked-Supabase suite would notice if they drifted — the SQL is just a file
// here. So this reads the file and pins each list and bound to the code's own
// constants: when the contract changes (the mood list already has, once), a
// red test says which side was forgotten.
//
// (The migration's behaviour — that it applies, re-applies, backfills and
// enforces — was checked against a throwaway local Postgres, not here.)

import { MAX_TEXTURES, SWEETNESS_LEVEL_MAX, TRAIT_SCORE_MAX, TRAIT_V2_FIELDS, V2_ONLY_MOODS } from '@/lib/suggest/traitsValidate';
import { TEXTURES } from '@/lib/suggest/traitVocabulary';
import { ADDON_ROLES, CURRENT_TRAITS_VERSION, FLAVOUR_FAMILIES, MOODS, PAIRING_EVENTS, SWEETNESS_SCALE } from '@/lib/suggest/types';

const ROOT = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'supabase/2026-10-coffey-traits-v2.sql'), 'utf8');
// Comments would otherwise match (the header quotes some of these statements).
const code = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

/** The statement that adds the named constraint, up to its semicolon. */
function constraintStatement(name: string): string {
  const match = new RegExp(`add constraint ${name}\\b([\\s\\S]*?);`, 'i').exec(code);
  if (!match) throw new Error(`no "add constraint ${name}" in the migration`);
  return match[1];
}

const quoted = (text: string): string[] => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

describe('supabase/2026-10-coffey-traits-v2.sql vs the code', () => {
  it('the moods check lists exactly MOODS, in order', () => {
    expect(quoted(constraintStatement('menu_item_traits_moods_check'))).toEqual([...MOODS]);
  });

  it('the moods the migration ADDS are exactly V2_ONLY_MOODS: the v1 check\'s list plus those is MOODS', () => {
    const v1 = fs.readFileSync(path.join(ROOT, 'supabase/2026-09-suggestion-engine.sql'), 'utf8');
    const v1Moods = quoted(/moods\s+text\[\][^;]*?<@\s*array\[([^\]]*)\]/i.exec(v1)?.[1] ?? '');
    expect(v1Moods.length).toBeGreaterThan(0);
    expect(new Set([...v1Moods, ...V2_ONLY_MOODS])).toEqual(new Set(MOODS));
    expect(v1Moods.filter((m) => (V2_ONLY_MOODS as readonly string[]).includes(m))).toEqual([]);
  });

  it('the textures check lists exactly TEXTURES, and caps them at MAX_TEXTURES', () => {
    const statement = constraintStatement('menu_item_traits_textures_check');
    expect(quoted(statement)).toEqual([...TEXTURES]);
    expect(statement).toMatch(new RegExp(`cardinality\\(textures\\)\\s*<=\\s*${MAX_TEXTURES}\\b`));
  });

  it('sweetness_level is null or 0–SWEETNESS_LEVEL_MAX', () => {
    expect(constraintStatement('menu_item_traits_sweetness_level_check')).toMatch(
      new RegExp(`sweetness_level is null or sweetness_level between 0 and ${SWEETNESS_LEVEL_MAX}\\b`),
    );
    expect(SWEETNESS_LEVEL_MAX).toBe(SWEETNESS_SCALE.max);
  });

  it.each(['intensity', 'refreshment', 'indulgence', 'novelty'])('%s is null or 0–TRAIT_SCORE_MAX', (column) => {
    expect(constraintStatement(`menu_item_traits_${column}_check`)).toMatch(
      new RegExp(`${column} is null or ${column} between 0 and ${TRAIT_SCORE_MAX}\\b`),
    );
  });

  it('mood_fit must be a JSON object, and traits_version at least 1', () => {
    expect(constraintStatement('menu_item_traits_mood_fit_check')).toMatch(/jsonb_typeof\(mood_fit\)\s*=\s*'object'/);
    expect(constraintStatement('menu_item_traits_traits_version_check')).toMatch(/traits_version\s*>=\s*1\b/);
  });

  it('adds every v2 column plus traits_version, each with "if not exists"', () => {
    const added = [...code.matchAll(/add column if not exists (\w+)/gi)].map((m) => m[1]);
    expect(added.sort()).toEqual([...TRAIT_V2_FIELDS, 'traits_version'].sort());
    expect(code.match(/add column(?! if not exists)/gi)).toBeNull();
  });

  it('gives the columns the documented types, defaults and nullability', () => {
    expect(code).toMatch(/sweetness_level\s+smallint,/);
    for (const c of ['intensity', 'refreshment', 'indulgence', 'novelty']) expect(code).toMatch(new RegExp(`${c}\\s+smallint,`));
    expect(code).toMatch(/textures\s+text\[\] not null default '\{\}'/);
    expect(code).toMatch(/mood_fit\s+jsonb\s+not null default '\{\}'::jsonb/);
    expect(code).toMatch(/traits_version\s+smallint not null default 1\b/);
  });

  it('is re-runnable: every constraint it adds is dropped by the same name first', () => {
    const added = [...code.matchAll(/add constraint (\w+)/gi)].map((m) => m[1]);
    expect(added.length).toBe(9); // eight v2 columns' checks, plus the widened moods check
    for (const name of added) expect(code).toMatch(new RegExp(`drop constraint if exists ${name};`, 'i'));
  });

  it('widens the moods check by DEFINITION, not by name', () => {
    const doBlock = /do \$\$([\s\S]*?)\$\$;/i.exec(code)?.[1] ?? '';
    expect(doBlock).toMatch(/pg_get_constraintdef\(oid\) ilike '%moods%'/);
    expect(doBlock).toMatch(/contype = 'c'/);
    expect(doBlock).toMatch(/drop constraint %I/);
    // …and it runs before the named constraint is added.
    expect(code.indexOf('do $$')).toBeLessThan(code.indexOf('add constraint menu_item_traits_moods_check'));
  });

  it('backfills sweetness_level from the legacy column exactly as SWEETNESS_SCALE.legacyToLevel says', () => {
    const update = /update menu_item_traits\s+set sweetness_level = case sweetness ([\s\S]*?) end\s+where sweetness_level is null;/i.exec(code);
    expect(update, 'the backfill statement').not.toBeNull();
    const cases = [...(update?.[1] ?? '').matchAll(/when (\d+) then (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const elseValue = Number(/else (\d+)/.exec(update?.[1] ?? '')?.[1]);
    const levels = [0, 1, 2, 3].map((legacy) => cases.find(([w]) => w === legacy)?.[1] ?? elseValue);
    expect(levels).toEqual([...SWEETNESS_SCALE.legacyToLevel]);
  });

  it('leaves traits_version alone, so backfilled rows stay Regenerate targets', () => {
    const update = /update menu_item_traits[\s\S]*?;/i.exec(code)?.[0] ?? '';
    expect(update).not.toMatch(/traits_version/);
  });

  it('touches only menu_item_traits, and never drops data', () => {
    const tables = [...code.matchAll(/alter table (\w+)/gi)].map((m) => m[1].toLowerCase());
    expect(tables.length).toBeGreaterThan(0);
    expect(new Set(tables)).toEqual(new Set(['menu_item_traits']));
    expect(code).not.toMatch(/\b(drop table|drop column|truncate|delete from)\b/i);
  });
});

describe('scripts/verify-db.mjs vs the migration', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/verify-db.mjs'), 'utf8');

  it('probes exactly the columns the migration adds', () => {
    const listed = /const TRAITS_V2_COLUMNS = \[([^\]]*)\]/.exec(script)?.[1] ?? '';
    expect(quoted(listed).sort()).toEqual([...TRAIT_V2_FIELDS, 'traits_version'].sort());
  });

  it('knows the current trait version', () => {
    const version = /const CURRENT_TRAITS_VERSION = (\d+);/.exec(script)?.[1];
    expect(Number(version)).toBe(CURRENT_TRAITS_VERSION);
  });

  it('the Coffey probes only ever GET — nothing is written, planted or deleted', () => {
    const start = script.indexOf('async function checkCoffeyTraitsV2()');
    const end = script.indexOf('async function main()');
    const probes = script.slice(start, end);
    expect(probes.length).toBeGreaterThan(200);
    expect(probes).not.toMatch(/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/);
    expect(probes).not.toMatch(/doomedInsert|prefer:|body:/);
  });

  it('runs the Coffey probes from main()', () => {
    expect(script).toMatch(/await checkCoffeyTraitsV2\(\);/);
  });
});

// Coffey add-ons & pairings (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2.3, §4.3) —
// supabase/2026-10-coffey-addons-pairings.sql. The same contract as the traits
// v2 migration above, for the two tables it creates: the lists and bounds must
// match lib/suggest/types.ts and traitVocabulary.ts, and verify-db must probe
// every column it creates.
const addonsSql = fs.readFileSync(path.join(ROOT, 'supabase/2026-10-coffey-addons-pairings.sql'), 'utf8');
const addonsCode = addonsSql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

/** The statement that adds the named constraint in the add-ons migration, up to its semicolon. */
function addonsConstraint(name: string): string {
  const match = new RegExp(`add constraint ${name}\\b([\\s\\S]*?);`, 'i').exec(addonsCode);
  if (!match) throw new Error(`no "add constraint ${name}" in the add-ons migration`);
  return match[1];
}

/** The column names of `create table if not exists <table> (...)` in the add-ons migration. */
function createdColumns(table: string): string[] {
  const body = new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`, 'i').exec(addonsCode)?.[1] ?? '';
  return body
    .split('\n')
    .map((line) => /^\s*(\w+)\s/.exec(line)?.[1])
    .filter((column): column is string => Boolean(column));
}

describe('supabase/2026-10-coffey-addons-pairings.sql vs the code', () => {
  it('the add-on role check lists exactly ADDON_ROLES, in order', () => {
    expect(quoted(addonsConstraint('addon_option_traits_role_check'))).toEqual([...ADDON_ROLES]);
  });

  it('the flavour families check lists exactly FLAVOUR_FAMILIES, and caps them at two', () => {
    const statement = addonsConstraint('addon_option_traits_flavour_families_check');
    expect(quoted(statement)).toEqual([...FLAVOUR_FAMILIES]);
    expect(statement).toMatch(/cardinality\(flavour_families\)\s*<=\s*2\b/);
  });

  it('the textures check lists exactly TEXTURES, and caps them at two', () => {
    const statement = addonsConstraint('addon_option_traits_textures_check');
    expect(quoted(statement)).toEqual([...TEXTURES]);
    expect(statement).toMatch(/cardinality\(textures\)\s*<=\s*2\b/);
  });

  it.each([
    ['sweetness_delta', 0, 5],
    ['intensity_delta', 0, 2],
    ['indulgence_delta', 0, 2],
  ])('%s is between %i and %i', (column, min, max) => {
    expect(addonsConstraint(`addon_option_traits_${column}_check`)).toMatch(new RegExp(`${column} between ${min} and ${max}\\b`));
  });

  it('the event check lists exactly PAIRING_EVENTS', () => {
    expect(quoted(addonsConstraint('pairing_events_event_check'))).toEqual([...PAIRING_EVENTS]);
  });

  it('is re-runnable: every constraint it adds is dropped by the same name first', () => {
    const added = [...addonsCode.matchAll(/add constraint (\w+)/gi)].map((m) => m[1]);
    expect(added.length).toBe(7); // six on addon_option_traits, one on pairing_events
    for (const name of added) expect(addonsCode).toMatch(new RegExp(`drop constraint if exists ${name};`, 'i'));
  });

  it('creates both tables and the event index, each with "if not exists"', () => {
    expect(addonsCode).toMatch(/create table if not exists addon_option_traits \(/i);
    expect(addonsCode).toMatch(/create table if not exists pairing_events \(/i);
    expect(addonsCode).toMatch(/create index if not exists idx_pairing_events_created_event on pairing_events \(created_at, event\);/i);
    expect(addonsCode).not.toMatch(/create table (?!if not exists)/i);
  });

  it('creates exactly the columns the spec names, in the spec order', () => {
    expect(createdColumns('addon_option_traits')).toEqual([
      'option_id',
      'role',
      'flavour_families',
      'sweetness_delta',
      'intensity_delta',
      'indulgence_delta',
      'textures',
      'updated_at',
    ]);
    expect(createdColumns('pairing_events')).toEqual([
      'id',
      'anon_id',
      'user_id',
      'event',
      'menu_item_id',
      'anchor_item_id',
      'order_id',
      'value_inr',
      'created_at',
    ]);
  });

  it('gives the columns the documented types, defaults, keys and nullability', () => {
    expect(addonsCode).toMatch(/option_id\s+uuid primary key references addon_options\(id\) on delete cascade,/);
    expect(addonsCode).toMatch(/role\s+text not null,/);
    expect(addonsCode).toMatch(/flavour_families\s+text\[\] not null default '\{\}',/);
    for (const c of ['sweetness_delta', 'intensity_delta', 'indulgence_delta']) {
      expect(addonsCode).toMatch(new RegExp(`${c}\\s+smallint not null default 0,`));
    }
    expect(addonsCode).toMatch(/textures\s+text\[\] not null default '\{\}',/);
    expect(addonsCode).toMatch(/updated_at\s+timestamptz not null default now\(\)/);
    expect(addonsCode).toMatch(/id\s+uuid primary key default gen_random_uuid\(\),/);
    expect(addonsCode).toMatch(/event\s+text not null,/);
    expect(addonsCode).toMatch(/user_id\s+uuid references auth\.users\(id\) on delete set null,/);
    expect(addonsCode).toMatch(/menu_item_id\s+uuid references menu_items\(id\) on delete set null,/);
    expect(addonsCode).toMatch(/anchor_item_id\s+uuid references menu_items\(id\) on delete set null,/);
    expect(addonsCode).toMatch(/order_id\s+uuid references orders\(id\) on delete set null,/);
    expect(addonsCode).toMatch(/value_inr\s+integer,/);
    expect(addonsCode).toMatch(/created_at\s+timestamptz not null default now\(\)/);
  });

  it('enables RLS on both tables and adds no policy (service role only)', () => {
    expect(addonsCode).toMatch(/alter table addon_option_traits enable row level security;/);
    expect(addonsCode).toMatch(/alter table pairing_events enable row level security;/);
    expect(addonsCode).not.toMatch(/create policy/i);
  });

  it('reloads the PostgREST schema cache, and touches only its two tables, never dropping data', () => {
    expect(addonsCode).toMatch(/notify pgrst, 'reload schema';/);
    const tables = [...addonsCode.matchAll(/alter table (\w+)/gi)].map((m) => m[1].toLowerCase());
    expect(new Set(tables)).toEqual(new Set(['addon_option_traits', 'pairing_events']));
    expect(addonsCode).not.toMatch(/\b(drop table|drop column|truncate|delete from)\b/i);
  });
});

describe('scripts/verify-db.mjs vs the add-ons migration', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/verify-db.mjs'), 'utf8');

  it('probes every column of each table the migration creates, and no others', () => {
    const block = /const ADDON_PAIRING_TABLES = \[([\s\S]*?)\n\];/.exec(script)?.[1] ?? '';
    const probed = [...block.matchAll(/table: '(\w+)',\s*columns: \[([^\]]*)\]/g)].map((m) => ({ table: m[1], columns: quoted(m[2]) }));
    expect(probed.map((p) => p.table)).toEqual(['addon_option_traits', 'pairing_events']);
    for (const { table, columns } of probed) {
      expect([...columns].sort()).toEqual(createdColumns(table).sort());
    }
  });

  it('runs the add-ons probes from main()', () => {
    expect(script).toMatch(/await checkCoffeeAddonsPairings\(\);/);
  });

  it('the add-ons probes only ever GET, so nothing is written, planted or deleted', () => {
    const start = script.indexOf('async function checkCoffeeAddonsPairings()');
    expect(start).toBeGreaterThan(-1);
    const probes = script.slice(start, script.indexOf('async function main()'));
    expect(probes.length).toBeGreaterThan(200);
    expect(probes).not.toMatch(/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/);
    expect(probes).not.toMatch(/doomedInsert|prefer:|body:/);
  });
});
