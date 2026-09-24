// Phase 7 · SUG-6 — pure cost-cap helpers (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.6).
//
// The actual DB-backed spend check (sum today's cost_usd_micros, compare to
// dailyBudgetUsdMicros() from lib/suggest/models.ts) is a server query and
// lands with the /api/suggest route (SUG-4/SUG-6), not here — this file only
// holds the maths that doesn't need Supabase, so it can be unit tested
// without a database.

/**
 * ISO timestamp for the start of "today" in IST (Asia/Kolkata, UTC+5:30, no
 * DST) — the spend cap resets on the IST business day, not UTC midnight.
 * Built from Intl date parts (not manual offset arithmetic) so it stays
 * correct regardless of the server's own timezone.
 */
export function istDayStartIso(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const y = get('year');
  const m = get('month');
  const d = get('day');
  // IST has a fixed +05:30 offset, so this literal is exact (no DST table needed).
  return new Date(`${y}-${m}-${d}T00:00:00+05:30`).toISOString();
}

/** SUG-6: at or above the cap, the engine uses the fallback (never calls the LLM). */
export function isOverBudget(spentMicros: number, capMicros: number): boolean {
  return spentMicros >= capMicros;
}
