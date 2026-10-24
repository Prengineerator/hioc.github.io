import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { NOTIFICATION_EVENTS } from '@/lib/types';

// Drift guard: `notifications.event` has a CHECK in Postgres and a TypeScript
// union in lib/types.ts — two copies of one list, and the suite mocks Supabase,
// so nothing else would notice them disagreeing. They did disagree: 'feedback'
// was added to the type and the engine (sendFeedbackRequestNotification) but
// never to the CHECK, so every feedback log write was rejected by Postgres and
// only console.errored — no idempotency row, no attempts counter, no delivery
// receipts. supabase/2026-10-notifications-feedback-event.sql is the fix; this
// test is the standing regression for the whole class.
//
// How it works: the constraint is rewritten by drop-and-re-add (never altered
// in place), so the LAST date-prefixed migration that adds it is the live
// definition. We read that file's `check (event in (...))` and require it to
// equal NOTIFICATION_EVENTS as a set, in both directions:
//   * in the type but not the CHECK -> logging that event breaks (the bug above)
//   * in the CHECK but not the type -> a dead value no code can produce
// (Bundles such as apply-phase3.sql repeat old blocks and are not date-prefixed,
// so they are never the "latest".)

const ROOT = path.resolve(__dirname, '..');
const SUPABASE_DIR = path.join(ROOT, 'supabase');

// `--` comments would otherwise match: migration headers quote these statements.
const stripSqlComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

/** The event list in a file's `add constraint notifications_event_check check (event in (...))`, or null. */
function eventCheckList(sql: string): string[] | null {
  const m = /add\s+constraint\s+notifications_event_check\s+check\s*\(\s*event\s+in\s*\(([^)]*)\)\s*\)/i.exec(stripSqlComments(sql));
  if (!m) return null;
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

const sqlFiles = fs.readdirSync(SUPABASE_DIR).filter((f) => f.endsWith('.sql')).sort();
const setters = sqlFiles.filter((f) =>
  /add\s+constraint\s+notifications_event_check\b/i.test(stripSqlComments(fs.readFileSync(path.join(SUPABASE_DIR, f), 'utf8'))),
);
// Date-prefixed = a real, ordered migration (2026-07-..., 2026-10-...).
const datedSetters = setters.filter((f) => /^\d{4}-\d{2}-/.test(f));
const latest = datedSetters[datedSetters.length - 1]; // sorted, so the last is the one applied last

describe('notifications.event CHECK vs NotificationEvent', () => {
  it('finds the migrations that set the constraint, and at least one is date-prefixed', () => {
    expect(setters.length).toBeGreaterThan(0);
    expect(datedSetters.length).toBeGreaterThan(0);
    expect(latest).toBeTruthy();
  });

  it('parses every setter, so an unparseable rewrite cannot slip through as "no change"', () => {
    for (const f of setters) {
      const list = eventCheckList(fs.readFileSync(path.join(SUPABASE_DIR, f), 'utf8'));
      expect(list, `${f} sets notifications_event_check but its "check (event in (...))" list could not be parsed`).not.toBeNull();
      expect(list!.length, `${f} parsed to an empty event list`).toBeGreaterThan(0);
    }
  });

  it('the parser reads the historical 2026-07 rewrite as the five events it allowed (the pre-fix state)', () => {
    const list = eventCheckList(fs.readFileSync(path.join(SUPABASE_DIR, '2026-07-order-email.sql'), 'utf8'));
    expect(new Set(list)).toEqual(new Set(['accepted', 'ready', 'rejected', 'cancelled', 'bill']));
  });

  it('the latest migration allows exactly the events in NOTIFICATION_EVENTS (both directions)', () => {
    const list = eventCheckList(fs.readFileSync(path.join(SUPABASE_DIR, latest), 'utf8')) ?? [];
    const inCheck = new Set(list);
    const inType = new Set<string>(NOTIFICATION_EVENTS);

    const missingFromCheck = [...inType].filter((e) => !inCheck.has(e));
    const deadInCheck = [...inCheck].filter((e) => !inType.has(e));

    expect(
      missingFromCheck,
      `${latest}: NOTIFICATION_EVENTS has event(s) the CHECK rejects — every log write for them fails in Postgres. Add a migration that widens notifications_event_check.`,
    ).toEqual([]);
    expect(
      deadInCheck,
      `${latest}: the CHECK allows event(s) missing from NOTIFICATION_EVENTS in lib/types.ts — nothing can produce them.`,
    ).toEqual([]);
    expect(inCheck).toEqual(inType);
  });

  it('neither list has duplicates', () => {
    const list = eventCheckList(fs.readFileSync(path.join(SUPABASE_DIR, latest), 'utf8')) ?? [];
    expect(new Set(list).size).toBe(list.length);
    expect(new Set(NOTIFICATION_EVENTS).size).toBe(NOTIFICATION_EVENTS.length);
  });

  it("'feedback' — the event that drifted — is in both", () => {
    const list = eventCheckList(fs.readFileSync(path.join(SUPABASE_DIR, latest), 'utf8')) ?? [];
    expect(NOTIFICATION_EVENTS).toContain('feedback');
    expect(list).toContain('feedback');
  });
});
