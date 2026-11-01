import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { patchStockRequest, type RequestAction } from '@/lib/inventory/requestActions';
import { requireWarehouseOwner } from '@/lib/inventory/warehouseServer';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// What the Warehouse page offers the owner. Counting stock in at the STORE
// stays at the POS (someone other than the deliverer, on an enrolled device).
const OWNER_ACTIONS: readonly RequestAction[] = ['assign', 'pick', 'cancel', 'receive_return', 'resolve'];

// PATCH /api/owner/warehouse/requests/[id] — owner only (docs/WAREHOUSE-SPEC.md).
//
//   { action: 'assign', assigneeId } | { action: 'assign', deliverer: { name, phone? } }
//   { action: 'pick', lines: [{ itemId, qty }] }          record what the warehouse sent
//   { action: 'cancel', reason }                          before it has left
//   { action: 'receive_return', lines: [{ itemId, qty, expiryDate }] }
//                                                         count a return in at the warehouse
//   { action: 'resolve', lines: [{ itemId, resolution }], note? }
//                                                         settle what arrived different
//
// The logic is lib/inventory/requestActions.ts, shared with the staff route.
// getOwnerUser() ONLY (rule D6-6).
export async function PATCH(request: Request, { params }: RouteParams) {
  const gate = await requireWarehouseOwner();
  if ('response' in gate) return gate.response;
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  return patchStockRequest(
    createAdminSupabaseClient(),
    { userId: gate.owner.id, role: 'owner', isManager: true, surface: 'web', deviceId: null },
    params.id,
    body,
    OWNER_ACTIONS,
  );
}
