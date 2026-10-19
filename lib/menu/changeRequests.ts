// Menu change requests (supabase/2026-10-menu-change-requests.sql): the
// bookkeeping behind "staff propose, the owner approves". The pure half works
// out what a proposal changes (snapshot, diff, availability-only); the database
// half stores, lists, cancels and decides requests. Approving replays the stored
// payload through the same validators and writers the menu routes use
// (lib/menu/applyMenuChange.ts), so an approved change is exactly the change the
// route would have made.
//
// Every function here takes the admin (service-role) client: the table is
// closed to anon / authenticated, and the routes check who is asking first.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isInStoreOnly } from '@/lib/menu/inStore';
import {
  applyMenuCreate,
  applyMenuDelete,
  applyMenuUpdate,
  failure,
  validateCreateBody,
  validateUpdateBody,
  type Failure,
  type MenuCreateValues,
  type MenuUpdateValues,
  type Outcome,
} from '@/lib/menu/applyMenuChange';
import type {
  MenuChangeAction,
  MenuChangeRequest,
  MenuChangeStatus,
  MenuChangeVariant,
  MenuItemChangePayload,
} from '@/lib/menu/changeRequestTypes';
import type { MenuItem } from '@/lib/types';

type Admin = SupabaseClient;

export const MENU_CHANGE_MIGRATION_HINT =
  'Menu approvals are not set up yet — run supabase/2026-10-menu-change-requests.sql, then try again.';

export const REQUEST_GONE_MESSAGE =
  'This item is no longer on the menu, so the change cannot be applied. Reject the request to clear it.';

/** Longest decision note the owner can leave. */
export const MAX_NOTE_LENGTH = 500;

const REQUEST_COLUMNS =
  'id, action, menu_item_id, item_name, payload, snapshot, status, requested_by, requested_by_name, requested_at, decided_by, decided_at, decision_note';

// ---------------------------------------------------------------------------
// What a proposal changes (pure)
// ---------------------------------------------------------------------------

const SCALAR_KEYS = [
  'name',
  'description',
  'category',
  'parent_category',
  'is_veg',
  'is_available',
  'in_store_only',
  'gst_exempt',
  'sold_by_weight',
  'sort_order',
  'image_url',
  'short_code',
] as const;

type ScalarKey = (typeof SCALAR_KEYS)[number];

// The three columns a database may not have yet read as "off", short_code as
// "none" — the same way the rest of the app treats an absent value.
function scalarOf(payload: MenuItemChangePayload, key: ScalarKey): unknown {
  const value = payload[key];
  if (key === 'short_code') return value ?? null;
  if (key === 'in_store_only' || key === 'gst_exempt' || key === 'sold_by_weight') return value ?? false;
  return value;
}

function sameVariants(a: MenuChangeVariant[], b: MenuChangeVariant[]): boolean {
  return a.length === b.length && a.every((v, i) => v.label === b[i].label && v.price_inr === b[i].price_inr);
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function sameSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * The item's values as the form shows them, from a menu_items row read with its
 * variants and add-on links. Variants come out in display order. in_store_only
 * is the EFFECTIVE value (isInStoreOnly: flagged or in an in-store category),
 * because that is what the edit form starts from and sends back — comparing the
 * raw column would report a change nobody made.
 */
export function snapshotFromRow(row: Record<string, unknown>): MenuItemChangePayload {
  const variants = [...((row.menu_item_variants as { label: string; price_inr: number; sort_order: number }[] | null) ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((v) => ({ label: v.label, price_inr: v.price_inr }));
  const links = (row.menu_item_addon_groups as { addon_group_id: string }[] | null) ?? [];
  return {
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    category: String(row.category ?? ''),
    parent_category: String(row.parent_category ?? ''),
    is_veg: row.is_veg !== false,
    is_available: row.is_available !== false,
    in_store_only: isInStoreOnly({ in_store_only: row.in_store_only as boolean | null | undefined, category: String(row.category ?? '') }),
    gst_exempt: row.gst_exempt === true,
    sold_by_weight: row.sold_by_weight === true,
    sort_order: Number(row.sort_order ?? 0),
    image_url: String(row.image_url ?? ''),
    short_code: (row.short_code as string | null | undefined) ?? null,
    variants,
    addon_group_ids: links.map((l) => l.addon_group_id),
  };
}

/** A create's values, every field, as stored in the request payload. */
export function createPayloadFromValues(values: MenuCreateValues): MenuItemChangePayload {
  return {
    name: values.name,
    description: values.description,
    category: values.category,
    parent_category: values.parent_category,
    is_veg: values.is_veg,
    is_available: values.is_available,
    in_store_only: values.in_store_only,
    gst_exempt: values.gst_exempt,
    sold_by_weight: values.sold_by_weight,
    sort_order: values.sort_order,
    image_url: values.image_url,
    short_code: values.short_code,
    variants: values.variants,
    addon_group_ids: values.addon_group_ids,
  };
}

/**
 * What an edit body proposes, in payload shape. unavailable_until is left out:
 * a snooze is never part of a request (it is an instant availability change).
 */
export function proposedFromUpdate(values: MenuUpdateValues): MenuItemChangePayload {
  const proposed: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    const value = values.updates[key];
    if (value !== undefined) proposed[key] = value;
  }
  if (values.variants !== undefined) proposed.variants = values.variants;
  if (values.addonGroupIds !== undefined) proposed.addon_group_ids = values.addonGroupIds;
  return proposed as MenuItemChangePayload;
}

/**
 * Only the proposed fields that differ from the item as it stands. Variants are
 * compared as an ordered { label, price_inr } list (the order is the display
 * order), add-on groups as a set. A field the proposal does not name is never a
 * change.
 */
export function diffChangePayload(
  snapshot: MenuItemChangePayload,
  proposed: MenuItemChangePayload,
): MenuItemChangePayload {
  const changes: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    if (proposed[key] === undefined) continue;
    if (scalarOf(snapshot, key) !== scalarOf(proposed, key)) changes[key] = proposed[key];
  }
  if (proposed.variants !== undefined && !sameVariants(snapshot.variants ?? [], proposed.variants)) {
    changes.variants = proposed.variants;
  }
  if (proposed.addon_group_ids !== undefined && !sameSet(snapshot.addon_group_ids ?? [], proposed.addon_group_ids)) {
    changes.addon_group_ids = unique(proposed.addon_group_ids);
  }
  return changes as MenuItemChangePayload;
}

const AVAILABILITY_KEYS = new Set(['is_available', 'unavailable_until']);

/**
 * True when a change touches nothing but sold-out / snooze — the toggles that
 * stay instant (no approval). Keys whose value is undefined do not count; an
 * empty change is not availability-only.
 */
export function isAvailabilityOnly(changes: object): boolean {
  const keys = Object.entries(changes)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  return keys.length > 0 && keys.every((key) => AVAILABILITY_KEYS.has(key));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function isMissingTable(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205';
}

function dbFailure(error: { code?: string | null; message?: string } | null | undefined, message: string): Failure {
  if (isMissingTable(error)) return failure(409, MENU_CHANGE_MIGRATION_HINT);
  console.error(`menu change requests: ${message}`, error);
  return failure(500, message);
}

function asPayload(value: unknown): MenuItemChangePayload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as MenuItemChangePayload) : null;
}

export function toMenuChangeRequest(row: Record<string, unknown>): MenuChangeRequest {
  return {
    id: String(row.id),
    action: row.action as MenuChangeAction,
    menu_item_id: (row.menu_item_id as string | null | undefined) ?? null,
    item_name: typeof row.item_name === 'string' ? row.item_name : '',
    payload: asPayload(row.payload),
    snapshot: asPayload(row.snapshot),
    status: row.status as MenuChangeStatus,
    requested_by: (row.requested_by as string | null | undefined) ?? null,
    requested_by_name: (row.requested_by_name as string | null | undefined) ?? null,
    requested_at: String(row.requested_at ?? ''),
    decided_by: (row.decided_by as string | null | undefined) ?? null,
    decided_at: (row.decided_at as string | null | undefined) ?? null,
    decision_note: (row.decision_note as string | null | undefined) ?? null,
  };
}

/** The item's full current values (variants in order, add-on group ids), or a 404. */
export async function loadItemSnapshot(admin: Admin, id: string): Promise<Outcome<MenuItemChangePayload>> {
  const { data, error } = await admin
    .from('menu_items')
    .select('*, menu_item_variants(*), menu_item_addon_groups(addon_group_id)')
    .eq('id', id)
    .maybeSingle();
  if (error) return failure(500, 'Failed to load menu item');
  if (!data) return failure(404, 'Not found');
  return { ok: true, value: snapshotFromRow(data as Record<string, unknown>) };
}

async function lookupName(admin: Admin, userId: string): Promise<string | null> {
  const { data, error } = await admin.from('profiles').select('name').eq('id', userId).maybeSingle();
  if (error) return null;
  const name = (data as { name?: string | null } | null)?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

export interface NewChangeRequest {
  action: MenuChangeAction;
  /** The item an update / delete is about; null for a create. */
  menuItemId: string | null;
  /** The proposed name for a create, else the item's current name. */
  itemName: string;
  payload: MenuItemChangePayload | null;
  snapshot: MenuItemChangePayload | null;
  /** profiles.id of the staff member or manager asking. */
  requestedBy: string;
}

/**
 * Stores a pending request. A new update / delete for an item replaces any
 * older PENDING update / delete for that same item (the older one is set to
 * cancelled), so the owner only ever has one open request per item to decide.
 */
export async function createChangeRequest(admin: Admin, input: NewChangeRequest): Promise<Outcome<MenuChangeRequest>> {
  const requestedByName = await lookupName(admin, input.requestedBy);
  const { data, error } = await admin
    .from('menu_change_requests')
    .insert({
      action: input.action,
      menu_item_id: input.menuItemId,
      item_name: input.itemName,
      payload: input.payload,
      snapshot: input.snapshot,
      status: 'pending',
      requested_by: input.requestedBy,
      requested_by_name: requestedByName,
    })
    .select(REQUEST_COLUMNS)
    .single();
  if (error || !data) return dbFailure(error, 'Failed to save the change request');

  const created = toMenuChangeRequest(data as Record<string, unknown>);

  if (input.menuItemId && input.action !== 'create') {
    // After the insert, so a failed insert never costs the older request. A
    // failure here leaves two open requests, which the owner can still decide.
    const { error: supersedeError } = await admin
      .from('menu_change_requests')
      .update({
        status: 'cancelled',
        decided_at: new Date().toISOString(),
        decision_note: 'Replaced by a newer request',
      })
      .eq('menu_item_id', input.menuItemId)
      .eq('status', 'pending')
      .in('action', ['update', 'delete'])
      .neq('id', created.id);
    if (supersedeError) console.error('menu change requests: could not replace older requests', supersedeError);
  }

  return { ok: true, value: created };
}

export async function loadChangeRequest(admin: Admin, id: string): Promise<Outcome<MenuChangeRequest>> {
  const { data, error } = await admin.from('menu_change_requests').select(REQUEST_COLUMNS).eq('id', id).maybeSingle();
  if (error) return dbFailure(error, 'Failed to load the change request');
  if (!data) return failure(404, 'Not found');
  return { ok: true, value: toMenuChangeRequest(data as Record<string, unknown>) };
}

/** Newest first. `status` 'all' lists every status. */
export async function listChangeRequests(
  admin: Admin,
  status: MenuChangeStatus | 'all',
  limit: number,
): Promise<Outcome<MenuChangeRequest[]>> {
  let query = admin.from('menu_change_requests').select(REQUEST_COLUMNS);
  if (status !== 'all') query = query.eq('status', status);
  const { data, error } = await query.order('requested_at', { ascending: false }).limit(limit);
  if (error) return dbFailure(error, 'Failed to load change requests');
  return { ok: true, value: ((data ?? []) as Record<string, unknown>[]).map(toMenuChangeRequest) };
}

export async function countPendingRequests(admin: Admin): Promise<Outcome<number>> {
  const { data, error } = await admin.from('menu_change_requests').select('id').eq('status', 'pending');
  if (error) return dbFailure(error, 'Failed to count change requests');
  return { ok: true, value: (data ?? []).length };
}

function alreadyDecided(status: MenuChangeStatus): Failure {
  return failure(409, `This request was already ${status}.`);
}

/**
 * Moves a PENDING request to a final status. The update is conditional on the
 * row still being pending, so two people deciding at once cannot both win: the
 * loser gets a 409.
 */
async function closeRequest(
  admin: Admin,
  id: string,
  status: Exclude<MenuChangeStatus, 'pending'>,
  decidedBy: string,
  note: string | null,
): Promise<Outcome<MenuChangeRequest>> {
  const { data, error } = await admin
    .from('menu_change_requests')
    .update({
      status,
      decided_by: decidedBy,
      decided_at: new Date().toISOString(),
      decision_note: note,
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select(REQUEST_COLUMNS)
    .maybeSingle();
  if (error) return dbFailure(error, 'Failed to update the change request');
  if (!data) return failure(409, 'This request was already decided.');
  return { ok: true, value: toMenuChangeRequest(data as Record<string, unknown>) };
}

/** Withdraws a pending request (the requester, a manager or the owner). */
export async function cancelChangeRequest(admin: Admin, id: string, cancelledBy: string): Promise<Outcome<MenuChangeRequest>> {
  return closeRequest(admin, id, 'cancelled', cancelledBy, null);
}

export async function rejectChangeRequest(
  admin: Admin,
  id: string,
  rejectedBy: string,
  note: string | null,
): Promise<Outcome<MenuChangeRequest>> {
  return closeRequest(admin, id, 'rejected', rejectedBy, note);
}

/**
 * Cancels pending update / delete requests whose item has been deleted
 * (menu_item_id goes null with the item): they can never be applied. Called
 * after any successful menu item delete. Best effort — a failure only leaves
 * requests for the owner to reject by hand.
 */
export async function cancelOrphanedRequests(admin: Admin): Promise<void> {
  const { error } = await admin
    .from('menu_change_requests')
    .update({
      status: 'cancelled',
      decided_at: new Date().toISOString(),
      decision_note: 'The item was deleted',
    })
    .eq('status', 'pending')
    .in('action', ['update', 'delete'])
    .is('menu_item_id', null);
  if (error && !isMissingTable(error)) console.error('menu change requests: could not clear orphaned requests', error);
}

// ---------------------------------------------------------------------------
// Approving
// ---------------------------------------------------------------------------

export interface ApprovalResult {
  request: MenuChangeRequest;
  /** The item as it now stands (create and update); absent for a delete. */
  item?: MenuItem;
}

async function itemExists(admin: Admin, id: string): Promise<Outcome<boolean>> {
  const { data, error } = await admin.from('menu_items').select('id').eq('id', id).maybeSingle();
  if (error) return failure(500, 'Failed to load menu item');
  return { ok: true, value: Boolean(data) };
}

/**
 * Approves a pending request: claims it (pending -> approved, conditional, so a
 * double click or two owners cannot apply it twice), then applies it with the
 * menu routes' own write logic. If applying fails the request goes back to
 * pending with its decision cleared and the error is returned, so nothing is
 * lost and the owner can retry or reject. A create gets the new item's id as
 * menu_item_id.
 */
export async function approveChangeRequest(
  admin: Admin,
  id: string,
  ownerId: string,
  note: string | null,
): Promise<Outcome<ApprovalResult>> {
  const loaded = await loadChangeRequest(admin, id);
  if (!loaded.ok) return loaded;
  const request = loaded.value;
  if (request.status !== 'pending') return alreadyDecided(request.status);

  // Check everything that can be checked before claiming the row.
  let createValues: MenuCreateValues | null = null;
  let updateValues: MenuUpdateValues | null = null;
  if (request.action === 'create' || request.action === 'update') {
    const checked =
      request.action === 'create'
        ? validateCreateBody((request.payload ?? {}) as Record<string, unknown>)
        : validateUpdateBody((request.payload ?? {}) as Record<string, unknown>);
    if (!checked.ok) return failure(400, `This request has values that cannot be applied: ${checked.message}`);
    if (request.action === 'create') createValues = checked.value as MenuCreateValues;
    else updateValues = checked.value as MenuUpdateValues;
  }
  if (request.action !== 'create') {
    if (!request.menu_item_id) return failure(409, REQUEST_GONE_MESSAGE);
    const exists = await itemExists(admin, request.menu_item_id);
    if (!exists.ok) return exists;
    if (!exists.value) return failure(409, REQUEST_GONE_MESSAGE);
  }

  const claimed = await closeRequest(admin, id, 'approved', ownerId, note);
  if (!claimed.ok) return claimed;

  let applied: Outcome<{ item?: MenuItem }>;
  if (request.action === 'create') {
    const created = await applyMenuCreate(admin, createValues as MenuCreateValues);
    applied = created.ok ? { ok: true, value: { item: created.value } } : created;
  } else if (request.action === 'update') {
    const updated = await applyMenuUpdate(admin, request.menu_item_id as string, updateValues as MenuUpdateValues);
    applied = updated.ok ? { ok: true, value: { item: updated.value } } : updated;
  } else {
    const deleted = await applyMenuDelete(admin, request.menu_item_id as string);
    applied = deleted.ok ? { ok: true, value: {} } : deleted;
  }

  if (!applied.ok) {
    const { error: revertError } = await admin
      .from('menu_change_requests')
      .update({ status: 'pending', decided_by: null, decided_at: null, decision_note: null })
      .eq('id', id)
      .eq('status', 'approved');
    if (revertError) console.error('menu change requests: could not put a failed approval back to pending', revertError);
    // The item vanished between the check and the write.
    return applied.status === 404 ? failure(409, REQUEST_GONE_MESSAGE) : applied;
  }

  const item = applied.value.item;
  let finished = claimed.value;
  if (request.action === 'create' && item) {
    // The item exists either way; only the link back to it can be lost.
    const { error: linkError } = await admin.from('menu_change_requests').update({ menu_item_id: item.id }).eq('id', id);
    if (linkError) console.error('menu change requests: could not link the created item', linkError);
    finished = { ...finished, menu_item_id: item.id };
  }
  if (request.action === 'delete') {
    // The item is gone, and so is the link to it (on delete set null).
    finished = { ...finished, menu_item_id: null };
    await cancelOrphanedRequests(admin);
  }

  return { ok: true, value: { request: finished, ...(item ? { item } : {}) } };
}
