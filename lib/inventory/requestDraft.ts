// A stock request as it is being built (docs/INVENTORY-SPEC.md INV-D22, docs/WAREHOUSE-SPEC.md):
// each person keeps their own draft — items added from the Stock list or the
// request sheet, with a quantity each and a note — reviews it, and only then
// sends it. The draft is saved per person on the device (lib: useRequestDraft),
// so it survives closing the sheet or reloading, and on a shared POS each PIN
// operator has their own.
//
// Pure (no storage, no React) so the rules are tested directly: what a draft
// looks like when stored, how it is edited, and what the review screen shows —
// each line checked against the live stock list, with the problems that block
// sending and the warnings that don't.

import { MAX_LINES, parseQty, suggestedRequestQty, type InventoryUnit } from '@/lib/inventory/rules';

export interface RequestDraft {
  /** itemId → the quantity as typed (a string, so a half-typed "0." survives). Insertion order is kept. */
  lines: Record<string, string>;
  note: string;
}

export const EMPTY_DRAFT: RequestDraft = { lines: {}, note: '' };

export const MAX_NOTE = 300;

const STORAGE_PREFIX = 'hioc:stock-request-draft:v1:';

/** One draft per person: the key carries the user id (the PIN operator's on a shared POS). */
export function draftStorageKey(actorId: string): string {
  return `${STORAGE_PREFIX}${actorId}`;
}

/** A stored draft, or an empty one for anything missing, foreign or malformed. */
export function parseDraft(raw: string | null | undefined): RequestDraft {
  if (!raw) return { ...EMPTY_DRAFT, lines: {} };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return { ...EMPTY_DRAFT, lines: {} };
    const o = v as Record<string, unknown>;
    const lines: Record<string, string> = {};
    if (o.lines && typeof o.lines === 'object' && !Array.isArray(o.lines)) {
      for (const [k, q] of Object.entries(o.lines as Record<string, unknown>)) {
        if (typeof k === 'string' && k && (typeof q === 'string' || typeof q === 'number')) lines[k] = String(q);
        if (Object.keys(lines).length >= MAX_LINES) break;
      }
    }
    const note = typeof o.note === 'string' ? o.note.slice(0, MAX_NOTE) : '';
    return { lines, note };
  } catch {
    return { ...EMPTY_DRAFT, lines: {} };
  }
}

export function serializeDraft(draft: RequestDraft): string {
  return JSON.stringify({ lines: draft.lines, note: draft.note });
}

export function draftCount(draft: RequestDraft): number {
  return Object.keys(draft.lines).length;
}

export function isInDraft(draft: RequestDraft, itemId: string): boolean {
  return Object.prototype.hasOwnProperty.call(draft.lines, itemId);
}

/** Adds an item (keeps an existing quantity). Refused past MAX_LINES: the draft is returned unchanged. */
export function addToDraft(draft: RequestDraft, itemId: string, qty: string): RequestDraft {
  if (isInDraft(draft, itemId)) return draft;
  if (draftCount(draft) >= MAX_LINES) return draft;
  return { ...draft, lines: { ...draft.lines, [itemId]: qty } };
}

export function removeFromDraft(draft: RequestDraft, itemId: string): RequestDraft {
  if (!isInDraft(draft, itemId)) return draft;
  const lines = { ...draft.lines };
  delete lines[itemId];
  return { ...draft, lines };
}

export function setDraftQty(draft: RequestDraft, itemId: string, qty: string): RequestDraft {
  if (!isInDraft(draft, itemId)) return draft;
  return { ...draft, lines: { ...draft.lines, [itemId]: qty } };
}

export function setDraftNote(draft: RequestDraft, note: string): RequestDraft {
  return { ...draft, note: note.slice(0, MAX_NOTE) };
}

/** The parts of a stock item (InventoryItemView) a draft is checked against. */
export interface DraftItemLike {
  id: string;
  name: string;
  unit: InventoryUnit;
  isActive: boolean;
  onHand: number;
  low: boolean;
  parLevel: number;
  reorderQty: number;
  openRequestNumbers: number[];
}

/** What the request sheet pre-fills an item with: its usual request quantity, or '' (they type it). */
export function suggestedQtyText(item: Pick<DraftItemLike, 'parLevel' | 'reorderQty' | 'onHand'>): string {
  const s = suggestedRequestQty({ par_level: item.parLevel, reorder_qty: item.reorderQty }, item.onHand);
  return s > 0 ? String(s) : '';
}

/**
 * A fresh draft's starting point, as the old one-step sheet did: every low,
 * stocked item that is not already on an open request, at its usual quantity.
 */
export function seedDraftWithLowItems(items: DraftItemLike[]): RequestDraft {
  let draft: RequestDraft = { lines: {}, note: '' };
  for (const i of items) {
    if (i.isActive && i.low && i.openRequestNumbers.length === 0) draft = addToDraft(draft, i.id, suggestedQtyText(i));
  }
  return draft;
}

export interface ReviewLine {
  itemId: string;
  name: string;
  unit: InventoryUnit;
  qtyText: string;
  /** The quantity that would be sent, or null while it isn't a valid one. */
  qty: number | null;
  onHand: number;
  low: boolean;
  /** Blocks sending. */
  problem: string | null;
  /** Worth a second look, doesn't block (e.g. already on an open request). */
  warning: string | null;
}

export interface DraftReview {
  /** In the order they were added. */
  lines: ReviewLine[];
  /** Items in the draft that are gone or retired since — left out of the review and the send. */
  dropped: string[];
  /** Ready to send: at least one line and no problems. */
  ok: boolean;
  /** The first problem, for the footer ("Enter a quantity for Milk"). */
  firstProblem: string | null;
}

/** The review screen: every draft line checked against the live stock list. */
export function reviewDraft(draft: RequestDraft, items: DraftItemLike[]): DraftReview {
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines: ReviewLine[] = [];
  const dropped: string[] = [];
  for (const [itemId, qtyText] of Object.entries(draft.lines)) {
    const item = byId.get(itemId);
    if (!item || !item.isActive) {
      dropped.push(itemId);
      continue;
    }
    const qty = parseQty(qtyText);
    lines.push({
      itemId,
      name: item.name,
      unit: item.unit,
      qtyText,
      qty,
      onHand: item.onHand,
      low: item.low,
      problem: qty === null ? (qtyText.trim() === '' ? `Enter a quantity for ${item.name}.` : `The quantity for ${item.name} must be more than 0.`) : null,
      warning: item.openRequestNumbers.length > 0 ? `Already on request #${item.openRequestNumbers.join(', #')}` : null,
    });
  }
  let firstProblem = lines.find((l) => l.problem)?.problem ?? null;
  if (lines.length === 0) firstProblem = 'Add at least one item.';
  else if (lines.length > MAX_LINES) firstProblem = `A request can have at most ${MAX_LINES} items.`;
  if (draft.note.trim().length > MAX_NOTE) firstProblem = firstProblem ?? `Keep the note under ${MAX_NOTE} characters.`;
  return { lines, dropped, ok: firstProblem === null, firstProblem };
}

/** The body POST /api/inventory/requests takes, from a review that is ok. */
export function requestBodyFrom(review: DraftReview, draft: RequestDraft): { lines: { itemId: string; qty: number }[]; note: string } {
  return {
    lines: review.lines.filter((l) => l.qty !== null).map((l) => ({ itemId: l.itemId, qty: l.qty as number })),
    note: draft.note.trim(),
  };
}
