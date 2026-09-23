import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { recomputeOrderTotals } from '@/lib/orders/amend';
import {
  MENU_ITEM_SELECT,
  parseItems,
  resolveOrderLines,
  shapeMenuItem,
  type MenuItemRow,
} from '@/lib/orders/lines';
import { getStoreSettings } from '@/lib/store/settings';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import type { OrderStatus, OrderType } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// The non-terminal, pre-settle states in which an order can still be corrected
// (FND3-4). Terminal (completed/rejected/cancelled) and pre-accept (placed)
// orders are not open for a void.
const OPEN_STATUSES: OrderStatus[] = ['accepted', 'preparing', 'ready'];

// The subset of the loaded order + lines the recompute + preconditions need.
type OrderLine = { id: string; voided: boolean; line_total_inr: number };
type LoadedOrder = {
  id: string;
  status: OrderStatus;
  version: number;
  order_type: OrderType;
  payment_status: string;
  discount_inr: number;
  order_items: OrderLine[] | null;
};

// POST /api/orders/[id]/amend — correct an open order. Two operations:
//
//   { item_id, reason }        → VOID a wrongly-punched line (FND3-4, UI POS-4)
//   { op: 'add', items: [...] }→ ADD lines to the running order (TAB-1, UI TAB-2)
//
// `op` defaults to 'void' so the existing POS-4 contract is unchanged.
//
// Both share the same invariants: the order must be open and unpaid, totals are
// recomputed SERVER-SIDE under the optimistic `version` guard, a lost race rolls
// the change back rather than half-applying it, and every amendment is audited
// in order_amendments.
//
// They differ in authorization, deliberately. A void REDUCES what a customer
// owes and is manager-gated (`void_line`, D4). An add increases an unpaid tab —
// that's ordinary table service, not a correction, so it rides the same
// `pos_order_entry` permission as punching the order in the first place. Using a
// new key here would fail CLOSED to manager on any deploy whose seed row is
// missing (see lib/permissions.ts), quietly breaking normal service.
export async function POST(request: Request, { params }: RouteParams) {
  const user = await getStaffUser();
  if (!user) return unauthorized();

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  if (body.op === 'add') {
    return addLines(request, id, user, body);
  }

  // --- VOID (FND3-4) --------------------------------------------------------
  // UI hiding is not authorization (§5.2); this is the real gate, checked
  // per-request so an owner flipping the matrix mid-shift takes effect at once.
  if (!(await hasPermission(user, 'void_line'))) {
    return errorResponse(403, 'Manager permission required to void a line');
  }

  if (!isUuid(body.item_id)) {
    return errorResponse(400, 'item_id is required and must be a valid uuid');
  }
  const itemId = body.item_id as string;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return errorResponse(400, 'reason is required and must be a non-empty string');
  }

  const admin = createAdminSupabaseClient();

  // Load the order + its lines in one round-trip. status/order_type/payment_status
  // drive the correction preconditions; `version` arms the optimistic guard; the
  // line list feeds both the target lookup and the server-side recompute.
  const { data, error: readError } = await admin
    .from('orders')
    .select(
      'id, status, version, order_type, payment_status, discount_inr, order_items(id, voided, line_total_inr)',
    )
    .eq('id', id)
    .maybeSingle();

  if (readError) return errorResponse(500, 'Failed to load the order');
  if (!data) return notFound();
  const order = data as LoadedOrder;

  const items: OrderLine[] = order.order_items ?? [];
  const target = items.find((line) => line.id === itemId);
  if (!target) {
    return errorResponse(404, 'That item is not a line on this order');
  }

  // Preconditions — each a 409 (a conflict with the order's current state).
  if (!OPEN_STATUSES.includes(order.status)) {
    return errorResponse(409, 'This order can no longer be corrected — it is not open.');
  }
  // Post-payment fixes go through the Phase-2 refund path, never a silent void.
  if (order.payment_status === 'paid') {
    return errorResponse(409, 'This order is already paid — correct it through a refund, not a void.');
  }
  if (target.voided) {
    return errorResponse(409, 'That line is already voided.');
  }
  // Last-line guard: a void must never empty the order (spec edge case). `target`
  // is non-voided here, so it is counted in nonVoidedCount; count === 1 means
  // voiding it would leave zero lines.
  const nonVoidedCount = items.filter((line) => !line.voided).length;
  if (nonVoidedCount <= 1) {
    return errorResponse(409, 'Void would empty the order — cancel the order instead.');
  }

  // Void the line (never delete — snapshot rule; a fired KOT may reference it).
  const nowIso = new Date().toISOString();
  const { error: voidError } = await admin
    .from('order_items')
    .update({ voided: true, void_reason: reason, voided_by: user.id, voided_at: nowIso })
    .eq('id', itemId);
  if (voidError) return errorResponse(500, 'Failed to void the line');

  // Recompute authoritative totals from the REMAINING (non-voided) lines. Money
  // is server-only: mark the just-voided line in-memory and hand the whole set to
  // the shared recompute (subtotal = Σ non-voided, discount clamped, dine-in D5).
  const settings = await getStoreSettings();
  const remaining = items.map((line) =>
    line.id === itemId ? { ...line, voided: true } : line,
  );
  const bill = recomputeOrderTotals({
    items: remaining,
    settings,
    orderType: order.order_type,
    discountInr: order.discount_inr,
  });

  // Persist the new totals UNDER THE OPTIMISTIC VERSION GUARD. If a concurrent
  // write bumped the version first, zero rows update → we roll the void back (so
  // the re-presented order is clean, never half-applied) and ask the caller to
  // re-check and retry — never force (§5.2).
  const { data: guarded, error: updateError } = await admin
    .from('orders')
    .update({
      subtotal_inr: bill.subtotal_inr,
      tax_inr: bill.tax_inr,
      packaging_inr: bill.packaging_inr,
      discount_inr: bill.discount_inr,
      total_inr: bill.total_inr,
      version: order.version + 1,
    })
    .eq('id', id)
    .eq('version', order.version)
    .select('id')
    .maybeSingle();

  if (updateError) return errorResponse(500, 'Failed to update the order total');
  if (!guarded) {
    await admin
      .from('order_items')
      .update({ voided: false, void_reason: '', voided_by: null, voided_at: null })
      .eq('id', itemId);
    return errorResponse(
      409,
      'Order was updated by someone else — please re-check the order and try again.',
    );
  }

  // Audit the correction (who/what/when + payload) — only after the guarded write
  // commits, so a lost-race amend leaves no phantom audit row (FND3-4 / open enum).
  await admin.from('order_amendments').insert({
    order_id: id,
    staff_id: user.id,
    kind: 'void_item',
    payload: { order_item_id: itemId, reason, line_total_inr: target.line_total_inr },
  });

  // The staff board already updates via postgres_changes on the orders row; this
  // extra ping lets any live customer status page refetch the new total (status
  // is unchanged). Best-effort — mirrors the other order routes, never throws.
  await broadcastOrderEvent(id, order.status);

  // Reload + shape exactly like the other order routes (toOrderResponse).
  const { data: full, error: reloadError } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .eq('id', id)
    .single();
  if (reloadError || !full) {
    return errorResponse(500, 'Voided the line but failed to reload the order');
  }

  return NextResponse.json({ order: toOrderResponse(full as OrderRowWithItems) });
}

/**
 * TAB-1 — append lines to an open, unpaid order so a table keeps ONE bill.
 *
 * Mirrors the void path's safety model exactly: same open/unpaid preconditions,
 * same server-side recompute, same optimistic version guard, same audit — and on
 * a lost race the newly inserted lines are deleted (order_item_addons cascades),
 * so the order is never left half-extended.
 *
 * Prices come from lib/orders/lines.ts, the same resolver POST /api/orders uses,
 * so an added latte is priced and snapshot identically to one punched at
 * creation. 86'd items and bad variant/addon combinations are rejected there.
 */
async function addLines(
  _request: Request,
  id: string,
  user: { id: string },
  body: Record<string, unknown>,
) {
  if (!(await hasPermission(user as never, 'pos_order_entry'))) {
    return errorResponse(403, 'You do not have permission to add items to an order');
  }

  const parsed = parseItems(body.items);
  if (typeof parsed === 'string') return errorResponse(400, parsed);

  const admin = createAdminSupabaseClient();

  const { data, error: readError } = await admin
    .from('orders')
    .select(
      'id, status, version, order_type, payment_status, discount_inr, order_items(id, voided, line_total_inr)',
    )
    .eq('id', id)
    .maybeSingle();

  if (readError) return errorResponse(500, 'Failed to load the order');
  if (!data) return notFound();
  const order = data as LoadedOrder;
  const existingItems: OrderLine[] = order.order_items ?? [];

  if (!OPEN_STATUSES.includes(order.status)) {
    return errorResponse(409, 'This order can no longer be changed — it is not open.');
  }
  // A paid order's bill is settled; adding to it would silently change what the
  // customer already paid. Start a new order instead.
  if (order.payment_status === 'paid') {
    return errorResponse(409, 'This order is already paid — start a new order for anything else.');
  }

  // Price the new lines against the live menu (server-authoritative).
  const menuIds = [...new Set(parsed.map((i) => i.menu_item_id))];
  const { data: menuRows, error: menuError } = await admin
    .from('menu_items')
    .select(MENU_ITEM_SELECT)
    .in('id', menuIds);
  if (menuError) return errorResponse(500, 'Failed to validate order items');

  const menuById = new Map(
    (menuRows ?? []).map((row) => [row.id, shapeMenuItem(row as unknown as MenuItemRow)]),
  );
  const resolved = resolveOrderLines(parsed, menuById);
  if (!resolved.ok) return errorResponse(400, resolved.error);

  // Insert the lines, tracking ids so a lost version race can roll them back.
  const insertedIds: string[] = [];
  for (const line of resolved.lines) {
    const { addons, ...lineFields } = line;
    const { data: itemRow, error: itemError } = await admin
      .from('order_items')
      .insert({ ...lineFields, order_id: id })
      .select('id')
      .single();
    if (itemError || !itemRow) {
      await rollbackLines(admin, insertedIds);
      return errorResponse(500, 'Failed to add the items');
    }
    insertedIds.push(itemRow.id as string);

    if (addons.length > 0) {
      const { error: addonError } = await admin
        .from('order_item_addons')
        .insert(addons.map((a) => ({ ...a, order_item_id: itemRow.id })));
      if (addonError) {
        await rollbackLines(admin, insertedIds);
        return errorResponse(500, 'Failed to add the item options');
      }
    }
  }

  // Recompute from EVERY non-voided line — the ones already on the order plus
  // the ones just added. Same shared recompute the void path uses (dine-in
  // packaging rule and discount clamp included).
  const settings = await getStoreSettings();
  const allLines = [
    ...existingItems,
    ...resolved.lines.map((l) => ({ voided: false, line_total_inr: l.line_total_inr })),
  ];
  const bill = recomputeOrderTotals({
    items: allLines,
    settings,
    orderType: order.order_type,
    discountInr: order.discount_inr,
  });

  const { data: guarded, error: updateError } = await admin
    .from('orders')
    .update({
      subtotal_inr: bill.subtotal_inr,
      tax_inr: bill.tax_inr,
      packaging_inr: bill.packaging_inr,
      discount_inr: bill.discount_inr,
      total_inr: bill.total_inr,
      version: order.version + 1,
    })
    .eq('id', id)
    .eq('version', order.version)
    .select('id')
    .maybeSingle();

  if (updateError) {
    await rollbackLines(admin, insertedIds);
    return errorResponse(500, 'Failed to update the order total');
  }
  if (!guarded) {
    // Someone else changed the order first. Remove the lines we just added so the
    // re-presented order is clean, and make the caller re-check — never force.
    await rollbackLines(admin, insertedIds);
    return errorResponse(
      409,
      'Order was updated by someone else — please re-check the order and try again.',
    );
  }

  // Audit only after the guarded write commits, so a lost race leaves no
  // phantom row (same rule as the void path).
  //
  // The lines and totals are already committed, so a failed audit must NOT fail
  // the request — but it must not vanish either. The most likely cause is the
  // 2026-08-running-tab.sql migration not being applied (kind='add_item' fails
  // the CHECK), which would otherwise mean adds silently going unaudited.
  const { error: auditError } = await admin.from('order_amendments').insert({
    order_id: id,
    staff_id: user.id,
    kind: 'add_item',
    payload: {
      order_item_ids: insertedIds,
      lines: resolved.lines.map((l) => ({
        name: l.name_snapshot,
        variant: l.variant_label_snapshot,
        quantity: l.quantity,
        line_total_inr: l.line_total_inr,
      })),
      added_inr: resolved.subtotalInr,
    },
  });
  if (auditError) {
    console.error(
      `order_amendments audit FAILED for add on order ${id} (items ${insertedIds.join(',')}, ` +
        `+₹${resolved.subtotalInr}) — is supabase/2026-08-running-tab.sql applied?`,
      auditError,
    );
  }

  await broadcastOrderEvent(id, order.status);

  const { data: full, error: reloadError } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .eq('id', id)
    .single();
  if (reloadError || !full) {
    return errorResponse(500, 'Added the items but failed to reload the order');
  }

  return NextResponse.json({
    order: toOrderResponse(full as OrderRowWithItems),
    // The ids the kitchen still needs to see — TAB-2/POS4-3 print ONLY these as
    // an addition to the ticket, rather than re-firing the whole order.
    added_item_ids: insertedIds,
  });
}

/** Best-effort removal of just-inserted lines (addons cascade). */
async function rollbackLines(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await admin.from('order_items').delete().in('id', ids);
  if (error) console.error('addLines rollback failed', error, ids);
}
