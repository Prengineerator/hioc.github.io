// Phase 7 · SUG-6 — the DB-backed daily spend cap (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5.6). Pure maths (istDayStartIso/isOverBudget) already lives in
// lib/suggest/budget.ts; this file is the one Supabase read that sums today's
// actual spend — a DB-backed check, not in-memory, so it holds across
// serverless instances (§5.6).
//
// 'server-only' — service-role read of suggestion_sessions.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { istDayStartIso } from './budget';

/** Sum of `cost_usd_micros` on every suggestion_sessions row since the start
 * of the current IST day. Fails OPEN to 0 when the table can't be read (e.g.
 * the migration isn't applied yet, or a transient error) — the daily cap
 * exists to bound spend, not to be a second reason an unrelated outage takes
 * the whole feature down; a missing/erroring table just means "nothing spent
 * yet" from this check's point of view, and llmEnabled()/the API key gate
 * still governs whether the LLM path is reachable at all. */
export async function todaySpendMicros(now: Date = new Date()): Promise<number> {
  try {
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin
      .from('suggestion_sessions')
      .select('cost_usd_micros')
      .gte('created_at', istDayStartIso(now));
    if (error) {
      console.error('todaySpendMicros: read failed, treating spend as 0', error);
      return 0;
    }
    return (data ?? []).reduce((sum, row) => sum + (Number(row.cost_usd_micros) || 0), 0);
  } catch (err) {
    console.error('todaySpendMicros threw, treating spend as 0', err);
    return 0;
  }
}
