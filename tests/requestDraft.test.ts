import { describe, expect, it } from 'vitest';
import {
  addToDraft,
  draftCount,
  draftStorageKey,
  EMPTY_DRAFT,
  isInDraft,
  parseDraft,
  removeFromDraft,
  requestBodyFrom,
  reviewDraft,
  seedDraftWithLowItems,
  serializeDraft,
  setDraftNote,
  setDraftQty,
  suggestedQtyText,
  type DraftItemLike,
  type RequestDraft,
} from '@/lib/inventory/requestDraft';

// The request draft (lib/inventory/requestDraft.ts, INV-D22): each person builds
// their own list of items, reviews it, and only then sends it. Pinned: one
// stored draft per person, tolerant of anything malformed in storage; editing
// keeps the order things were added in; the review checks each line against
// the live stock list (problems block sending, warnings don't, retired items
// drop out); and what is sent is exactly what was reviewed.

const item = (over: Partial<DraftItemLike> & { id: string; name: string }): DraftItemLike => ({
  unit: 'pcs',
  isActive: true,
  onHand: 10,
  low: false,
  parLevel: 0,
  reorderQty: 0,
  openRequestNumbers: [],
  ...over,
});

const MILK = item({ id: 'milk', name: 'Milk', unit: 'l', onHand: 2, low: true, parLevel: 5, reorderQty: 10 });
const CUPS = item({ id: 'cups', name: 'Cups', onHand: 40, low: true, parLevel: 100 });
const BEANS = item({ id: 'beans', name: 'Beans', unit: 'g', onHand: 900, openRequestNumbers: [7] });
const OLD = item({ id: 'old', name: 'Old syrup', isActive: false, low: true });
const ITEMS = [MILK, CUPS, BEANS, OLD];

describe('storage: one draft per person', () => {
  it('keys the draft by the user id, so two PIN operators on one POS never share one', () => {
    expect(draftStorageKey('u-asha')).not.toBe(draftStorageKey('u-vikram'));
    expect(draftStorageKey('u-asha')).toContain('u-asha');
  });

  it('round-trips, keeping the order items were added in', () => {
    let d: RequestDraft = { ...EMPTY_DRAFT, lines: {} };
    d = addToDraft(d, 'cups', '100');
    d = addToDraft(d, 'milk', '10');
    d = setDraftNote(d, 'before 5pm');
    const back = parseDraft(serializeDraft(d));
    expect(back).toEqual(d);
    expect(Object.keys(back.lines)).toEqual(['cups', 'milk']);
  });

  it('reads anything missing, malformed or foreign as an empty draft', () => {
    for (const raw of [null, undefined, '', 'not json', '42', '[]', '{"lines":[1,2]}', '{"lines":"x"}']) {
      expect(parseDraft(raw as string | null)).toEqual({ lines: {}, note: '' });
    }
    expect(parseDraft('{"lines":{"milk":5,"cups":"x","bad":{}},"note":7}')).toEqual({ lines: { milk: '5', cups: 'x' }, note: '' });
  });
});

describe('editing', () => {
  it('adds once (an existing quantity is kept), sets, and removes', () => {
    let d = addToDraft(EMPTY_DRAFT, 'milk', '10');
    d = addToDraft(d, 'milk', '99');
    expect(d.lines).toEqual({ milk: '10' });
    d = setDraftQty(d, 'milk', '12.5');
    expect(d.lines.milk).toBe('12.5');
    expect(setDraftQty(d, 'cups', '1')).toBe(d); // not in the draft: unchanged
    d = removeFromDraft(d, 'milk');
    expect(draftCount(d)).toBe(0);
    expect(isInDraft(d, 'milk')).toBe(false);
  });

  it('never edits in place (React state stays honest)', () => {
    const d = addToDraft(EMPTY_DRAFT, 'milk', '10');
    const before = JSON.stringify(d);
    setDraftQty(d, 'milk', '3');
    removeFromDraft(d, 'milk');
    setDraftNote(d, 'x');
    expect(JSON.stringify(d)).toBe(before);
    expect(EMPTY_DRAFT).toEqual({ lines: {}, note: '' });
  });

  it('stops at 60 items, like a request', () => {
    let d: RequestDraft = { lines: {}, note: '' };
    for (let n = 0; n < 65; n += 1) d = addToDraft(d, `i${n}`, '1');
    expect(draftCount(d)).toBe(60);
  });

  it('caps the note at 300 characters', () => {
    expect(setDraftNote(EMPTY_DRAFT, 'x'.repeat(400)).note).toHaveLength(300);
  });
});

describe('a fresh request is seeded with the low items', () => {
  it('low, stocked, not already requested — at the usual quantity', () => {
    const d = seedDraftWithLowItems(ITEMS);
    expect(d.lines).toEqual({ milk: '10', cups: '60' }); // milk: reorder qty; cups: up to par
  });
  it('the suggested quantity is blank when there is nothing to suggest', () => {
    expect(suggestedQtyText(BEANS)).toBe('');
  });
});

describe('review', () => {
  it('shows each line with its quantity, store stock and warnings, in the order added', () => {
    let d = addToDraft(EMPTY_DRAFT, 'beans', '1000');
    d = addToDraft(d, 'milk', '10');
    const r = reviewDraft(d, ITEMS);
    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => [l.itemId, l.qty, l.onHand])).toEqual([
      ['beans', 1000, 900],
      ['milk', 10, 2],
    ]);
    expect(r.lines[0].warning).toBe('Already on request #7'); // a warning, not a block
    expect(r.lines[1].low).toBe(true);
  });

  it('a missing or zero quantity blocks sending, with the item named', () => {
    let d = addToDraft(EMPTY_DRAFT, 'milk', '');
    d = addToDraft(d, 'cups', '0');
    const r = reviewDraft(d, ITEMS);
    expect(r.ok).toBe(false);
    expect(r.firstProblem).toBe('Enter a quantity for Milk.');
    expect(r.lines[1].problem).toBe('The quantity for Cups must be more than 0.');
  });

  it('an empty draft cannot be sent', () => {
    expect(reviewDraft(EMPTY_DRAFT, ITEMS)).toMatchObject({ ok: false, firstProblem: 'Add at least one item.' });
  });

  it('an item retired or deleted since it was added drops out of the review and the send', () => {
    let d = addToDraft(EMPTY_DRAFT, 'old', '1');
    d = addToDraft(d, 'gone', '1');
    d = addToDraft(d, 'cups', '5');
    const r = reviewDraft(d, ITEMS);
    expect(r.dropped).toEqual(['old', 'gone']);
    expect(r.lines.map((l) => l.itemId)).toEqual(['cups']);
    expect(r.ok).toBe(true);
  });

  it('sends exactly what was reviewed: quantities as numbers, the note trimmed', () => {
    let d = addToDraft(EMPTY_DRAFT, 'milk', '10.25');
    d = addToDraft(d, 'cups', '100');
    d = setDraftNote(d, '  for the weekend  ');
    const r = reviewDraft(d, ITEMS);
    expect(requestBodyFrom(r, d)).toEqual({
      lines: [
        { itemId: 'milk', qty: 10.25 },
        { itemId: 'cups', qty: 100 },
      ],
      note: 'for the weekend',
    });
  });
});
