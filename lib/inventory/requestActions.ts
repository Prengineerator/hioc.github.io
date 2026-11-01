// Moving a stock request along — shared by the staff Stock screen
// (PATCH /api/inventory/requests/[id]) and the owner's Warehouse page
// (PATCH /api/owner/warehouse/requests/[id]). The routes decide WHO is acting
// and which actions their screen offers; everything else is here, once:
//
//   assign          choose who picks it / delivers it          manager or owner
//   pick            store room: record the pick                the assignee, or a manager
//                   warehouse:  record the DISPATCH            the owner or a manager
//   receive         count it in at the POS                     not the picker / deliverer
//   cancel          before it has moved stock                  requester before assignment,
//                                                              or a manager/owner
//   receive_return  count a return in at the warehouse         the owner
//   resolve         settle a transfer that arrived different   the owner
//
// Who-may-do-what is lib/inventory/rules.ts (route-aware) and
// lib/inventory/warehouse.ts; the database functions re-check the status
// under a row lock, so two screens racing the same request can't both win.
// Owner alerts go out after the response (lib/api/background.ts) and never
// fail the action.

import 'server-only';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorResponse, notFound } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { runAfterResponse } from '@/lib/api/background';
import { istBusinessDate } from '@/lib/cash/date';
import { inventoryWriteFailure } from '@/lib/inventory/api';
import { loadAssignees } from '@/lib/inventory/server';
import { sendStockAssignedEmail } from '@/lib/inventory/notify';
import { sendOwnerAlert } from '@/lib/inventory/ownerAlerts';
import {
  canAssign,
  canCancel,
  canPick,
  canReceive,
  cancellableStatuses,
  isWarehouseRoute,
  parsePickLines,
  parseReceiveLines,
  type ReceivableItem,
  type RequestActor,
  type RequestFacts,
  type StockRequestStatus,
  type StockRoute,
  type Verdict,
} from '@/lib/inventory/rules';
import {
  canReceiveReturn,
  canResolve,
  lineDifference,
  parseDeliverer,
  parseResolveLines,
  type MismatchedLine,
} from '@/lib/inventory/warehouse';
import type { StaffSurface } from '@/lib/staff/surfaceRules';
import type { UserRole } from '@/lib/types';

export const REQUEST_ACTIONS = ['assign', 'pick', 'receive', 'cancel', 'receive_return', 'resolve'] as const;
export type RequestAction = (typeof REQUEST_ACTIONS)[number];

export interface ActionActor {
  userId: string;
  role: UserRole;
  isManager: boolean;
  surface: StaffSurface;
  /** The enrolled POS device, for a count-in at the counter. */
  deviceId: string | null;
}

const MAX_REASON = 200;
const MAX_NOTE = 300;

type LineRow = {
  item_id: string;
  qty_picked: number | null;
  qty_received: number | null;
  inventory_items: { name: string } | null;
};

type Row = {
  id: string;
  status: StockRequestStatus;
  route?: StockRoute | null;
  requested_by: string;
  assigned_to: string | null;
  picked_by: string | null;
  has_discrepancy: boolean;
  resolved_at?: string | null;
  stock_request_lines: LineRow[] | null;
};

const SELECT =
  'id, status, route, requested_by, assigned_to, picked_by, has_discrepancy, resolved_at, stock_request_lines(item_id, qty_picked, qty_received, inventory_items(name))';
// Before supabase/2026-11-warehouse.sql: no route column, so every request is a store-room one.
const LEGACY_SELECT =
  'id, status, requested_by, assigned_to, picked_by, has_discrepancy, stock_request_lines(item_id, qty_picked, qty_received, inventory_items(name))';

async function loadRequest(admin: SupabaseClient, id: string): Promise<{ row: Row | null; error: { code?: string; message?: string } | null }> {
  let res = await admin.from('stock_requests').select(SELECT).eq('id', id).maybeSingle();
  if (res.error && isMissingColumnError(res.error)) res = await admin.from('stock_requests').select(LEGACY_SELECT).eq('id', id).maybeSingle();
  return { row: (res.data as unknown as Row | null) ?? null, error: res.error };
}

/**
 * Applies one action to one request. `allowed` is what the calling screen
 * offers (the staff route never offers the owner's warehouse-side counts).
 */
export async function patchStockRequest(
  admin: SupabaseClient,
  actor: ActionActor,
  id: string,
  body: Record<string, unknown>,
  allowed: readonly RequestAction[],
): Promise<NextResponse> {
  if (!isUuid(id)) return notFound();
  const action = body.action as RequestAction;
  if (!allowed.includes(action)) return errorResponse(400, `action must be one of: ${allowed.map((a) => `'${a}'`).join(', ')}`);

  const { row, error: readError } = await loadRequest(admin, id);
  if (readError) return inventoryWriteFailure(readError, 'Loading the request');
  if (!row) return notFound();

  const route: StockRoute = row.route ?? 'store_room';
  const facts: RequestFacts = {
    status: row.status,
    requested_by: row.requested_by,
    assigned_to: row.assigned_to,
    picked_by: row.picked_by,
    route,
  };
  const lines = row.stock_request_lines ?? [];
  const lineItemIds = lines.map((l) => l.item_id);
  const ruleActor: RequestActor = { userId: actor.userId, role: actor.role, surface: actor.surface };
  const refuse = (v: Verdict) => (v.ok ? null : errorResponse(v.status, v.message));

  // ── assign ────────────────────────────────────────────────────────────────
  if (action === 'assign') {
    const denied = refuse(canAssign(facts, ruleActor));
    if (denied) return denied;
    const team = await loadAssignees(admin);
    let assigneeId: string | null = null;
    let outside: { name: string; phone: string } | null = null;
    if (isWarehouseRoute(route)) {
      const parsed = parseDeliverer(body, isUuid);
      if (!parsed.ok) return errorResponse(400, parsed.message);
      if (parsed.deliverer.kind === 'member') assigneeId = parsed.deliverer.userId;
      else outside = { name: parsed.deliverer.name, phone: parsed.deliverer.phone };
    } else {
      if (!isUuid(body.assigneeId)) return errorResponse(400, 'Pick who should pick this request.');
      assigneeId = body.assigneeId;
    }
    if (assigneeId && !team.some((p) => p.id === assigneeId)) return errorResponse(400, 'That person is not on the active team.');

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      status: 'assigned',
      assigned_to: assigneeId,
      assigned_by: actor.userId,
      assigned_at: now,
      updated_at: now,
    };
    // Only a warehouse transfer has (and may set) the outside-deliverer columns.
    if (isWarehouseRoute(route)) {
      patch.deliverer_name = outside?.name ?? '';
      patch.deliverer_phone = outside?.phone ?? '';
    }
    const { data: updated, error } = await admin
      .from('stock_requests')
      .update(patch)
      .eq('id', id)
      .in('status', ['requested', 'assigned'])
      .select('id')
      .maybeSingle();
    if (error) return inventoryWriteFailure(error, 'Assigning the request');
    if (!updated) return errorResponse(409, 'This request moved on — refresh and try again.');

    // Tell a team member (INV-9). Not when a manager assigns it to themselves,
    // and not an outside deliverer (no account, no email on file). Never fails
    // the assignment.
    let emailed: 'sent' | 'failed' | 'skipped' = 'skipped';
    if (assigneeId && assigneeId !== actor.userId) {
      const assignedByName = team.find((p) => p.id === actor.userId)?.name ?? (actor.role === 'owner' ? 'The owner' : 'A manager');
      emailed = (
        await sendStockAssignedEmail(admin, {
          requestId: id,
          assigneeId,
          assignedByName,
          delivery: isWarehouseRoute(route) ? route : undefined,
        })
      ).status;
    }
    return NextResponse.json({ ok: true, emailed });
  }

  // ── pick (store room) / dispatch (warehouse) ──────────────────────────────
  if (action === 'pick') {
    const denied = refuse(canPick(facts, ruleActor));
    if (denied) return denied;
    const parsed = parsePickLines(body.lines, lineItemIds);
    if (!parsed.ok) return errorResponse(400, parsed.message);
    const pLines = parsed.lines.map((l) => ({ item_id: l.itemId, qty: l.qty }));
    if (route === 'from_warehouse') {
      const { data, error } = await admin.rpc('warehouse_dispatch', { p_request_id: id, p_actor: actor.userId, p_lines: pLines });
      if (error) return inventoryWriteFailure(error, 'Recording the dispatch');
      const short = (((data ?? {}) as { short?: { item_id: string; shortfall: number }[] }).short ?? []).map((s) => ({
        itemId: s.item_id,
        shortfall: Number(s.shortfall),
      }));
      return NextResponse.json({ ok: true, short });
    }
    const { error } = await admin.rpc('inventory_pick', {
      p_request_id: id,
      p_actor: actor.userId,
      p_is_manager: actor.isManager,
      p_lines: pLines,
    });
    if (error) return inventoryWriteFailure(error, 'Recording the pick');
    return NextResponse.json({ ok: true });
  }

  // ── receive at the POS ────────────────────────────────────────────────────
  if (action === 'receive') {
    const denied = refuse(canReceive(facts, ruleActor));
    if (denied) return denied;
    const items = await receivableItems(admin, lineItemIds);
    if ('response' in items) return items.response;
    const parsed = parseReceiveLines(body.lines, items.map, istBusinessDate(), lineItemIds);
    if (!parsed.ok) return errorResponse(400, parsed.message);
    const { data, error } = await admin.rpc('inventory_receive', {
      p_request_id: id,
      p_actor: actor.userId,
      p_device_id: actor.deviceId,
      p_lines: parsed.lines.map((l) => ({ item_id: l.itemId, qty: l.qty, expiry_date: l.expiryDate })),
    });
    if (error) return inventoryWriteFailure(error, 'Receiving the stock');
    const hasDiscrepancy = ((data ?? {}) as { has_discrepancy?: boolean }).has_discrepancy === true;
    if (hasDiscrepancy && route === 'from_warehouse') runAfterResponse(sendOwnerAlert(admin, 'arrived_different', id));
    return NextResponse.json({ ok: true, hasDiscrepancy });
  }

  // ── count a return in at the warehouse ────────────────────────────────────
  if (action === 'receive_return') {
    const denied = refuse(
      canReceiveReturn({ route, status: row.status, hasDiscrepancy: row.has_discrepancy, resolvedAt: row.resolved_at ?? null }, actor),
    );
    if (denied) return denied;
    const items = await receivableItems(admin, lineItemIds);
    if ('response' in items) return items.response;
    const parsed = parseReceiveLines(body.lines, items.map, istBusinessDate(), lineItemIds);
    if (!parsed.ok) return errorResponse(400, parsed.message);
    const { data, error } = await admin.rpc('warehouse_receive_return', {
      p_request_id: id,
      p_actor: actor.userId,
      p_lines: parsed.lines.map((l) => ({ item_id: l.itemId, qty: l.qty, expiry_date: l.expiryDate })),
    });
    if (error) return inventoryWriteFailure(error, 'Counting the return in');
    return NextResponse.json({ ok: true, hasDiscrepancy: ((data ?? {}) as { has_discrepancy?: boolean }).has_discrepancy === true });
  }

  // ── settle a difference ───────────────────────────────────────────────────
  if (action === 'resolve') {
    const denied = refuse(
      canResolve({ route, status: row.status, hasDiscrepancy: row.has_discrepancy, resolvedAt: row.resolved_at ?? null }, actor),
    );
    if (denied) return denied;
    const mismatched: MismatchedLine[] = lines
      .map((l) => ({
        itemId: l.item_id,
        itemName: l.inventory_items?.name ?? 'An item',
        difference: lineDifference({ qtyPicked: l.qty_picked, qtyReceived: l.qty_received }),
      }))
      .filter((m) => m.difference !== 0);
    const parsed = parseResolveLines(body.lines, mismatched);
    if (!parsed.ok) return errorResponse(400, parsed.message);
    if (body.note !== undefined && typeof body.note !== 'string') return errorResponse(400, 'note must be text');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > MAX_NOTE) return errorResponse(400, `Keep the note under ${MAX_NOTE} characters.`);
    const { error } = await admin.rpc('warehouse_resolve', {
      p_request_id: id,
      p_actor: actor.userId,
      p_note: note,
      p_lines: parsed.lines.map((l) => ({ item_id: l.itemId, resolution: l.resolution })),
    });
    if (error) return inventoryWriteFailure(error, 'Settling the transfer');
    return NextResponse.json({ ok: true });
  }

  // ── cancel ────────────────────────────────────────────────────────────────
  const denied = refuse(canCancel(facts, ruleActor));
  if (denied) return denied;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const ownUnassigned = row.requested_by === actor.userId && row.status === 'requested';
  if (!ownUnassigned && reason.length < 3) return errorResponse(400, 'Say why it is being cancelled.');
  if (reason.length > MAX_REASON) return errorResponse(400, `Keep the reason under ${MAX_REASON} characters.`);

  const { data: cancelled, error } = await admin
    .from('stock_requests')
    .update({
      status: 'cancelled',
      cancelled_by: actor.userId,
      cancel_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ownUnassigned && !actor.isManager ? ['requested'] : cancellableStatuses(route))
    .select('id')
    .maybeSingle();
  if (error) return inventoryWriteFailure(error, 'Cancelling the request');
  if (!cancelled) return errorResponse(409, 'This request moved on — refresh and try again.');
  return NextResponse.json({ ok: true });
}

async function receivableItems(
  admin: SupabaseClient,
  ids: string[],
): Promise<{ map: Map<string, ReceivableItem> } | { response: NextResponse }> {
  const { data, error } = await admin.from('inventory_items').select('id, name, tracks_expiry').in('id', ids);
  if (error) return { response: inventoryWriteFailure(error, 'Loading the items') };
  return { map: new Map(((data ?? []) as ReceivableItem[]).map((i) => [i.id, i])) };
}
