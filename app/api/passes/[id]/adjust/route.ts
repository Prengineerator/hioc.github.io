import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { hasPermission } from '@/lib/permissions';
import { coffeePassDisabled } from '@/lib/passes/api';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { validateAdjustInput } from '@/lib/passes/rules';
import { adjustPass, loadPassSummaryById } from '@/lib/passes/server';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

const NO_PERMISSION = `You don't have permission to change a ${PASS_PROGRAM_NAME}.`;

// POST /api/passes/[id]/adjust — a manager or the owner changes a pass (CP-D16).
// Body: { kind: 'extend', days: 1..60, reason } or { kind: 'credit', drinks: 1..50, reason }.
// Responds { pass } with the pass's balance as it is now.
//
//   extend   moves the expiry out by whole IST days (so it still ends at midnight)
//   credit   gives cups back (a spilt coffee on a fully covered order); at most
//            the plan's cups in one go
//
// Gated by `pass_manage` (default: manager). Every change is audited in
// coffee_pass_adjustments with the actor and the reason, and nobody can TAKE cups
// away except by redemption. The pass is locked and re-checked by the database
// function, not here, so two managers cannot race.
//
// The function's refusals map to: bad_input 400, not_found 404, inactive 409
// (refunded or void), and 'error' 500 (already logged, with the migration hint,
// by lib/passes/server.ts).
//
// PIN-3: gated by getCounterActor(); hasPermission takes the role it already knows.
export async function POST(request: Request, { params }: RouteParams) {
  const off = coffeePassDisabled();
  if (off) return off;

  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  if (!(await hasPermission(actor.user, 'pass_manage', actor.role))) {
    return errorResponse(403, NO_PERMISSION);
  }
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = validateAdjustInput(body);
  if (!parsed.ok) return errorResponse(400, parsed.error);
  const change = parsed.value;

  const admin = createAdminSupabaseClient();
  const code = await adjustPass(admin, {
    passId: params.id,
    kind: change.kind,
    days: change.kind === 'extend' ? change.days : null,
    drinks: change.kind === 'credit' ? change.drinks : null,
    reason: change.reason,
    actorId: actor.user.id,
  });

  switch (code) {
    case 'ok': {
      const pass = await loadPassSummaryById(admin, params.id);
      if (!pass) return errorResponse(500, 'The change was saved, but the pass could not be reloaded — refresh to see it.');
      return NextResponse.json({ pass });
    }
    case 'bad_input':
      return errorResponse(400, 'That change is not allowed for this pass — check the days or cups and the reason.');
    case 'not_found':
      return errorResponse(404, `That ${PASS_PROGRAM_NAME} pass wasn't found.`);
    case 'inactive':
      return errorResponse(409, `This ${PASS_PROGRAM_NAME} isn't active`);
    default:
      return errorResponse(500, 'Could not change the pass — please try again.');
  }
}
