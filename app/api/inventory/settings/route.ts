import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { loadAutoHide } from '@/lib/inventory/server';

export const dynamic = 'force-dynamic';

// PATCH /api/inventory/settings — manager/owner. Body: { autoHide: boolean }.
// Auto-hide takes a menu item off the menu when no size of it can be made
// from the stock on hand, and puts it back when stock returns. Switching it
// off puts back everything it hid, at once (inventory_refresh_availability).
export async function PATCH(request: Request) {
  const gate = await requireInventoryActor({ managerOnly: true });
  if ('response' in gate) return gate.response;

  const body = await parseJsonBody(request);
  if (!body || typeof body.autoHide !== 'boolean') return errorResponse(400, 'autoHide must be true or false');

  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from('store_settings')
    .update({ stock_auto_hide: body.autoHide })
    .eq('is_singleton', true);
  if (error) return inventoryWriteFailure(error, 'Saving the setting');

  const { error: refreshError } = await admin.rpc('inventory_refresh_availability');
  if (refreshError) return inventoryWriteFailure(refreshError, 'Updating the menu');

  return NextResponse.json({ autoHide: await loadAutoHide(admin) });
}
