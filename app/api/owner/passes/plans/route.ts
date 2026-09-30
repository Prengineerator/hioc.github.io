import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { coffeePassDisabled, isMissingPassSchema, PASS_MIGRATION_HINT } from '@/lib/passes/api';
import { validatePlanInput } from '@/lib/passes/rules';
import { PLAN_COLUMNS, toCoffeePassPlan } from '@/lib/passes/server';

export const dynamic = 'force-dynamic';

// POST /api/owner/passes/plans — owner only. Creates a plan. Responds 201 { plan }.
// Body: { name, drinks_total, drinks_paid, validity_days } plus optional
// { description, max_per_day, gst_exempt, is_active, sort_order }.
//
// A plan is only the recipe (CP-D22..D24): it has NO price and NO cup value. The
// price is drinks_paid x the menu price of the drink and size the customer picks
// when buying, and the cup value is that same menu price, so `price_inr` and
// `drink_value_inr` in the body are refused (400) rather than ignored.
//
// The rules are lib/passes/rules.ts validatePlanInput, shared with the edit form:
// a new plan is INACTIVE unless the owner says otherwise (nothing is sold until it
// is switched on), and there is no daily cap. A name already in use (case-insensitive: the
// unique index is on lower(trim(name))) is a 409. There is no delete: a plan that
// has been sold is deactivated, never removed (the order line references it).
//
// getOwnerUser() ONLY (rule D6-6).
export async function POST(request: Request) {
  const off = coffeePassDisabled();
  if (off) return off;

  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = validatePlanInput(body, { partial: false });
  if (!parsed.ok) return errorResponse(400, parsed.error);

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('coffee_pass_plans').insert(parsed.value).select(PLAN_COLUMNS).single();
  if (error || !data) {
    if (error?.code === '23505') return errorResponse(409, 'A plan with that name already exists.');
    console.error('POST /api/owner/passes/plans: insert failed', error);
    return errorResponse(
      500,
      isMissingPassSchema(error) ? `Could not save the plan — ${PASS_MIGRATION_HINT}` : 'Could not save the plan.',
    );
  }
  return NextResponse.json({ plan: toCoffeePassPlan(data as unknown as Record<string, unknown>) }, { status: 201 });
}
