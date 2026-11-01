import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getEnrolledDevice } from '@/lib/api/device';
import { getStaffSurface } from '@/lib/staff/surface';
import { requireInventoryActor } from '@/lib/inventory/api';
import { patchStockRequest, type RequestAction } from '@/lib/inventory/requestActions';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// The steps the staff Stock screen offers. Counting a return in at the
// warehouse and settling a difference are the owner's, on the owner's
// Warehouse page (PATCH /api/owner/warehouse/requests/[id]).
const STAFF_ACTIONS: readonly RequestAction[] = ['assign', 'pick', 'receive', 'cancel'];

// PATCH /api/inventory/requests/[id] — moves a stock request along
// (docs/INVENTORY-SPEC.md, INV-3/4; docs/WAREHOUSE-SPEC.md). Body is one of:
//
//   { action: 'assign',  assigneeId }                 manager/owner
//   { action: 'assign',  deliverer: { name, phone? } } manager/owner, a warehouse
//                                                      transfer carried by someone
//                                                      without a login
//   { action: 'pick',    lines: [{ itemId, qty }] }   the assignee (or a manager);
//                                                      from the warehouse it is the
//                                                      dispatch: the owner or a manager
//   { action: 'receive', lines: [{ itemId, qty, expiryDate }] }
//                                                      at the POS, not the picker
//                                                      (nor the deliverer)
//   { action: 'cancel',  reason? }                     requester before assignment,
//                                                      or a manager/owner, before
//                                                      a warehouse transfer has left
//
// The logic is lib/inventory/requestActions.ts, shared with the owner's route.
export async function PATCH(request: Request, { params }: RouteParams) {
  const gate = await requireInventoryActor();
  if ('response' in gate) return gate.response;

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  if (!STAFF_ACTIONS.includes(body.action as RequestAction)) {
    return errorResponse(400, "action must be 'assign', 'pick', 'receive' or 'cancel'");
  }

  // Only a count-in cares where it is happening (the POS, and which device).
  const receiving = body.action === 'receive';
  const surface = receiving ? await getStaffSurface() : 'web';
  const device = receiving ? await getEnrolledDevice() : null;

  return patchStockRequest(
    createAdminSupabaseClient(),
    {
      userId: gate.actor.user.id,
      role: gate.actor.role,
      isManager: gate.actor.isManager,
      surface,
      deviceId: device?.id ?? null,
    },
    params.id,
    body,
    STAFF_ACTIONS,
  );
}
