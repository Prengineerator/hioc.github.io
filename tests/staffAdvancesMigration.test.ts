import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// supabase/2026-11-staff-advances.sql holds owner-only salary data. The unit
// tests mock Supabase and cannot see the schema, so pin the lock-down here.

const sql = readFileSync(path.resolve(__dirname, '../supabase/2026-11-staff-advances.sql'), 'utf8');
// Statements only: the comment block and the Verify section mention these words.
const code = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('staff advances migration', () => {
  it('keeps RLS on, with no policy and no grant, and revokes anon/authenticated', () => {
    expect(code).toMatch(/alter table staff_advances enable row level security;/);
    expect(code).toMatch(/revoke all on staff_advances from anon, authenticated;/);
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/\bgrant\b/i);
  });

  it('adds payroll_run_lines.advance_inr defaulting to 0 and never negative', () => {
    expect(code).toMatch(/alter table payroll_run_lines\s+add column if not exists advance_inr/i);
    expect(code).toMatch(/default 0 check \(advance_inr >= 0\)/);
  });

  it('is additive only', () => {
    expect(code).not.toMatch(/\bdrop\s/i);
  });
});
