import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { recomputeOrderTotals } from '@/lib/orders/amend';
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

// POST /api/orders/[id]/amend — void a wrongly-punched line (FND3-4, UI is POS-4).
// A line is VOIDED, never deleted (the row survives for audit / a fired KOT). The
// bill is recomputed server-side from the remaining lines under the optimistic
// `version` guard, and every void is written to order_amendments. Manager-gated
// via the owner-tunable permission matrix (default `void_line` = manager, D4).
// Body: { item_id: uuid, reason: string }.
export async function POST(request: Request, { params }: RouteParams) {
  // Authz first — a valid staff session AND the void_line permission. UI hiding
  // is not authorization (§5.2); this is the real gate, checked per-request so an
  // owner flipping the matrix mid-shift takes effect immediately.
  const user = await getStaffUser();
  if (!user) return unauthorized();

  const { id } = params;
  if (!isUuid(id)) return notFound();

  if (!(await hasPermission(user, 'void_line'))) {
    return errorResponse(403, 'Manager permission required to void a line');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
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
