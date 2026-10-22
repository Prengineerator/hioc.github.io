// Menu change requests (2026-10-menu-change-requests.sql): a menu create,
// edit or delete made on the POS by staff or a manager is held here until the
// owner approves it from the owner app. Add-on groups go through the same
// requests (2026-10-addon-change-requests.sql): `target` says which kind a
// request is. Shared by the staff routes, the owner routes and both UIs, so it
// carries types only.

export type MenuChangeAction = 'create' | 'update' | 'delete';

/** What a request is about. Absent on rows from before add-on requests = a menu item. */
export type MenuChangeTarget = 'menu_item' | 'addon_group';

export type MenuChangeStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface MenuChangeVariant {
  label: string;
  price_inr: number;
}

/**
 * Menu item values in the same shape the menu item form submits
 * (MenuItemFormValues). A create carries every field; an update carries only
 * the fields that differ from the item as it stood when the request was made.
 */
export interface MenuItemChangePayload {
  name?: string;
  description?: string;
  category?: string;
  parent_category?: string;
  is_veg?: boolean;
  is_available?: boolean;
  in_store_only?: boolean;
  gst_exempt?: boolean;
  sold_by_weight?: boolean;
  sort_order?: number;
  image_url?: string;
  short_code?: string | null;
  variants?: MenuChangeVariant[];
  addon_group_ids?: string[];
}

/** One option of an add-on group, as the add-on form submits it. `id` is the
 * existing option's id; a new option has none. */
export interface AddonOptionChange {
  id?: string;
  name: string;
  price_inr: number;
}

export type AddonSelection = 'single' | 'multi';

/**
 * Add-on group values in the shape the add-on form submits. A create carries
 * every field; an update carries only the fields that differ, and `options`,
 * when present, is the group's whole option list in display order (existing
 * options by id, new ones without). Options are never removed by a request.
 */
export interface AddonGroupChangePayload {
  display_name?: string;
  selection_type?: AddonSelection;
  min_select?: number;
  max_select?: number;
  options?: AddonOptionChange[];
}

interface ChangeRequestBase {
  id: string;
  /** Name to show in lists: the proposed name for a create, else the item's / group's name. */
  item_name: string;
  status: MenuChangeStatus;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

/** A menu item create / edit / delete. */
export interface MenuItemChangeRequest extends ChangeRequestBase {
  target?: 'menu_item';
  action: MenuChangeAction;
  /** null for a create until it is approved (then the new item's id). */
  menu_item_id: string | null;
  addon_group_id?: null;
  /** Proposed values: full for a create, changed fields only for an update, null for a delete. */
  payload: MenuItemChangePayload | null;
  /** The item's full values when the request was made; null for a create. */
  snapshot: MenuItemChangePayload | null;
}

/** An add-on group create / edit (never a delete). */
export interface AddonGroupChangeRequest extends ChangeRequestBase {
  target: 'addon_group';
  action: 'create' | 'update';
  menu_item_id: null;
  /** null for a create until it is approved (then the new group's id). */
  addon_group_id: string | null;
  payload: AddonGroupChangePayload | null;
  /** The group's full values (options with ids) when the request was made; null for a create. */
  snapshot: AddonGroupChangePayload | null;
}

export type MenuChangeRequest = MenuItemChangeRequest | AddonGroupChangeRequest;

export function isAddonRequest(request: MenuChangeRequest): request is AddonGroupChangeRequest {
  return request.target === 'addon_group';
}

/** Body of a 202 from POST /api/menu, PATCH or DELETE /api/menu/[id]. */
export interface MenuChangePendingResponse {
  pending: true;
  request: MenuChangeRequest;
}
