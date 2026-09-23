import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getPayslipStatuses, resendPayslip, sendPayslipsForRun } from '@/lib/payroll/payslipEmail';

export const dynamic = 'force-dynamic';

// SA-5 — payslip delivery status + resend. Owner-only (D5-8: only the owner
// sees money, and a payslip carries someone's pay), same as the rest of
// app/api/owner/payroll/**.

// GET ?runId= — per-staffer latest payslip email status for a finalized run.
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const url = new URL(request.url);
  const runId = url.searchParams.get('runId') ?? '';
  if (!runId) return errorResponse(400, 'runId is required');

  const admin = createAdminSupabaseClient();
  const statuses = await getPayslipStatuses(admin, runId);
  return NextResponse.json({ runId, statuses });
}

// POST { runId, userId? } — resend. With userId: force-resend that one
// person's payslip, even if it was already sent. Without: resend to everyone
// on the run who doesn't yet have a successfully sent payslip (the same
// idempotent pass finalize itself runs).
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const runId = typeof body.runId === 'string' ? body.runId : '';
  if (!runId) return errorResponse(400, 'runId is required');
  const userId = typeof body.userId === 'string' && body.userId ? body.userId : null;

  const admin = createAdminSupabaseClient();

  if (userId) {
    const outcome = await resendPayslip(admin, runId, userId);
    return NextResponse.json({ runId, outcome });
  }

  const outcomes = await sendPayslipsForRun(admin, runId);
  return NextResponse.json({ runId, outcomes });
}
