import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { WIZARD_STEPS_TABLE } from '@/lib/suggest/wizardSteps';
import { isMissingWizardStepsTable } from '@/lib/suggest/wizardStepsStore';
import { isMissingTrafficTable } from '@/lib/traffic/record';
import { TRAFFIC_RETENTION_DAYS } from '@/lib/traffic/types';

export const dynamic = 'force-dynamic';

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;
type PgError = { code?: string; message?: string };

/** Delete a table's rows older than `cutoff`. A table that is not there yet is a no-op, not a failure. */
async function purgeOlderThan(
  admin: AdminClient,
  table: string,
  cutoff: string,
  isMissing: (error: PgError) => boolean,
): Promise<{ deleted: number; missing: boolean; failed: boolean }> {
  const { error, count } = await admin.from(table).delete({ count: 'exact' }).lt('created_at', cutoff);
  if (!error) return { deleted: count ?? 0, missing: false, failed: false };
  if (isMissing(error)) return { deleted: 0, missing: true, failed: false };
  console.error(`purge-traffic: deleting from ${table} failed`, error);
  return { deleted: 0, missing: false, failed: true };
}

// Weekly (vercel.json). Deletes usage data older than 13 months — the retention
// the privacy policy states for it: traffic_events rows (page views and the
// orders they led to) and suggestion_wizard_steps rows (which steps of the
// Coffey wizard a browser reached, docs/COFFEY-SPEC.md §10.7). A whole row
// goes: unlike attendance, nothing in either is a record anyone needs to keep.
//
// Idempotent, and a no-op for a table whose SQL file
// (supabase/2026-11-traffic-tracking.sql, supabase/2026-11-coffey-wizard-steps.sql)
// has not been applied. The two tables are purged independently, so a failure
// on one never leaves the other unpurged. Fails CLOSED without CRON_SECRET,
// same posture as the other jobs.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const cutoff = new Date(Date.now() - TRAFFIC_RETENTION_DAYS * 86_400_000).toISOString();
  const admin = createAdminSupabaseClient();
  const traffic = await purgeOlderThan(admin, 'traffic_events', cutoff, isMissingTrafficTable);
  const wizardSteps = await purgeOlderThan(admin, WIZARD_STEPS_TABLE, cutoff, isMissingWizardStepsTable);

  if (traffic.failed || wizardSteps.failed) {
    return errorResponse(500, 'Could not purge old usage rows');
  }
  const notes = [
    ...(traffic.missing ? ['traffic_events not created yet'] : []),
    ...(wizardSteps.missing ? [`${WIZARD_STEPS_TABLE} not created yet`] : []),
  ];
  return NextResponse.json({
    ok: true,
    deleted: traffic.deleted,
    wizardStepsDeleted: wizardSteps.deleted,
    cutoff,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  });
}
