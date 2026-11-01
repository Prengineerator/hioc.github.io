import { describe, expect, it } from 'vitest';
import {
  canCancel,
  canPick,
  canReceive,
  cancellableStatuses,
  requestStatusLabel,
  type RequestActor,
  type RequestFacts,
} from '@/lib/inventory/rules';
import {
  canReceiveReturn,
  canResolve,
  lineDifference,
  ownerWaiting,
  parseDeliverer,
  parsePurchaseLines,
  parseResolveLines,
  resolutionLabel,
  resolutionOptions,
  transitByItem,
  transitLines,
  unmatchedLines,
  warehouseLow,
  warehouseSheetTable,
  type TransferLike,
} from '@/lib/inventory/warehouse';

// The warehouse's rules (docs/WAREHOUSE-SPEC.md): who may dispatch, count in
// and settle; what the screens show as in transit and unmatched; and how the
// delivery person, purchases and settlements are validated. And that every
// store-room rule is unchanged for a request without a route.

const OWNER = 'u-owner';
const MGR = 'u-mgr';
const ASHA = 'u-asha'; // requester
const VIK = 'u-vik'; // deliverer
const MEERA = 'u-meera'; // counts it in

const isId = (v: unknown): v is string => typeof v === 'string' && v.startsWith('u-');
const at = (userId: string, role: string, surface: 'pos' | 'web' = 'pos'): RequestActor => ({ userId, role, surface });
const req = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  status: 'assigned',
  requested_by: ASHA,
  assigned_to: VIK,
  picked_by: null,
  route: 'from_warehouse',
  ...over,
});

describe('dispatch (pick) from the warehouse', () => {
  it('is the warehouse side’s: the owner or a manager', () => {
    expect(canPick(req(), at(OWNER, 'owner', 'web')).ok).toBe(true);
    expect(canPick(req(), at(MGR, 'manager')).ok).toBe(true);
  });

  it('is never the delivery person’s alone — they are what the counts check', () => {
    const v = canPick(req(), at(VIK, 'staff'));
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it('needs a delivery person first', () => {
    expect(canPick(req({ status: 'requested', assigned_to: null }), at(OWNER, 'owner'))).toEqual({
      ok: false,
      status: 409,
      message: 'Choose who delivers it before dispatching.',
    });
  });

  it('a return has no pick step', () => {
    expect(canPick(req({ route: 'to_warehouse', status: 'picked' }), at(MGR, 'manager'))).toMatchObject({ ok: false, status: 409 });
  });

  it('a store-room request is unchanged: the assignee picks, plain staff included', () => {
    expect(canPick(req({ route: 'store_room' }), at(VIK, 'staff')).ok).toBe(true);
    expect(canPick(req({ route: undefined }), at(VIK, 'staff')).ok).toBe(true);
    expect(canPick(req({ route: 'store_room' }), at(ASHA, 'staff')).ok).toBe(false);
  });
});

describe('count-in at the POS', () => {
  const sent = req({ status: 'picked', picked_by: OWNER });

  it('is someone other than the delivery person', () => {
    expect(canReceive(sent, at(MEERA, 'staff')).ok).toBe(true);
    expect(canReceive(sent, at(VIK, 'staff'))).toMatchObject({ ok: false, status: 403 });
  });

  it('a manager may count in their own delivery (a small team)', () => {
    expect(canReceive(req({ status: 'picked', assigned_to: MGR, picked_by: MGR }), at(MGR, 'manager')).ok).toBe(true);
  });

  it('is at the POS only', () => {
    expect(canReceive(sent, at(MEERA, 'staff', 'web'))).toMatchObject({ ok: false, status: 403 });
  });

  it('a return is counted in at the warehouse, never at the POS', () => {
    expect(canReceive(req({ route: 'to_warehouse', status: 'picked' }), at(MGR, 'manager'))).toMatchObject({
      ok: false,
      message: 'The owner counts a return in at the warehouse.',
    });
  });

  it('a store-room request ignores who was assigned (only the picker is excluded)', () => {
    expect(canReceive(req({ route: 'store_room', status: 'picked', picked_by: ASHA }), at(VIK, 'staff')).ok).toBe(true);
  });
});

describe('cancel', () => {
  it('a warehouse transfer on the road can’t be cancelled — count it in and settle', () => {
    const v = canCancel(req({ status: 'picked' }), at(OWNER, 'owner'));
    expect(v).toMatchObject({ ok: false, status: 409 });
    expect((v as { message: string }).message).toMatch(/Count it in at the POS/);
    expect(canCancel(req({ route: 'to_warehouse', status: 'picked' }), at(OWNER, 'owner'))).toMatchObject({ ok: false, status: 409 });
  });

  it('before it leaves, the usual rules apply', () => {
    expect(canCancel(req(), at(MGR, 'manager')).ok).toBe(true);
    expect(canCancel(req({ status: 'requested', assigned_to: null }), at(ASHA, 'staff')).ok).toBe(true);
    expect(canCancel(req(), at(ASHA, 'staff')).ok).toBe(false);
  });

  it('the write guard leaves out "picked" for a warehouse route only', () => {
    expect(cancellableStatuses('from_warehouse')).toEqual(['requested', 'assigned']);
    expect(cancellableStatuses('store_room')).toEqual(['requested', 'assigned', 'picked']);
    expect(cancellableStatuses(undefined)).toEqual(['requested', 'assigned', 'picked']);
  });
});

describe('the owner’s steps', () => {
  const ret = { route: 'to_warehouse' as const, status: 'picked' as const, hasDiscrepancy: false, resolvedAt: null };
  it('counting a return in is the owner’s', () => {
    expect(canReceiveReturn(ret, { role: 'owner' }).ok).toBe(true);
    expect(canReceiveReturn(ret, { role: 'manager' })).toMatchObject({ ok: false, status: 403 });
    expect(canReceiveReturn({ ...ret, route: 'from_warehouse' }, { role: 'owner' })).toMatchObject({ ok: false, status: 409 });
    expect(canReceiveReturn({ ...ret, status: 'received' }, { role: 'owner' })).toMatchObject({ ok: false, status: 409 });
  });

  it('settling is the owner’s, once, only for a received transfer that arrived different', () => {
    const t = { route: 'from_warehouse' as const, status: 'received' as const, hasDiscrepancy: true, resolvedAt: null };
    expect(canResolve(t, { role: 'owner' }).ok).toBe(true);
    expect(canResolve(t, { role: 'manager' }).ok).toBe(false);
    expect(canResolve({ ...t, hasDiscrepancy: false }, { role: 'owner' }).ok).toBe(false);
    expect(canResolve({ ...t, resolvedAt: '2026-11-01T00:00:00Z' }, { role: 'owner' }).ok).toBe(false);
    expect(canResolve({ ...t, status: 'picked' }, { role: 'owner' }).ok).toBe(false);
    expect(canResolve({ ...t, route: 'store_room' }, { role: 'owner' }).ok).toBe(false);
  });
});

describe('settlements', () => {
  it('a short line is lost or never left; an over line is taken off the origin or accepted', () => {
    expect(resolutionOptions(2)).toEqual(['lost', 'back_to_origin']);
    expect(resolutionOptions(-1)).toEqual(['origin_sent_extra', 'accepted']);
    expect(resolutionOptions(0)).toEqual([]);
  });

  it('reads the right way round for each direction', () => {
    expect(resolutionLabel('back_to_origin', 'from_warehouse')).toMatch(/back in the warehouse/);
    expect(resolutionLabel('back_to_origin', 'to_warehouse')).toMatch(/back on the store shelf/);
    expect(resolutionLabel('origin_sent_extra', 'to_warehouse')).toMatch(/^The store sent more/);
    expect(resolutionLabel('accepted', 'from_warehouse')).toMatch(/leave the warehouse as it is/);
  });

  it('difference is sent minus arrived, to three decimals', () => {
    expect(lineDifference({ qtyPicked: 0.3, qtyReceived: 0.1 })).toBe(0.2);
    expect(lineDifference({ qtyPicked: 5, qtyReceived: 6 })).toBe(-1);
    expect(lineDifference({ qtyPicked: null, qtyReceived: null })).toBe(0);
  });

  const mismatched = [
    { itemId: 'milk', itemName: 'Milk', difference: 2 },
    { itemId: 'cups', itemName: 'Cups', difference: -10 },
  ];
  it('takes every mismatched line exactly once, with a fitting answer', () => {
    const ok = parseResolveLines(
      [
        { itemId: 'milk', resolution: 'lost' },
        { itemId: 'cups', resolution: 'accepted' },
      ],
      mismatched,
    );
    expect(ok).toEqual({ ok: true, lines: [{ itemId: 'milk', resolution: 'lost' }, { itemId: 'cups', resolution: 'accepted' }] });
  });
  it('refuses a missing line, a matched line, a repeat, and an answer that doesn’t fit', () => {
    expect(parseResolveLines([{ itemId: 'milk', resolution: 'lost' }], mismatched).ok).toBe(false);
    expect(parseResolveLines([{ itemId: 'beans', resolution: 'lost' }], mismatched).ok).toBe(false);
    expect(
      parseResolveLines(
        [
          { itemId: 'milk', resolution: 'lost' },
          { itemId: 'milk', resolution: 'lost' },
        ],
        mismatched,
      ).ok,
    ).toBe(false);
    const wrong = parseResolveLines(
      [
        { itemId: 'milk', resolution: 'accepted' },
        { itemId: 'cups', resolution: 'accepted' },
      ],
      mismatched,
    );
    expect(wrong).toEqual({ ok: false, message: 'Milk arrived short: say whether it was lost or never left.' });
    expect(parseResolveLines('nope', mismatched).ok).toBe(false);
  });
});

describe('the delivery person', () => {
  it('a team member by id', () => {
    expect(parseDeliverer({ assigneeId: VIK }, isId)).toEqual({ ok: true, deliverer: { kind: 'member', userId: VIK } });
  });
  it('someone without a login, by name, with an optional Indian mobile stored as +91…', () => {
    expect(parseDeliverer({ deliverer: { name: '  Ravi   (driver) ', phone: '098123 45678' } }, isId)).toEqual({
      ok: true,
      deliverer: { kind: 'outside', name: 'Ravi (driver)', phone: '+919812345678' },
    });
    expect(parseDeliverer({ deliverer: { name: 'Ravi' } }, isId)).toEqual({ ok: true, deliverer: { kind: 'outside', name: 'Ravi', phone: '' } });
  });
  it('exactly one of the two, a real name, and a real number', () => {
    expect(parseDeliverer({}, isId).ok).toBe(false);
    expect(parseDeliverer({ assigneeId: VIK, deliverer: { name: 'Ravi' } }, isId).ok).toBe(false);
    expect(parseDeliverer({ deliverer: { name: 'R' } }, isId).ok).toBe(false);
    expect(parseDeliverer({ deliverer: { name: 'x'.repeat(61) } }, isId).ok).toBe(false);
    expect(parseDeliverer({ deliverer: { name: 'Ravi', phone: '12345' } }, isId)).toEqual({
      ok: false,
      message: 'That phone number is not a valid Indian mobile.',
    });
    expect(parseDeliverer({ deliverer: { name: 'Ravi', phone: '+6581234567' } }, isId).ok).toBe(false);
    expect(parseDeliverer({ assigneeId: 'not-an-id' }, isId).ok).toBe(false);
  });
});

describe('purchases into the warehouse', () => {
  const items = new Map([
    ['milk', { id: 'milk', name: 'Milk', tracks_expiry: true }],
    ['cups', { id: 'cups', name: 'Cups', tracks_expiry: false }],
  ]);
  const today = '2026-11-01';
  it('one batch per line — the same item twice is two batches', () => {
    const r = parsePurchaseLines(
      [
        { itemId: 'milk', qty: '10', expiryDate: '2026-11-10' },
        { itemId: 'milk', qty: 5, expiryDate: '2026-11-04' },
        { itemId: 'cups', qty: 500 },
      ],
      items,
      today,
    );
    expect(r).toEqual({
      ok: true,
      lines: [
        { itemId: 'milk', qty: 10, expiryDate: '2026-11-10' },
        { itemId: 'milk', qty: 5, expiryDate: '2026-11-04' },
        { itemId: 'cups', qty: 500, expiryDate: null },
      ],
    });
  });
  it('a perishable needs a date, which can’t be past; quantities > 0; items must be stocked', () => {
    expect(parsePurchaseLines([{ itemId: 'milk', qty: 1 }], items, today)).toEqual({ ok: false, message: 'Enter the expiry date for Milk.' });
    expect(parsePurchaseLines([{ itemId: 'milk', qty: 1, expiryDate: '2026-10-31' }], items, today).ok).toBe(false);
    expect(parsePurchaseLines([{ itemId: 'milk', qty: 1, expiryDate: '2026-11-01' }], items, today).ok).toBe(true);
    expect(parsePurchaseLines([{ itemId: 'cups', qty: 0 }], items, today).ok).toBe(false);
    expect(parsePurchaseLines([{ itemId: 'gone', qty: 1 }], items, today).ok).toBe(false);
    expect(parsePurchaseLines([], items, today).ok).toBe(false);
    expect(parsePurchaseLines([{ itemId: 'milk', qty: 1, expiryDate: '2026-02-30' }], items, today).ok).toBe(false);
  });
});

describe('in transit, unmatched, and what waits on the owner', () => {
  const t = (over: Partial<TransferLike>): TransferLike => ({
    id: 'r',
    number: 1,
    route: 'from_warehouse',
    status: 'picked',
    pickedAt: '2026-11-01T05:00:00Z',
    receivedAt: null,
    hasDiscrepancy: false,
    resolvedAt: null,
    deliveredBy: 'Vikram',
    lines: [],
    ...over,
  });
  const milk = (sent: number | null, arrived: number | null = null) => ({
    itemId: 'milk',
    itemName: 'Milk',
    unit: 'l',
    qtyPicked: sent,
    qtyReceived: arrived,
    dispatchExpiry: '2026-11-05',
  });
  const transfers: TransferLike[] = [
    t({ id: 'a', number: 3, lines: [milk(10), { ...milk(0), itemId: 'cups', itemName: 'Cups' }] }),
    t({ id: 'b', number: 4, route: 'to_warehouse', pickedAt: '2026-11-01T03:00:00Z', lines: [milk(2)] }),
    t({ id: 'c', number: 5, status: 'received', hasDiscrepancy: true, receivedAt: '2026-10-31T10:00:00Z', lines: [milk(6, 5), { ...milk(1, 1), itemId: 'beans', itemName: 'Beans' }] }),
    t({ id: 'd', number: 6, status: 'received', hasDiscrepancy: true, resolvedAt: '2026-10-31T12:00:00Z', lines: [milk(6, 5)] }),
    t({ id: 'e', number: 7, status: 'requested', pickedAt: null, lines: [milk(null)] }),
    t({ id: 'f', number: 8, status: 'assigned', pickedAt: null, lines: [milk(null)] }),
    t({ id: 'g', number: 9, route: 'store_room', lines: [milk(3)] }),
  ];

  it('transit is every sent line not yet counted in, warehouse routes only, oldest first, zero lines left out', () => {
    expect(transitLines(transfers).map((l) => [l.number, l.route, l.itemId, l.qty])).toEqual([
      [4, 'to_warehouse', 'milk', 2],
      [3, 'from_warehouse', 'milk', 10],
    ]);
  });

  it('per item, split by direction', () => {
    expect(transitByItem(transfers).get('milk')).toEqual({ toStore: 10, toWarehouse: 2 });
    expect(transitByItem(transfers).has('cups')).toBe(false);
  });

  it('unmatched is the unsettled lines that differ — a settled transfer and a matching line drop out', () => {
    expect(unmatchedLines(transfers)).toEqual([
      expect.objectContaining({ number: 5, itemId: 'milk', sent: 6, arrived: 5, difference: 1 }),
    ]);
  });

  it('waiting on the owner: assign, dispatch, count a return in, settle', () => {
    expect(ownerWaiting(transfers)).toEqual({ toAssign: 1, toDispatch: 1, toReceive: 1, toSettle: 1, total: 4 });
  });
});

describe('labels, low, and the CSV', () => {
  it('statuses read per route; a store-room request reads as before', () => {
    expect(requestStatusLabel('picked', 'from_warehouse')).toBe('On the way — verify at POS');
    expect(requestStatusLabel('picked', 'to_warehouse')).toBe('On the way to the warehouse');
    expect(requestStatusLabel('picked', 'store_room')).toBe('Picked — verify at POS');
    expect(requestStatusLabel('picked')).toBe('Picked — verify at POS');
  });

  it('warehouse low is at or below its own par; 0 = never', () => {
    expect(warehouseLow(5, 5)).toBe(true);
    expect(warehouseLow(5.001, 5)).toBe(false);
    expect(warehouseLow(0, 0)).toBe(false);
  });

  it('the sheet as a table, sorted by category then name, status spelled out', () => {
    const w = { onHand: 0, parLevel: 0, low: false, countNeeded: false, shortfall: 0, expiredQty: 0, soonQty: 0, nextExpiry: null };
    const table = warehouseSheetTable([
      { name: 'Sugar', unit: 'pcs', category: 'Packaging', isActive: true, warehouse: { ...w, onHand: 10 }, storeOnHand: 4, inTransit: { toStore: 0, toWarehouse: 0 }, awaitingDispatch: 0 },
      { name: 'Cups', unit: 'pcs', category: 'Packaging', isActive: true, warehouse: { ...w, low: true, parLevel: 500, countNeeded: true, shortfall: 100 }, storeOnHand: 900, inTransit: { toStore: 0, toWarehouse: 200 }, awaitingDispatch: 500 },
      { name: 'Milk', unit: 'l', category: 'Dairy', isActive: true, warehouse: { ...w, onHand: 14, nextExpiry: '2026-11-04' }, storeOnHand: 6, inTransit: { toStore: 10, toWarehouse: 0 }, awaitingDispatch: 0 },
    ]);
    expect(table.columns[3]).toBe('Warehouse on hand');
    expect(table.rows.map((r) => r[1])).toEqual(['Milk', 'Cups', 'Sugar']);
    expect(table.rows[1][5]).toBe('Count needed (100 unrecorded); Low — buy');
    expect(table.rows[0][8]).toBe('2026-11-04');
    expect(table.rows[0][9]).toBe(10);
    expect(table.rows[1][10]).toBe(200);
  });
});
