// Menu change requests (2026-10-menu-change-requests.sql): a menu create,
// edit or delete made on the POS by staff or a manager is held here until the
// owner approves it from the owner app. Shared by the staff routes, the owner
// routes and both UIs, so it carries types only.

export type MenuChangeAction = 'create' | 'update' | 'delete';

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

export interface MenuChangeRequest {
  id: string;
  action: MenuChangeAction;
  /** null for a create until it is approved (then the new item's id). */
  menu_item_id: string | null;
  /** Name to show in lists: the proposed name for a create, else the item's name. */
  item_name: string;
  /** Proposed values: full for a create, changed fields only for an update, null for a delete. */
  payload: MenuItemChangePayload | null;
  /** The item's full values when the request was made; null for a create. */
  snapshot: MenuItemChangePayload | null;
  status: MenuChangeStatus;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

/** Body of a 202 from POST /api/menu, PATCH or DELETE /api/menu/[id]. */
export interface MenuChangePendingResponse {
  pending: true;
  request: MenuChangeRequest;
}
