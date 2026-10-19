import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeMenuAdmin, uuid, type Row } from './helpers/fakeMenuAdmin';
import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';

// Two guards around approving a menu change (see tests/menuChangeRequests.test.ts
// for the rest of the flow, same in-memory database):
//   - a create that fails after the item row exists leaves nothing behind, so a
//     retry makes the item once;
//   - approving an edit refuses (409 stale, request still pending) when the item
//     was changed after the request was made, unless the owner forces it.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  owner: { id: string } | null;
  db: ReturnType<typeof makeFakeMenuAdmin>;
  tables: Record<string, Row[]>;
  fail: ((table: string, op: string, payload: unknown) => { code?: string; message: string } | null) | null;
} = { actor: null, owner: null, db: makeFakeMenuAdmin({}), tables: {}, fail: null };

vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  getOwnerUser: () => Promise.resolve(state.owner),
}));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({ from: (table: string) => state.db.from(table) }),
}));

const ITEM = uuid(1);
const OTHER_ITEM = uuid(2);
const G1 = uuid(11);
const G2 = uuid(12);

const { POST: staffCreate } = await import('@/app/api/menu/route');
const { PATCH: staffPatch } = await import('@/app/api/menu/[id]/route');
const { POST: ownerCreate } = await import('@/app/api/owner/menu/route');
const { PATCH: ownerPatch } = await import('@/app/api/owner/menu/[id]/route');
const { PATCH: decide } = await import('@/app/api/owner/menu-requests/[id]/route');

function seed(): Record<string, Row[]> {
  const base = {
    description: 'Milky',
    category: 'Coffee',
    parent_category: 'Hot',
    is_veg: true,
    is_available: true,
    sort_order: 50,
    image_url: '',
    unavailable_until: null,
    in_store_only: false,
    gst_exempt: false,
  };
  return {
    menu_items: [
      { id: ITEM, name: 'Latte', short_code: 'LAT', ...base },
      { id: OTHER_ITEM, name: 'Mocha', short_code: 'MOC', ...base },
    ],
    menu_item_variants: [
      { id: uuid(22), menu_item_id: ITEM, label: 'Large', price_inr: 180, sort_order: 10 },
      { id: uuid(21), menu_item_id: ITEM, label: 'Regular', price_inr: 150, sort_order: 0 },
      { id: uuid(23), menu_item_id: OTHER_ITEM, label: 'Regular', price_inr: 200, sort_order: 0 },
    ],
    menu_item_addon_groups: [{ menu_item_id: ITEM, addon_group_id: G1 }],
    addon_groups: [
      { id: G1, name: 'Milk', sort_order: 0 },
      { id: G2, name: 'Syrup', sort_order: 10 },
    ],
    addon_options: [],
    profiles: [{ id: 'ravi', name: 'Ravi', role: 'staff' }],
    menu_change_requests: [],
  };
}

let clock = 0;

beforeEach(() => {
  clock = 0;
  state.tables = seed();
  state.fail = null;
  state.db = makeFakeMenuAdmin(state.tables, {
    unique: { menu_items: ['short_code'] },
    fail: (table, op, payload) => state.fail?.(table, op, payload) ?? null,
    defaults: (table, row) =>
      table === 'menu_change_requests'
        ? {
            menu_item_id: null,
            payload: null,
            snapshot: null,
            status: 'pending',
            requested_by_name: null,
            requested_at: new Date(Date.UTC(2026, 9, 19, 6, 0, ++clock)).toISOString(),
            decided_by: null,
            decided_at: null,
            decision_note: null,
            ...row,
          }
        : row,
  });
  state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
  state.owner = { id: 'owner-1' };
});

// -- helpers ----------------------------------------------------------------

function jsonReq(method: string, url: string, body?: unknown) {
  return new Request(`https://hioc.in${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: { id } });
const read = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

const requests = () => state.tables.menu_change_requests as unknown as MenuChangeRequest[];
const menuItem = (id: string) => state.tables.menu_items.find((r) => r.id === id);
const sizesOf = (id: string) =>
  state.tables.menu_item_variants
    .filter((v) => v.menu_item_id === id)
    .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
    .map((v) => [v.label, v.price_inr]);
const addonsOf = (id: string) => state.tables.menu_item_addon_groups.filter((l) => l.menu_item_id === id).map((l) => l.addon_group_id);

const staffEdit = async (body: unknown) =>
  (await read<{ request: MenuChangeRequest }>(await staffPatch(jsonReq('PATCH', `/api/menu/${ITEM}`, body), ctx(ITEM)))).request;
const ownerEdit = (body: unknown) => ownerPatch(jsonReq('PATCH', `/api/owner/menu/${ITEM}`, body), ctx(ITEM));
const approve = (id: string, extra: Record<string, unknown> = {}) =>
  decide(jsonReq('PATCH', `/api/owner/menu-requests/${id}`, { action: 'approve', ...extra }), ctx(id));

const NEW_ITEM = { name: 'Flat White', category: 'Coffee', variants: [{ label: 'Regular', price_inr: 170 }], addon_group_ids: [G1] };

// Fail the first read of menu_items (the read-back after an insert), then behave.
function failReadBackOnce() {
  let failed = false;
  state.fail = (table, op) => {
    if (failed || table !== 'menu_items' || op !== 'select') return null;
    failed = true;
    return { message: 'boom' };
  };
}

// ---------------------------------------------------------------------------
// A create that cannot be read back leaves nothing behind
// ---------------------------------------------------------------------------

describe('a create whose read-back fails', () => {
  it('rolls the item back when the owner creates it directly', async () => {
    failReadBackOnce();
    const res = await ownerCreate(jsonReq('POST', '/api/owner/menu', NEW_ITEM));
    expect(res.status).toBe(500);
    expect(state.tables.menu_items).toHaveLength(2);
    expect(state.tables.menu_item_variants.filter((v) => v.label === 'Regular' && v.price_inr === 170)).toHaveLength(0);
    expect(state.tables.menu_item_addon_groups).toHaveLength(1);
  });

  it('leaves the approval pending with no item, and the retry creates exactly one', async () => {
    const pending = (await read<{ request: MenuChangeRequest }>(await staffCreate(jsonReq('POST', '/api/menu', { ...NEW_ITEM, short_code: 'fw' })))).request;

    failReadBackOnce();
    const failed = await approve(pending.id);
    expect(failed.status).toBe(500);
    expect(requests()[0]).toMatchObject({ status: 'pending', decided_by: null, menu_item_id: null });
    expect(state.tables.menu_items).toHaveLength(2);

    // The short code is free again, so the retry is not a 409 and not a duplicate.
    const retried = await approve(pending.id);
    expect(retried.status).toBe(200);
    expect(state.tables.menu_items.filter((i) => i.name === 'Flat White')).toHaveLength(1);
    expect(state.tables.menu_items).toHaveLength(3);
    expect(requests()[0].status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Approving an edit of an item that has changed since
// ---------------------------------------------------------------------------

describe('approving an edit after the item was changed', () => {
  const REPRICED = [
    { label: 'Regular', price_inr: 160 },
    { label: 'Large', price_inr: 180 },
  ];

  it('409s stale with the changed fields and leaves the request pending and the menu alone', async () => {
    const pending = await staffEdit({ name: 'Oat Latte', variants: REPRICED });
    // The owner reprices the sizes from /owner/menu in the meantime.
    expect(
      (await ownerEdit({ variants: [{ label: 'Regular', price_inr: 155 }, { label: 'Large', price_inr: 185 }] })).status,
    ).toBe(200);

    const res = await approve(pending.id, { note: 'go' });
    expect(res.status).toBe(409);
    const body = await read<{ error: string; stale: boolean; fields: string[] }>(res);
    expect(body.stale).toBe(true);
    expect(body.fields).toEqual(['variants']);
    expect(body.error).toContain('changed after the request was made (sizes & prices)');
    expect(body.error).toContain('approve anyway or reject');

    expect(requests()[0]).toMatchObject({ status: 'pending', decided_by: null, decided_at: null, decision_note: null });
    expect(menuItem(ITEM)?.name).toBe('Latte');
    expect(sizesOf(ITEM)).toEqual([['Regular', 155], ['Large', 185]]);
  });

  it('names every payload field that moved, and sizes that were only reordered count', async () => {
    const pending = await staffEdit({ name: 'Oat Latte', variants: REPRICED });
    await ownerEdit({ name: 'Latte Deluxe', variants: [{ label: 'Large', price_inr: 180 }, { label: 'Regular', price_inr: 150 }] });

    const body = await read<{ error: string; stale: boolean; fields: string[] }>(await approve(pending.id));
    expect([...body.fields].sort()).toEqual(['name', 'variants']);
    expect(body.error).toMatch(/\((name, sizes & prices|sizes & prices, name)\)/);
    expect(requests()[0].status).toBe('pending');
  });

  it('applies it when the owner approves anyway with force', async () => {
    const pending = await staffEdit({ name: 'Oat Latte', variants: REPRICED });
    await ownerEdit({ variants: [{ label: 'Regular', price_inr: 155 }, { label: 'Large', price_inr: 185 }] });
    expect((await approve(pending.id)).status).toBe(409);

    const res = await approve(pending.id, { force: true });
    expect(res.status).toBe(200);
    expect((await read<{ request: MenuChangeRequest }>(res)).request.status).toBe('approved');
    expect(menuItem(ITEM)?.name).toBe('Oat Latte');
    expect(sizesOf(ITEM)).toEqual([['Regular', 160], ['Large', 180]]);
    expect(requests()[0].status).toBe('approved');
  });

  it('does not block on a field the payload does not name', async () => {
    const pending = await staffEdit({ name: 'Oat Latte' });
    // sort order, description, sizes and add-ons all changed directly; the request only renames.
    await ownerEdit({
      sort_order: 70,
      description: 'Now with oat',
      variants: [{ label: 'Regular', price_inr: 155 }],
      addon_group_ids: [G2],
    });

    const res = await approve(pending.id);
    expect(res.status).toBe(200);
    expect(menuItem(ITEM)).toMatchObject({ name: 'Oat Latte', sort_order: 70, description: 'Now with oat' });
    expect(sizesOf(ITEM)).toEqual([['Regular', 155]]);
    expect(addonsOf(ITEM)).toEqual([G2]);
  });

  it('is not tripped by the owner re-saving the same sizes and add-ons', async () => {
    const pending = await staffEdit({ variants: REPRICED, addon_group_ids: [G1, G2] });
    // Saved again unchanged: the size rows are rewritten, the link rows too, but the values are the same.
    await ownerEdit({ variants: [{ label: 'Regular', price_inr: 150 }, { label: 'Large', price_inr: 180 }], addon_group_ids: [G1] });

    expect((await approve(pending.id)).status).toBe(200);
    expect(sizesOf(ITEM)).toEqual([['Regular', 160], ['Large', 180]]);
    expect([...addonsOf(ITEM)].sort()).toEqual([G1, G2].sort());
  });

  it('reads add-on groups as a set when checking', async () => {
    // Seed a second link so the snapshot holds two groups, in one order.
    state.tables.menu_item_addon_groups.push({ menu_item_id: ITEM, addon_group_id: G2 });
    const pending = await staffEdit({ addon_group_ids: [G2] });
    await ownerEdit({ addon_group_ids: [G2, G1] }); // same set, other order

    expect((await approve(pending.id)).status).toBe(200);
    expect(addonsOf(ITEM)).toEqual([G2]);
  });

  it('flags an add-on group added since', async () => {
    const pending = await staffEdit({ addon_group_ids: [] });
    await ownerEdit({ addon_group_ids: [G1, G2] });

    const res = await approve(pending.id);
    expect(res.status).toBe(409);
    expect((await read<{ fields: string[] }>(res)).fields).toEqual(['addon_group_ids']);
    expect(addonsOf(ITEM).sort()).toEqual([G1, G2].sort());
  });

  it('approves normally when nothing changed', async () => {
    const pending = await staffEdit({ name: 'Oat Latte' });
    expect((await approve(pending.id)).status).toBe(200);
    expect(menuItem(ITEM)?.name).toBe('Oat Latte');
  });

  it('still says the item is gone, not stale, once it has been deleted', async () => {
    const pending = await staffEdit({ name: 'Oat Latte' });
    state.tables.menu_items.splice(0, state.tables.menu_items.length, ...state.tables.menu_items.filter((r) => r.id !== ITEM));
    const res = await approve(pending.id);
    expect(res.status).toBe(409);
    const body = await read<{ error: string; stale?: boolean }>(res);
    expect(body.error).toContain('no longer on the menu');
    expect(body.stale).toBeUndefined();
  });

  it('rejects a force that is not a boolean', async () => {
    const pending = await staffEdit({ name: 'Oat Latte' });
    const res = await approve(pending.id, { force: 'yes' });
    expect(res.status).toBe(400);
    expect(requests()[0].status).toBe('pending');
  });
});
