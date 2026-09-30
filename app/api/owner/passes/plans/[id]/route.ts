import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { coffeePassDisabled, isMissingPassSchema, PASS_MIGRATION_HINT } from '@/lib/passes/api';
import { validatePlanInput } from '@/lib/passes/rules';
import { PLAN_COLUMNS, toCoffeePassPlan } from '@/lib/passes/server';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/owner/passes/plans/[id] — owner only. Edits a plan; send only the
// fields that change. Responds { plan }. 404 for an unknown plan.
//
// Edits never touch a pass already sold: a pass holds snapshots of its plan
// (name, cups, the cup value and drink it was bought for, price, daily cap), so
// changing the cups or deactivating a plan affects what is sold FROM NOW ON only.
// Deactivating (is_active: false) is how a plan is retired: there is no delete.
// A plan has no price or cup value any more (CP-D24): sending `price_inr` or
// `drink_value_inr` is a 400.
//
// validatePlanInput checks a cross-field rule (cups paid for <= cups in the pass,
// daily cap <= cups in the pass) only when BOTH sides are in the request, so an
// edit that changes just one of a pair is checked here against the stored row.
// Otherwise "drinks_total: 3" on a plan that says drinks_paid 5 would reach the
// database and come back as an opaque check-constraint 500.
//
// getOwnerUser() ONLY (rule D6-6).
export async function PATCH(request: Request, { params }: RouteParams) {
  const off = coffeePassDisabled();
  if (off) return off;

  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = validatePlanInput(body, { partial: true });
  if (!parsed.ok) return errorResponse(400, parsed.error);
  const patch = parsed.value;

  const admin = createAdminSupabaseClient();
  const { data: stored, error: readError } = await admin
    .from('coffee_pass_plans')
    .select(PLAN_COLUMNS)
    .eq('id', params.id)
    .maybeSingle();
  if (readError) return writeFailure(readError, 'Could not read the plan.');
  if (!stored) return notFound();

  const merged = { ...toCoffeePassPlan(stored as unknown as Record<string, unknown>), ...patch };
  if (merged.drinks_paid > merged.drinks_total) {
    return errorResponse(400, 'Cups paid for cannot be more than the cups in the pass.');
  }
  if (merged.max_per_day !== null && merged.max_per_day > merged.drinks_total) {
    return errorResponse(400, 'Daily limit cannot be more than the cups in the pass.');
  }

  const { data, error } = await admin
    .from('coffee_pass_plans')
    .update(patch)
    .eq('id', params.id)
    .select(PLAN_COLUMNS)
    .maybeSingle();
  if (error) return writeFailure(error, 'Could not save the plan.');
  if (!data) return notFound(); // deleted between the read and the write
  return NextResponse.json({ plan: toCoffeePassPlan(data as unknown as Record<string, unknown>) });
}

function writeFailure(error: { code?: string; message?: string }, message: string) {
  if (error.code === '23505') return errorResponse(409, 'A plan with that name already exists.');
  console.error('PATCH /api/owner/passes/plans/[id]: failed', error);
  return errorResponse(500, isMissingPassSchema(error) ? `${message.replace(/\.$/, '')} — ${PASS_MIGRATION_HINT}` : message);
}
