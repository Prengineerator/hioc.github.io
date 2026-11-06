import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getEnrolledDevice } from '@/lib/api/device';
import { istBusinessDate } from '@/lib/cash/date';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import {
  parseReceiveLines,
  parseVendorHeader,
  RECEIVE_POS_ONLY_MESSAGE,
  type ReceivableItem,
} from '@/lib/inventory/rules';

export const dynamic = 'force-dynamic';

/** "The function isn't there yet": PostgREST's schema-cache miss, or Postgres's own. */
function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  return /could not find the function/i.test(error.message ?? '');
}

// POST /api/inventory/receipts — manager/owner, at the POS (INV-4b, INV-D14).
// Stock from a vendor: a delivery with no stock request or warehouse transfer
// behind it, counted in the same way (quantity and expiry date per item), and
// recorded against the vendor it came from. Body:
//   { vendor, billRef?, note?, lines: [{ itemId, qty, expiryDate }] }
// Answers { ok, batches, vendorRecorded }. vendorRecorded is false only while
// supabase/2026-11-vendor-stock-in.sql is not applied: the stock still goes in
// (through inventory_receive), without the vendor's name.
export async function POST(request: Request) {
  const gate = await requireInventoryActor({ managerOnly: true });
  if ('response' in gate) return gate.response;

  const device = await getEnrolledDevice();
  if (!device) return errorResponse(403, RECEIVE_POS_ONLY_MESSAGE);

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const header = parseVendorHeader(body);
  if (!header.ok) return errorResponse(400, header.message);
  if (!Array.isArray(body.lines)) return errorResponse(400, 'Nothing to receive.');

  const ids = (body.lines as unknown[])
    .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>).itemId : undefined))
    .filter(isUuid);

  const admin = createAdminSupabaseClient();
  const { data: itemRows, error: itemsError } = ids.length
    ? await admin.from('inventory_items').select('id, name, tracks_expiry').in('id', ids).eq('is_active', true)
    : { data: [], error: null };
  if (itemsError) return inventoryWriteFailure(itemsError, 'Loading the items');
  const items = new Map(((itemRows ?? []) as ReceivableItem[]).map((i) => [i.id, i]));

  const parsed = parseReceiveLines(body.lines, items, istBusinessDate());
  if (!parsed.ok) return errorResponse(400, parsed.message);
  const lines = parsed.lines
    .filter((l) => l.qty > 0)
    .map((l) => ({ item_id: l.itemId, qty: l.qty, expiry_date: l.expiryDate }));

  const { vendor, billRef, note } = header.header;
  const vendorCall = await admin.rpc('inventory_receive_vendor', {
    p_actor: gate.actor.user.id,
    p_device_id: device.id,
    p_supplier: vendor,
    p_bill_ref: billRef,
    p_note: note,
    p_lines: lines,
  });
  if (!vendorCall.error) {
    return NextResponse.json({ ok: true, batches: lines.length, vendorRecorded: true }, { status: 201 });
  }
  if (!isMissingFunction(vendorCall.error)) return inventoryWriteFailure(vendorCall.error, 'Receiving the stock');

  // Before 2026-11-vendor-stock-in.sql: receive it the old way, so the stock
  // on the counter is never refused over a missing migration.
  console.warn('inventory: inventory_receive_vendor is missing — apply supabase/2026-11-vendor-stock-in.sql');
  const { error } = await admin.rpc('inventory_receive', {
    p_request_id: null,
    p_actor: gate.actor.user.id,
    p_device_id: device.id,
    p_lines: lines,
  });
  if (error) return inventoryWriteFailure(error, 'Receiving the stock');
  return NextResponse.json({ ok: true, batches: lines.length, vendorRecorded: false }, { status: 201 });
}
