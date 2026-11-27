import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { istBusinessDate } from '@/lib/cash/date';
import { inventoryWriteFailure } from '@/lib/inventory/api';
import type { ReceivableItem } from '@/lib/inventory/rules';
import { parsePurchaseLines } from '@/lib/inventory/warehouse';
import { requireWarehouseOwner } from '@/lib/inventory/warehouseServer';

export const dynamic = 'force-dynamic';

const MAX_TEXT = 120;

// POST /api/owner/warehouse/purchases — owner only. Stock bought into the
// warehouse (or the opening count on go-live day), one batch per line:
//   { supplier?, note?, lines: [{ itemId, qty, expiryDate }] }
// A perishable needs its expiry date; an already-expired one is refused.
export async function POST(request: Request) {
  const gate = await requireWarehouseOwner();
  if ('response' in gate) return gate.response;
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  if (!Array.isArray(body.lines)) return errorResponse(400, 'Add at least one item.');

  for (const key of ['supplier', 'note'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'string') return errorResponse(400, `${key} must be text`);
    if (typeof body[key] === 'string' && (body[key] as string).trim().length > MAX_TEXT) {
      return errorResponse(400, `Keep the ${key} under ${MAX_TEXT} characters.`);
    }
  }

  const ids = [
    ...new Set(
      (body.lines as unknown[])
        .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>).itemId : undefined))
        .filter(isUuid),
    ),
  ];
  const admin = createAdminSupabaseClient();
  const { data: itemRows, error: itemsError } = ids.length
    ? await admin.from('inventory_items').select('id, name, tracks_expiry').in('id', ids).eq('is_active', true)
    : { data: [], error: null };
  if (itemsError) return inventoryWriteFailure(itemsError, 'Loading the items');
  const items = new Map(((itemRows ?? []) as ReceivableItem[]).map((i) => [i.id, i]));
  const parsed = parsePurchaseLines(body.lines, items, istBusinessDate());
  if (!parsed.ok) return errorResponse(400, parsed.message);

  const { data, error } = await admin.rpc('warehouse_purchase', {
    p_actor: gate.owner.id,
    p_supplier: typeof body.supplier === 'string' ? body.supplier.trim() : '',
    p_note: typeof body.note === 'string' ? body.note.trim() : '',
    p_lines: parsed.lines.map((l) => ({ item_id: l.itemId, qty: l.qty, expiry_date: l.expiryDate })),
  });
  if (error) return inventoryWriteFailure(error, 'Recording the purchase');
  return NextResponse.json({ ok: true, batches: data }, { status: 201 });
}
