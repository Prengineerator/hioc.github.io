// Pure display helpers for the owner's menu approvals (components/owner/menu).
// No React and no DOM, so the rules are unit-tested once
// (tests/ownerMenuDiff.test.ts): which fields a request touches, what each
// value reads like, how a size/price list and an add-on list changed, and how
// a time is shown in IST.

import { MENU_CATEGORIES } from '@/lib/constants';
import { choiceRuleLabel } from '@/lib/menu/customization';
import type {
  AddonGroupChangePayload,
  AddonGroupChangeRequest,
  AddonOptionChange,
  MenuChangeAction,
  MenuChangeRequest,
  MenuChangeStatus,
  MenuChangeVariant,
  MenuItemChangePayload,
  MenuItemChangeRequest,
} from '@/lib/menu/changeRequestTypes';

// ---------------------------------------------------------------------------
// Tabs and filters
// ---------------------------------------------------------------------------

export type OwnerMenuTab = 'items' | 'approvals';

export const OWNER_MENU_TABS: { id: OwnerMenuTab; label: string }[] = [
  { id: 'items', label: 'Items' },
  { id: 'approvals', label: 'Approvals' },
];

export function menuTabFromParam(param: string | null | undefined): OwnerMenuTab {
  return param === 'approvals' ? 'approvals' : 'items';
}

export type RequestFilter = 'pending' | 'approved' | 'rejected' | 'all';

export const REQUEST_FILTERS: { id: RequestFilter; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all', label: 'All' },
];

// ---------------------------------------------------------------------------
// Action / status words
// ---------------------------------------------------------------------------

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export const ACTION_LABELS: Record<MenuChangeAction, string> = {
  create: 'New item',
  update: 'Edit',
  delete: 'Delete',
};

/** The action pill's words: an add-on request says so ("New add-on group"). */
export function requestActionLabel(request: MenuChangeRequest): string {
  if (request.target === 'addon_group') return request.action === 'create' ? 'New add-on group' : 'Edit add-on group';
  return ACTION_LABELS[request.action];
}

export function actionTone(action: MenuChangeAction): Tone {
  return action === 'create' ? 'good' : action === 'delete' ? 'bad' : 'warn';
}

export const STATUS_LABELS: Record<MenuChangeStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export function statusTone(status: MenuChangeStatus): Tone {
  return status === 'approved' ? 'good' : status === 'rejected' ? 'bad' : status === 'pending' ? 'warn' : 'neutral';
}

/**
 * The menu items that have a pending edit or delete waiting, for the table to
 * flag. A create has no item yet, so it is not in the map. The API keeps at
 * most one pending update/delete per item; if two ever coexist, a delete wins
 * because it is the bigger change.
 */
export function pendingByItemId(requests: MenuChangeRequest[]): Record<string, MenuChangeAction> {
  const out: Record<string, MenuChangeAction> = {};
  for (const r of requests) {
    if (r.status !== 'pending' || !r.menu_item_id) continue;
    if (r.action !== 'update' && r.action !== 'delete') continue;
    if (out[r.menu_item_id] === 'delete') continue;
    out[r.menu_item_id] = r.action;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Times (IST, plain arithmetic like components/owner/marketing/format.ts so the
// output never depends on the browser's timezone or ICU build)
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "19 Oct, 3:05 pm" — IST wall clock of an ISO instant; '—' when missing or unparseable. */
export function formatIstDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + IST_OFFSET_MS);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${h12}:${mm} ${h24 < 12 ? 'am' : 'pm'}`;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

type PayloadKey = keyof MenuItemChangePayload;

/** Fields in the order a card lists them. parent_category is derived from category, so it is never shown. */
export const FIELD_ORDER: PayloadKey[] = [
  'name',
  'description',
  'category',
  'is_veg',
  'is_available',
  'in_store_only',
  'gst_exempt',
  'sold_by_weight',
  'sort_order',
  'image_url',
  'short_code',
  'variants',
  'addon_group_ids',
];

export const FIELD_LABELS: Record<PayloadKey, string> = {
  name: 'Name',
  description: 'Description',
  category: 'Category',
  parent_category: 'Parent category',
  is_veg: 'Veg',
  is_available: 'Available',
  in_store_only: 'In-store only',
  gst_exempt: 'No GST',
  sold_by_weight: 'Sold by weight',
  sort_order: 'Sort order',
  image_url: 'Photo',
  short_code: 'Short code',
  variants: 'Sizes & prices',
  addon_group_ids: 'Add-on groups',
};

/** "Hot — Coffee" for a known category slug (same wording as the item form), else the slug itself. */
export function categoryLabel(slug: string): string {
  const c = MENU_CATEGORIES.find((cat) => cat.slug === slug);
  if (!c) return slug;
  return c.parent ? `${c.parent} — ${c.label}` : c.label;
}

/** A whole-rupee price with Indian digit grouping: "₹120", "₹1,20,000"; "/kg" after it for an item sold by weight. */
export function formatPrice(priceInr: number, perKg = false): string {
  const neg = priceInr < 0;
  const digits = String(Math.round(Math.abs(priceInr)));
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '−' : ''}₹${grouped}${perKg ? '/kg' : ''}`;
}

const NONE = 'None';

/** The reading of one plain (non-photo, non-list) field's value. null = the request says nothing about it. */
export function formatFieldValue(key: PayloadKey, value: unknown): string | null {
  if (value === undefined) return null;
  switch (key) {
    case 'is_veg':
      return value === true ? 'Veg' : 'Non-veg';
    case 'is_available':
    case 'in_store_only':
    case 'gst_exempt':
    case 'sold_by_weight':
      return value === true ? 'Yes' : 'No';
    case 'category':
      return typeof value === 'string' && value ? categoryLabel(value) : NONE;
    case 'sort_order':
      return typeof value === 'number' ? String(value) : NONE;
    default:
      return typeof value === 'string' && value.trim() !== '' ? value : NONE;
  }
}

// ---------------------------------------------------------------------------
// Sizes & prices
// ---------------------------------------------------------------------------

export type VariantRowStatus = 'same' | 'changed' | 'added' | 'removed';

export interface VariantDiffRow {
  label: string;
  /** Price before, null when the size is new. */
  before: number | null;
  /** Price after, null when the size is removed. */
  after: number | null;
  status: VariantRowStatus;
}

/**
 * Lines two size lists up by label: every size in `after` in its order (same,
 * changed price, or added), then the sizes that disappeared. A repeated label
 * pairs off in order.
 */
export function diffVariants(
  before: MenuChangeVariant[] | null | undefined,
  after: MenuChangeVariant[] | null | undefined,
): VariantDiffRow[] {
  const prior = (before ?? []).map((v) => ({ ...v, used: false }));
  const rows: VariantDiffRow[] = [];
  for (const next of after ?? []) {
    const match = prior.find((p) => !p.used && p.label === next.label);
    if (!match) {
      rows.push({ label: next.label, before: null, after: next.price_inr, status: 'added' });
      continue;
    }
    match.used = true;
    rows.push({
      label: next.label,
      before: match.price_inr,
      after: next.price_inr,
      status: match.price_inr === next.price_inr ? 'same' : 'changed',
    });
  }
  for (const p of prior) {
    if (!p.used) rows.push({ label: p.label, before: p.price_inr, after: null, status: 'removed' });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Add-on groups
// ---------------------------------------------------------------------------

export interface AddonDiff {
  kept: string[];
  added: string[];
  removed: string[];
}

/** An add-on group's name from the lookup, or a neutral label for one that no longer exists. */
export function addonGroupName(id: string, names: Record<string, string>): string {
  return names[id] || 'Unknown group';
}

/** Which add-on groups stayed, were added or were removed, as names (order kept). */
export function diffAddonGroups(
  before: string[] | null | undefined,
  after: string[] | null | undefined,
  names: Record<string, string>,
): AddonDiff {
  const b = before ?? [];
  const a = after ?? [];
  const inBefore = new Set(b);
  const inAfter = new Set(a);
  return {
    kept: a.filter((id) => inBefore.has(id)).map((id) => addonGroupName(id, names)),
    added: a.filter((id) => !inBefore.has(id)).map((id) => addonGroupName(id, names)),
    removed: b.filter((id) => !inAfter.has(id)).map((id) => addonGroupName(id, names)),
  };
}

// ---------------------------------------------------------------------------
// A whole request, ready to render
// ---------------------------------------------------------------------------

export type DiffRow =
  | { type: 'text'; key: PayloadKey; label: string; before: string | null; after: string | null }
  | { type: 'image'; key: 'image_url'; label: string; before: string | null; after: string | null }
  | { type: 'variants'; key: 'variants'; label: string; rows: VariantDiffRow[] }
  | { type: 'addons'; key: 'addon_group_ids'; label: string; diff: AddonDiff };

/**
 * diff     — an edit: each row is before → after, only the fields that change.
 * proposed — a new item: each row is the value it will start with.
 * snapshot — a delete: each row is what is about to disappear.
 */
export type DiffMode = 'diff' | 'proposed' | 'snapshot';

export interface RequestDiff {
  mode: DiffMode;
  rows: DiffRow[];
  /** Whether prices are per kg before / after (the item is sold by weight). */
  perKg: { before: boolean; after: boolean };
}

function has(obj: MenuItemChangePayload | null | undefined, key: PayloadKey): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

const UNKNOWN = '—';

export function buildRequestDiff(request: MenuItemChangeRequest, addonNames: Record<string, string> = {}): RequestDiff {
  const { action, payload, snapshot } = request;
  const mode: DiffMode = action === 'create' ? 'proposed' : action === 'delete' ? 'snapshot' : 'diff';
  // The item as it was (an edit or delete) and as it would be (a create or edit).
  // A request whose snapshot went missing still renders, with unknown "before"s.
  const before: MenuItemChangePayload | null = mode === 'proposed' ? null : (snapshot ?? {});
  const after: MenuItemChangePayload | null = mode === 'snapshot' ? null : (payload ?? {});
  // Which fields to list: those the request carries on the side it has. An edit
  // lists only what it changes.
  const source = mode === 'snapshot' ? snapshot : payload;

  const rows: DiffRow[] = [];
  for (const key of FIELD_ORDER) {
    if (!has(source, key)) continue;
    const label = FIELD_LABELS[key];
    if (key === 'variants') {
      rows.push({ type: 'variants', key, label, rows: diffVariants(before?.variants, after?.variants) });
    } else if (key === 'addon_group_ids') {
      rows.push({
        type: 'addons',
        key,
        label,
        diff: diffAddonGroups(before?.addon_group_ids, after?.addon_group_ids, addonNames),
      });
    } else if (key === 'image_url') {
      rows.push({
        type: 'image',
        key,
        label,
        before: before ? (before.image_url ?? '') : null,
        after: after ? (after.image_url ?? '') : null,
      });
    } else {
      rows.push({
        type: 'text',
        key,
        label,
        before: before ? (formatFieldValue(key, before[key]) ?? UNKNOWN) : null,
        after: after ? formatFieldValue(key, after[key]) : null,
      });
    }
  }
  return {
    mode,
    rows,
    perKg: { before: before?.sold_by_weight === true, after: (after?.sold_by_weight ?? before?.sold_by_weight) === true },
  };
}

/** "Name, Sizes & prices" — the fields an edit touches, for the card's one-line summary. */
export function changedFieldLabels(payload: MenuItemChangePayload | null | undefined): string[] {
  return FIELD_ORDER.filter((key) => has(payload, key)).map((key) => FIELD_LABELS[key]);
}

// ---------------------------------------------------------------------------
// Add-on group requests (2026-10-addon-change-requests.sql)
// ---------------------------------------------------------------------------

// How a group's choice rule reads: shared with the staff Add-ons tab.
export { choiceRuleLabel };

export type AddonOptionRowStatus = 'same' | 'changed' | 'added';

export interface AddonOptionDiffRow {
  key: string;
  before: { name: string; price_inr: number } | null;
  after: { name: string; price_inr: number };
  status: AddonOptionRowStatus;
}

/**
 * Lines an option list up with the one before it, by option id: each option of
 * `after` in its order (same, renamed / repriced, or new), then any option of
 * `before` that `after` leaves out — a request never removes an option, so those
 * stay exactly as they are and read as unchanged.
 */
export function diffAddonOptions(
  before: AddonOptionChange[] | null | undefined,
  after: AddonOptionChange[] | null | undefined,
): AddonOptionDiffRow[] {
  const prior = new Map((before ?? []).filter((o) => o.id).map((o) => [o.id as string, o]));
  const rows: AddonOptionDiffRow[] = (after ?? []).map((o, i) => {
    const was = o.id ? prior.get(o.id) : undefined;
    if (o.id) prior.delete(o.id);
    const now = { name: o.name, price_inr: o.price_inr };
    if (!was) return { key: o.id ?? `new:${i}`, before: null, after: now, status: 'added' };
    const same = was.name === o.name && was.price_inr === o.price_inr;
    return { key: o.id as string, before: { name: was.name, price_inr: was.price_inr }, after: now, status: same ? 'same' : 'changed' };
  });
  for (const [id, o] of prior) {
    const kept = { name: o.name, price_inr: o.price_inr };
    rows.push({ key: id, before: kept, after: kept, status: 'same' });
  }
  return rows;
}

export interface AddonRequestDiff {
  /** 'proposed' for a new group (values it will start with), 'diff' for an edit (before → after). */
  mode: 'proposed' | 'diff';
  /** null when the request does not change it. */
  name: { before: string | null; after: string } | null;
  rule: { before: string | null; after: string } | null;
  options: AddonOptionDiffRow[] | null;
}

const RULE_KEYS = ['selection_type', 'min_select', 'max_select'] as const;

export function buildAddonRequestDiff(request: AddonGroupChangeRequest): AddonRequestDiff {
  const payload = request.payload ?? {};
  if (request.action === 'create') {
    return {
      mode: 'proposed',
      name: { before: null, after: payload.display_name ?? '' },
      rule: { before: null, after: choiceRuleLabel(payload) ?? UNKNOWN },
      options: diffAddonOptions(null, payload.options),
    };
  }
  const snapshot = request.snapshot ?? {};
  const changesRule = RULE_KEYS.some((key) => payload[key] !== undefined);
  return {
    mode: 'diff',
    name:
      payload.display_name !== undefined
        ? { before: snapshot.display_name ?? UNKNOWN, after: payload.display_name }
        : null,
    rule: changesRule
      ? {
          before: choiceRuleLabel(snapshot) ?? UNKNOWN,
          after: choiceRuleLabel({ ...snapshot, ...payload }) ?? UNKNOWN,
        }
      : null,
    options: payload.options !== undefined ? diffAddonOptions(snapshot.options, payload.options) : null,
  };
}

/** "Name, Options & prices" — what an add-on edit touches, for the card's one-line summary. */
export function changedAddonFieldLabels(payload: AddonGroupChangePayload | null | undefined): string[] {
  if (!payload) return [];
  const labels: string[] = [];
  if (payload.display_name !== undefined) labels.push('Name');
  if (RULE_KEYS.some((key) => payload[key] !== undefined)) labels.push('Choice rule');
  if (payload.options !== undefined) labels.push('Options & prices');
  return labels;
}
