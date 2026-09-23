import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { getStaffDisplayNames } from '@/lib/staff/displayName';

export const dynamic = 'force-dynamic';

// CC-2 — cash-in / cash-out entries (docs/PHASE-5-CASH-COUNTS.md). Manager/
// owner only: bank deposits, petty expenses, owner top-ups. Without these the
// next checkpoint would read a deposit as a shortage and charge it to whoever
// counted next (lib/cash/checkpoints.ts cashFlowsBetween reads this table).

const MIN_REASON_LEN = 5;
const MAX_AMOUNT_INR = 1_000_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function amountProblem(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'amountInr must be a whole number of rupees';
  if (value < 1 || value > MAX_AMOUNT_INR) return `amountInr must be between 1 and ${MAX_AMOUNT_INR}`;
  return null;
}

// POST /api/cash-movements — manager/owner only.
// Body: { direction: 'out' | 'in', amountInr, reason }.
export async function POST(request: Request) {
  const manager = await getManagerUser();
  if (!manager) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const { direction, amountInr, reason } = body;
  if (direction !== 'out' && direction !== 'in') {
    return errorResponse(400, "direction must be 'out' or 'in'");
  }
  const amtProblem = amountProblem(amountInr);
  if (amtProblem) return errorResponse(400, amtProblem);
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LEN) {
    return errorResponse(400, `Give a reason (at least ${MIN_REASON_LEN} characters).`);
  }

  const admin = createAdminSupabaseClient();
  const { data: inserted, error } = await admin
    .from('cash_movements')
    .insert({
      direction,
      amount_inr: amountInr,
      reason: reason.trim(),
      recorded_by: manager.id,
    })
    .select('*')
    .single();
  if (error || !inserted) {
    return errorResponse(
      500,
      'Could not record the movement — is supabase/2026-09-cash-counts.sql applied?',
    );
  }

  return NextResponse.json({ movement: inserted });
}

// GET /api/cash-movements?limit= — manager/owner only. Recent entries, newest
// first, with the recording staffer's name resolved.
export async function GET(request: Request) {
  const manager = await getManagerUser();
  if (!manager) return unauthorized();

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_LIMIT) : DEFAULT_LIMIT;

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('cash_movements')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    return errorResponse(
      500,
      'Could not load movements — is supabase/2026-09-cash-counts.sql applied?',
    );
  }

  const rows = (data ?? []) as {
    id: string;
    direction: 'out' | 'in';
    amount_inr: number;
    reason: string;
    recorded_by: string;
    created_at: string;
  }[];
  const names = await getStaffDisplayNames(
    admin,
    rows.map((r) => r.recorded_by),
  );

  const movements = rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    amountInr: r.amount_inr,
    reason: r.reason,
    recordedBy: r.recorded_by,
    recordedByName: names.get(r.recorded_by) ?? 'Unknown manager',
    createdAt: r.created_at,
  }));

  return NextResponse.json({ movements });
}
