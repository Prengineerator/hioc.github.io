import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WIZARD_STEPS } from '@/lib/suggest/types';
import { WIZARD_ANON_ID, WIZARD_STEPS_MIGRATION, WIZARD_STEPS_TABLE } from '@/lib/suggest/wizardSteps';

// supabase/2026-11-coffey-wizard-steps.sql pins the step list of
// lib/suggest/types.ts and the guest id's shape of lib/suggest/wizardSteps.ts in
// CHECK constraints. If one side changes without the other, inserts start
// failing silently (they are best-effort), so pin them — and pin the things the
// privacy policy leans on: no column for anything the customer chose, RLS on,
// no policy, and a place in the weekly purge.

const root = path.resolve(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const sql = read(WIZARD_STEPS_MIGRATION);
// Comments describe; only statements count.
const statements = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

function constraintBody(constraint: string): string {
  const at = statements.indexOf(`add constraint ${constraint}`);
  expect(at, `${constraint} is in the migration`).toBeGreaterThan(-1);
  return statements.slice(at, statements.indexOf(';', at));
}

describe('wizard steps migration ↔ the code', () => {
  it('is the file the owner card and the server log name', () => {
    expect(WIZARD_STEPS_MIGRATION).toBe('supabase/2026-11-coffey-wizard-steps.sql');
    expect(statements).toContain(`create table if not exists ${WIZARD_STEPS_TABLE} (`);
  });

  it('accepts exactly WIZARD_STEPS', () => {
    const inList = /in \(([^)]*)\)/.exec(constraintBody('suggestion_wizard_steps_step_check'));
    expect(inList).not.toBeNull();
    expect([...inList![1].matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...WIZARD_STEPS]);
  });

  it('holds the guest id to the same shape the API does', () => {
    const pattern = /anon_id ~ '([^']+)'/.exec(constraintBody('suggestion_wizard_steps_anon_id_check'));
    expect(pattern).not.toBeNull();
    expect(pattern![1]).toBe(WIZARD_ANON_ID.source);
  });

  it('has five columns and none of them can hold what the customer chose or typed', () => {
    const table = /create table if not exists suggestion_wizard_steps \(([\s\S]*?)\n\);/.exec(statements);
    expect(table).not.toBeNull();
    const columns = table![1]
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(columns).toEqual(['id', 'anon_id', 'user_id', 'step', 'created_at']);
    // The only text columns are the two a CHECK pins down.
    expect(statements).not.toMatch(/\b(jsonb|json|inet)\b/i);
    expect(statements).not.toMatch(/\b(ip|ip_address|user_agent|mood|inputs|note)\b\s+(text|inet|jsonb)/i);
  });

  it('keeps RLS on with no policy, and gives the browser roles no privilege', () => {
    expect(statements).toMatch(/alter table suggestion_wizard_steps enable row level security;/);
    expect(statements).not.toMatch(/create policy/i);
    expect(statements).toMatch(/revoke all on suggestion_wizard_steps from anon, authenticated;/);
    expect(statements).not.toMatch(/\bgrant\b/i);
  });

  it('is safe to run again', () => {
    expect(statements).not.toMatch(/create table (?!if not exists)/i);
    expect(statements).not.toMatch(/create (unique )?index (?!if not exists)/i);
    for (const added of statements.matchAll(/add constraint (\w+)/g)) {
      expect(statements, `${added[1]} is dropped before it is added`).toContain(`drop constraint if exists ${added[1]};`);
    }
    expect(statements).not.toMatch(/\b(drop table|truncate|delete from)\b/i);
  });

  it('clears the account reference, and keeps the row, when an account is deleted', () => {
    expect(statements).toMatch(/user_id\s+uuid references auth\.users\(id\) on delete set null/);
  });
});

describe('wizard steps ↔ the scripts around the table', () => {
  const verify = read('scripts/verify-db.mjs');

  it('npm run verify:db probes the table, with every column the code reads and writes', () => {
    expect(verify).toContain("const WIZARD_STEP_COLUMNS = ['id', 'anon_id', 'user_id', 'step', 'created_at'];");
    expect(verify).toContain(`/${WIZARD_STEPS_TABLE}?select=`);
    expect(verify).toContain(`apply ${WIZARD_STEPS_MIGRATION}`);
    expect(verify).toMatch(/await checkCoffeyWizardSteps\(\);/);
  });

  it('the probe only ever GETs, so it can run against production at any time', () => {
    const start = verify.indexOf('async function checkCoffeyWizardSteps()');
    expect(start).toBeGreaterThan(-1);
    const probe = verify.slice(start, verify.indexOf('async function main()'));
    expect(probe.length).toBeGreaterThan(200);
    expect(probe).not.toMatch(/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/);
    expect(probe).not.toMatch(/doomedInsert|prefer:|body:/);
  });

  it('the weekly purge that deletes it is scheduled', () => {
    const vercel = JSON.parse(read('vercel.json')) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.some((c) => c.path === '/api/cron/purge-traffic')).toBe(true);
    expect(read('app/api/cron/purge-traffic/route.ts')).toContain('WIZARD_STEPS_TABLE');
  });
});
