// Coffey wizard step tracking (docs/COFFEY-SPEC.md §10.7): the one write
// (POST /api/suggest/steps) and the one read (Owner → Suggestions) on
// suggestion_wizard_steps. Server-only, service role.
//
// Both degrade quietly until supabase/2026-11-coffey-wizard-steps.sql is
// applied, using the same "that relation isn't there yet" check as the rest of
// the Coffey dashboard (queries.ts): the insert is skipped (logged once per
// server instance, not once per wizard open) and the read answers
// `missing_table`, which the owner page turns into "apply the SQL".
//
// The arithmetic lives in lib/suggest/wizardSteps.ts.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { isMissingSuggestRelation } from './queries';
import {
  WIZARD_STEPS_MIGRATION,
  WIZARD_STEPS_TABLE,
  summariseWizardFunnel,
  wizardStepVisitors,
  type WizardFunnelResult,
  type WizardStepSlice,
} from './wizardSteps';
import type { WizardStep } from './types';

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;
type PgError = { code?: string; message?: string };

/**
 * Strictly "the table itself isn't there" (42P01 from Postgres, PGRST205 from
 * PostgREST), like isMissingTrafficTable. For the retention purge, where any
 * other error has to stay a failure; the dashboard and the insert use the
 * broader isMissingSuggestRelation.
 */
export function isMissingWizardStepsTable(error: PgError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const msg = error.message ?? '';
  return msg.includes(WIZARD_STEPS_TABLE) && /does not exist|could not find the table/i.test(msg);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

let missingTableLogged = false;

/**
 * Insert one step. Never throws and reports nothing back: a customer choosing a
 * coffee must never be held up by analytics, least of all by a table that has
 * not been created yet.
 */
export async function insertWizardStep(
  admin: AdminClient,
  input: { anonId: string; userId: string | null; step: WizardStep },
): Promise<void> {
  try {
    const { error } = await admin
      .from(WIZARD_STEPS_TABLE)
      .insert({ anon_id: input.anonId, user_id: input.userId, step: input.step });
    if (!error) return;
    if (isMissingSuggestRelation(error)) {
      if (!missingTableLogged) {
        missingTableLogged = true;
        console.warn(`suggest steps: ${WIZARD_STEPS_TABLE} is missing — apply ${WIZARD_STEPS_MIGRATION}`);
      }
      return;
    }
    console.error('suggest steps: insert failed (best-effort)', error);
  } catch (err) {
    console.error('suggest steps: insert threw (best-effort)', err);
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// PostgREST answers at most 1000 rows a request, so both reads page.
const PAGE_SIZE = 1000;
/** 20,000 rows. Far past this cafe's wizard traffic; the card says so if it is ever reached. */
const MAX_PAGES = 20;
const ID_CHUNK = 150;

async function readStepRows(
  admin: AdminClient,
  sinceIso: string,
): Promise<{ rows: WizardStepSlice[]; truncated: boolean; error: PgError | null }> {
  const rows: WizardStepSlice[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await admin
      .from(WIZARD_STEPS_TABLE)
      .select('anon_id, step')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) return { rows, truncated: false, error };
    const batch = (data ?? []) as unknown as WizardStepSlice[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, truncated: false, error: null };
  }
  return { rows, truncated: true, error: null };
}

/**
 * The guest ids whose Coffey sessions had a pick added to the cart since
 * `sinceIso`: 'added_to_cart' rows of suggestion_events, through
 * suggestion_sessions.anon_id. Null when either table could not be read, so the
 * card shows "not available" for the last stage instead of a false 0.
 */
async function readCartAnonIds(admin: AdminClient, sinceIso: string): Promise<Set<string> | null> {
  const sessionIds = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await admin
      .from('suggestion_events')
      .select('session_id')
      .eq('event', 'added_to_cart')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) {
      if (!isMissingSuggestRelation(error)) console.error('wizard funnel: suggestion_events failed', error);
      return null;
    }
    const batch = (data ?? []) as unknown as { session_id: string | null }[];
    for (const row of batch) if (row.session_id) sessionIds.add(row.session_id);
    if (batch.length < PAGE_SIZE) break;
  }

  const anonIds = new Set<string>();
  const ids = [...sessionIds];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await admin
      .from('suggestion_sessions')
      .select('id, anon_id')
      .in('id', ids.slice(i, i + ID_CHUNK));
    if (error) {
      if (!isMissingSuggestRelation(error)) console.error('wizard funnel: suggestion_sessions failed', error);
      return null;
    }
    for (const row of (data ?? []) as unknown as { anon_id: string | null }[]) {
      if (row.anon_id) anonIds.add(row.anon_id);
    }
  }
  return anonIds;
}

/**
 * The wizard funnel for the window starting at `windowStart` (an ISO
 * timestamp): opened → chose a feeling → asked for picks, from
 * suggestion_wizard_steps, then → added a pick to the cart, from the events the
 * dashboard already had. Never throws: the owner page renders whatever happens.
 */
export async function getWizardFunnel(windowStart: string): Promise<WizardFunnelResult> {
  try {
    const admin = createAdminSupabaseClient();
    const read = await readStepRows(admin, windowStart);
    if (read.error) {
      if (isMissingSuggestRelation(read.error)) return { status: 'missing_table' };
      console.error(`wizard funnel: ${WIZARD_STEPS_TABLE} failed`, read.error);
      return { status: 'error' };
    }
    // Nobody asked for picks: nobody can have added one, and there is nothing to look up.
    const askedForPicks = wizardStepVisitors(read.rows).picksRequested.size > 0;
    const cartAnonIds = askedForPicks ? await readCartAnonIds(admin, windowStart) : new Set<string>();
    return { status: 'ok', funnel: summariseWizardFunnel(read.rows, cartAnonIds, read.truncated) };
  } catch (err) {
    console.error('wizard funnel threw', err);
    return { status: 'error' };
  }
}
