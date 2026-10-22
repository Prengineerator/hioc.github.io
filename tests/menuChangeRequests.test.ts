import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeMenuAdmin, uuid, type Row } from './helpers/fakeMenuAdmin';
import type { MenuChangeRequest, MenuItemChangePayload, MenuItemChangeRequest } from '@/lib/menu/changeRequestTypes';

// Menu changes need the owner's approval (supabase/2026-10-menu-change-requests.sql).
// A create / edit / delete by staff or a manager on the POS is stored as a
// pending request (202) and the owner approves or rejects it from the owner app;
// the owner's own edits, and sold-out / snooze toggles, still apply at once.
// The routes below run against an in-memory database (helpers/fakeMenuAdmin.ts),
// so the real validators, writers, claim and rollback code is what is tested.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  owner: { id: string } | null;
  permitted: boolean;
  db: ReturnType<typeof makeFakeMenuAdmin>;
  tables: Record<string, Row[]>;
  fail: ((table: string, op: string, payload: unknown) => { code?: string; message: string } | null) | null;
} = { actor: null, owner: null, permitted: true, db: makeFakeMenuAdmin({}), tables: {}, fail: null };

vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  getOwnerUser: () => Promise.resolve(state.owner),
}));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(state.permitted) }));
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => state.db.from(table),
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://x/menu-images/f.jpg' } }),
      }),
    },
  }),
}));

const ITEM = uuid(1);
const OTHER_ITEM = uuid(2);
const G1 = uuid(11);
const G2 = uuid(12);

const { POST: staffCreate } = await import('@/app/api/menu/route');
const { PATCH: staffPatch, DELETE: staffDelete } = await import('@/app/api/menu/[id]/route');
const { GET: listMine } = await import('@/app/api/menu/requests/route');
const { DELETE: cancelRequest } = await import('@/app/api/menu/requests/[id]/route');
const { POST: ownerCreate } = await import('@/app/api/owner/menu/route');
const { PATCH: ownerPatch, DELETE: ownerDelete } = await import('@/app/api/owner/menu/[id]/route');
const { POST: ownerUpload } = await import('@/app/api/owner/menu/upload/route');
const { GET: ownerList } = await import('@/app/api/owner/menu-requests/route');
const { PATCH: decide } = await import('@/app/api/owner/menu-requests/[id]/route');
const {
  createPayloadFromValues,
  diffChangePayload,
  isAvailabilityOnly,
  snapshotFromRow,
} = await import('@/lib/menu/changeRequests');

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
    profiles: [
      { id: 'ravi', name: 'Ravi', role: 'staff' },
      { id: 'asha', name: 'Asha', role: 'manager' },
    ],
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
  state.permitted = true;
});

// -- request helpers --------------------------------------------------------

function jsonReq(method: string, url: string, body?: unknown) {
  return new Request(`https://hioc.in${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: { id } });
const read = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

/** What the edit form sends: every field, as the item stands unless overridden. */
function form(over: Record<string, unknown> = {}) {
  return {
    name: 'Latte',
    description: 'Milky',
    category: 'Coffee',
    parent_category: 'Hot',
    is_veg: true,
    is_available: true,
    in_store_only: false,
    gst_exempt: false,
    sold_by_weight: false,
    sort_order: 50,
    image_url: '',
    short_code: 'LAT',
    variants: [
      { label: 'Regular', price_inr: 150 },
      { label: 'Large', price_inr: 180 },
    ],
    addon_group_ids: [G1],
    ...over,
  };
}

const patchAs = (body: unknown, id = ITEM) => staffPatch(jsonReq('PATCH', `/api/menu/${id}`, body), ctx(id));
const requests = () => state.tables.menu_change_requests as unknown as MenuChangeRequest[];
const menuItem = (id: string) => state.tables.menu_items.find((r) => r.id === id);
const asOwnerOnPos = () => {
  state.actor = { user: { id: 'owner-1' }, role: 'owner', via: 'session' };
};

// ---------------------------------------------------------------------------
// What a proposal changes
// ---------------------------------------------------------------------------

describe('diffChangePayload', () => {
  const snapshot: MenuItemChangePayload = {
    name: 'Latte',
    description: 'Milky',
    category: 'Coffee',
    parent_category: 'Hot',
    is_veg: true,
    is_available: true,
    in_store_only: false,
    gst_exempt: false,
    sold_by_weight: false,
    sort_order: 50,
    image_url: '',
    short_code: 'LAT',
    variants: [
      { label: 'Regular', price_inr: 150 },
      { label: 'Large', price_inr: 180 },
    ],
    addon_group_ids: [G1, G2],
  };

  it('keeps only the fields that differ', () => {
    expect(diffChangePayload(snapshot, { ...snapshot, name: 'Oat Latte', sort_order: 60 })).toEqual({
      name: 'Oat Latte',
      sort_order: 60,
    });
  });

  it('is empty when nothing differs, and ignores fields the proposal does not name', () => {
    expect(diffChangePayload(snapshot, { ...snapshot })).toEqual({});
    expect(diffChangePayload(snapshot, { name: 'Latte' })).toEqual({});
    expect(diffChangePayload(snapshot, {})).toEqual({});
  });

  it('compares sizes as an ordered { label, price_inr } list', () => {
    const same = [
      { label: 'Regular', price_inr: 150 },
      { label: 'Large', price_inr: 180 },
    ];
    expect(diffChangePayload(snapshot, { variants: same })).toEqual({});

    const reordered = [same[1], same[0]];
    expect(diffChangePayload(snapshot, { variants: reordered })).toEqual({ variants: reordered });

    const repriced = [same[0], { label: 'Large', price_inr: 190 }];
    expect(diffChangePayload(snapshot, { variants: repriced })).toEqual({ variants: repriced });

    const renamed = [same[0], { label: 'Grande', price_inr: 180 }];
    expect(diffChangePayload(snapshot, { variants: renamed })).toEqual({ variants: renamed });

    const extra = [...same, { label: 'Jumbo', price_inr: 220 }];
    expect(diffChangePayload(snapshot, { variants: extra })).toEqual({ variants: extra });
    expect(diffChangePayload(snapshot, { variants: [same[0]] })).toEqual({ variants: [same[0]] });
  });

  it('compares add-on groups as a set (order and repeats do not matter)', () => {
    expect(diffChangePayload(snapshot, { addon_group_ids: [G2, G1] })).toEqual({});
    expect(diffChangePayload(snapshot, { addon_group_ids: [G1, G2, G1] })).toEqual({});
    expect(diffChangePayload(snapshot, { addon_group_ids: [G1] })).toEqual({ addon_group_ids: [G1] });
    expect(diffChangePayload(snapshot, { addon_group_ids: [] })).toEqual({ addon_group_ids: [] });
    expect(diffChangePayload(snapshot, { addon_group_ids: [G1, uuid(13)] })).toEqual({
      addon_group_ids: [G1, uuid(13)],
    });
  });

  it('reads a missing short code as none, and clearing one as a change', () => {
    expect(diffChangePayload({ ...snapshot, short_code: null }, { short_code: null })).toEqual({});
    expect(diffChangePayload(snapshot, { short_code: null })).toEqual({ short_code: null });
    expect(diffChangePayload({ ...snapshot, short_code: null }, { short_code: 'NEW' })).toEqual({ short_code: 'NEW' });
  });

  it('reads the columns an old database lacks as off', () => {
    const old: MenuItemChangePayload = { ...snapshot, gst_exempt: undefined, sold_by_weight: undefined, in_store_only: undefined };
    expect(diffChangePayload(old, { gst_exempt: false, sold_by_weight: false, in_store_only: false })).toEqual({});
    expect(diffChangePayload(old, { gst_exempt: true })).toEqual({ gst_exempt: true });
  });
});

describe('isAvailabilityOnly', () => {
  it('is true for sold-out and snooze changes alone', () => {
    expect(isAvailabilityOnly({ is_available: false })).toBe(true);
    expect(isAvailabilityOnly({ unavailable_until: '2026-10-19T10:00:00Z' })).toBe(true);
    expect(isAvailabilityOnly({ is_available: true, unavailable_until: null })).toBe(true);
  });

  it('is false once anything else is in it, or when there is nothing', () => {
    expect(isAvailabilityOnly({ is_available: false, name: 'x' })).toBe(false);
    expect(isAvailabilityOnly({ is_available: false, variants: [{ label: 'a', price_inr: 1 }] })).toBe(false);
    expect(isAvailabilityOnly({ name: 'x' })).toBe(false);
    expect(isAvailabilityOnly({})).toBe(false);
  });

  it('ignores undefined values', () => {
    expect(isAvailabilityOnly({ is_available: false, variants: undefined, addon_group_ids: undefined })).toBe(true);
    expect(isAvailabilityOnly({ variants: undefined })).toBe(false);
  });
});

describe('snapshotFromRow', () => {
  it('orders sizes by sort_order and reports the effective in-store flag', () => {
    const snap = snapshotFromRow({
      id: ITEM,
      name: 'Water',
      category: 'In-store',
      in_store_only: false,
      menu_item_variants: [
        { label: 'Large', price_inr: 30, sort_order: 10 },
        { label: 'Small', price_inr: 20, sort_order: 0 },
      ],
      menu_item_addon_groups: [{ addon_group_id: G2 }],
    });
    expect(snap.variants).toEqual([
      { label: 'Small', price_inr: 20 },
      { label: 'Large', price_inr: 30 },
    ]);
    expect(snap.addon_group_ids).toEqual([G2]);
    expect(snap.in_store_only).toBe(true);
    expect(snap.short_code).toBeNull();
    expect(snap.sold_by_weight).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Staff routes
// ---------------------------------------------------------------------------

describe('PATCH /api/menu/[id] as staff', () => {
  it('keeps a sold-out toggle instant', async () => {
    const res = await patchAs({ is_available: false });
    expect(res.status).toBe(200);
    expect(menuItem(ITEM)?.is_available).toBe(false);
    expect(requests()).toHaveLength(0);
  });

  it('keeps snoozing and marking available instant', async () => {
    const until = '2026-10-19T10:00:00.000Z';
    expect((await patchAs({ is_available: true, unavailable_until: until })).status).toBe(200);
    expect(menuItem(ITEM)?.unavailable_until).toBe(until);
    expect((await patchAs({ is_available: true, unavailable_until: null })).status).toBe(200);
    expect(menuItem(ITEM)?.unavailable_until).toBeNull();
    expect(requests()).toHaveLength(0);
  });

  it('treats a full edit form that only moved the availability switch as a toggle', async () => {
    const res = await patchAs(form({ is_available: false }));
    expect(res.status).toBe(200);
    expect(menuItem(ITEM)?.is_available).toBe(false);
    // The sizes were not rewritten (a rewrite would have given them new ids).
    expect(state.tables.menu_item_variants.map((v) => v.id).sort()).toEqual([uuid(21), uuid(22), uuid(23)]);
    expect(requests()).toHaveLength(0);
  });

  it('stores a name change as a pending request and answers 202, leaving the menu alone', async () => {
    const res = await patchAs({ name: 'Oat Latte' });
    expect(res.status).toBe(202);
    const body = await read<{ pending: boolean; request: MenuChangeRequest }>(res);
    expect(body.pending).toBe(true);
    expect(body.request).toMatchObject({
      action: 'update',
      menu_item_id: ITEM,
      item_name: 'Latte',
      status: 'pending',
      payload: { name: 'Oat Latte' },
      requested_by: 'ravi',
      requested_by_name: 'Ravi',
      decided_by: null,
    });
    // The snapshot is the item as it stood, in full.
    expect(body.request.snapshot).toMatchObject({
      name: 'Latte',
      category: 'Coffee',
      short_code: 'LAT',
      variants: [
        { label: 'Regular', price_inr: 150 },
        { label: 'Large', price_inr: 180 },
      ],
      addon_group_ids: [G1],
    });
    expect(requests()).toHaveLength(1);
    expect(menuItem(ITEM)?.name).toBe('Latte');
  });

  it('keeps only the changed fields of a full edit form in the payload', async () => {
    const res = await patchAs(
      form({
        variants: [
          { label: 'Regular', price_inr: 160 },
          { label: 'Large', price_inr: 180 },
        ],
      }),
    );
    expect(res.status).toBe(202);
    const { request } = await read<{ request: MenuChangeRequest }>(res);
    expect(request.payload).toEqual({
      variants: [
        { label: 'Regular', price_inr: 160 },
        { label: 'Large', price_inr: 180 },
      ],
    });
  });

  it('includes availability in the request when it changes along with something else', async () => {
    const res = await patchAs(form({ name: 'Latte 2', is_available: false }));
    expect(res.status).toBe(202);
    const { request } = await read<{ request: MenuChangeRequest }>(res);
    expect(request.payload).toEqual({ name: 'Latte 2', is_available: false });
    expect(menuItem(ITEM)?.is_available).toBe(true);
  });

  it('refuses an edit that changes nothing, storing no request', async () => {
    const res = await patchAs(form());
    expect(res.status).toBe(400);
    expect((await read<{ error: string }>(res)).error).toBe('No changes to send');
    expect(requests()).toHaveLength(0);
  });

  it('keeps validation errors as 400s before anything is stored', async () => {
    expect((await patchAs({ name: '   ' })).status).toBe(400);
    expect((await patchAs({ variants: [] })).status).toBe(400);
    expect((await patchAs({ short_code: 'not a code!' })).status).toBe(400);
    expect(requests()).toHaveLength(0);
  });

  it('will not mix a snooze into an edit that needs approval', async () => {
    const res = await patchAs({ name: 'Latte 2', unavailable_until: '2026-10-19T10:00:00.000Z' });
    expect(res.status).toBe(400);
    expect(requests()).toHaveLength(0);
  });

  it('404s for an item that is not there', async () => {
    expect((await patchAs({ name: 'x' }, uuid(99))).status).toBe(404);
    expect(requests()).toHaveLength(0);
  });

  it('replaces the older pending request for the same item', async () => {
    const first = await read<{ request: MenuChangeRequest }>(await patchAs({ name: 'Latte 2' }));
    const second = await read<{ request: MenuChangeRequest }>(await patchAs({ name: 'Latte 3' }));
    const byId = new Map(requests().map((r) => [r.id, r]));
    expect(byId.get(first.request.id)).toMatchObject({ status: 'cancelled', decision_note: 'Replaced by a newer request' });
    expect(byId.get(second.request.id)?.status).toBe('pending');
  });

  it('leaves other items\' pending requests alone', async () => {
    await patchAs({ name: 'Latte 2' });
    await patchAs({ name: 'Mocha 2' }, OTHER_ITEM);
    expect(requests().map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('answers 409 with the fix while the migration is missing, rather than touching the menu', async () => {
    state.fail = (table, op) =>
      table === 'menu_change_requests' && op === 'insert'
        ? { code: 'PGRST205', message: "Could not find the table 'public.menu_change_requests' in the schema cache" }
        : null;
    const res = await patchAs({ name: 'Latte 2' });
    expect(res.status).toBe(409);
    expect((await read<{ error: string }>(res)).error).toContain('2026-10-menu-change-requests.sql');
    expect(menuItem(ITEM)?.name).toBe('Latte');
  });
});

describe('POST /api/menu as staff', () => {
  const body = { name: 'Flat White', category: 'Coffee', variants: [{ label: 'Regular', price_inr: 170 }] };

  it('stores the new item as a pending create and answers 202, creating nothing', async () => {
    const res = await staffCreate(jsonReq('POST', '/api/menu', { ...body, addon_group_ids: [G1], short_code: 'fw' }));
    expect(res.status).toBe(202);
    const { pending, request } = await read<{ pending: boolean; request: MenuChangeRequest }>(res);
    expect(pending).toBe(true);
    expect(request).toMatchObject({
      action: 'create',
      menu_item_id: null,
      item_name: 'Flat White',
      status: 'pending',
      snapshot: null,
      requested_by_name: 'Ravi',
    });
    // A create carries every field, with the defaults filled in.
    expect(request.payload).toEqual({
      name: 'Flat White',
      description: '',
      category: 'Coffee',
      parent_category: '',
      is_veg: true,
      is_available: true,
      in_store_only: false,
      gst_exempt: false,
      sold_by_weight: false,
      sort_order: 0,
      image_url: '',
      short_code: 'FW',
      variants: [{ label: 'Regular', price_inr: 170 }],
      addon_group_ids: [G1],
    });
    expect(state.tables.menu_items).toHaveLength(2);
  });

  it('keeps validation errors as 400s, storing nothing', async () => {
    expect((await staffCreate(jsonReq('POST', '/api/menu', { ...body, variants: [] }))).status).toBe(400);
    expect((await staffCreate(jsonReq('POST', '/api/menu', { ...body, category: 'Nope' }))).status).toBe(400);
    expect(requests()).toHaveLength(0);
  });

  it('lets a manager ask the same way', async () => {
    state.actor = { user: { id: 'asha' }, role: 'manager', via: 'device' };
    const res = await staffCreate(jsonReq('POST', '/api/menu', body));
    expect(res.status).toBe(202);
    expect(requests()[0].requested_by_name).toBe('Asha');
  });
});

describe('DELETE /api/menu/[id] as staff', () => {
  it('stores a pending delete with the item\'s values and answers 202, deleting nothing', async () => {
    const res = await staffDelete(jsonReq('DELETE', `/api/menu/${ITEM}`), ctx(ITEM));
    expect(res.status).toBe(202);
    const { request } = await read<{ request: MenuItemChangeRequest }>(res);
    expect(request).toMatchObject({ action: 'delete', menu_item_id: ITEM, item_name: 'Latte', payload: null, status: 'pending' });
    expect(request.snapshot?.variants).toHaveLength(2);
    expect(menuItem(ITEM)).toBeDefined();
  });

  it('404s for an item that is not there', async () => {
    expect((await staffDelete(jsonReq('DELETE', `/api/menu/${uuid(99)}`), ctx(uuid(99)))).status).toBe(404);
    expect(requests()).toHaveLength(0);
  });

  it('replaces an older pending edit of the same item', async () => {
    await patchAs({ name: 'Latte 2' });
    await staffDelete(jsonReq('DELETE', `/api/menu/${ITEM}`), ctx(ITEM));
    expect(requests().map((r) => [r.action, r.status])).toEqual([
      ['update', 'cancelled'],
      ['delete', 'pending'],
    ]);
  });
});

describe('the owner on the POS', () => {
  beforeEach(asOwnerOnPos);

  it('creates, edits and deletes straight away', async () => {
    const created = await staffCreate(
      jsonReq('POST', '/api/menu', { name: 'Flat White', category: 'Coffee', variants: [{ label: 'Regular', price_inr: 170 }] }),
    );
    expect(created.status).toBe(201);
    expect(state.tables.menu_items).toHaveLength(3);

    const edited = await patchAs({ name: 'Oat Latte', variants: [{ label: 'Regular', price_inr: 155 }] });
    expect(edited.status).toBe(200);
    expect(menuItem(ITEM)?.name).toBe('Oat Latte');
    expect(state.tables.menu_item_variants.filter((v) => v.menu_item_id === ITEM)).toHaveLength(1);

    const deleted = await staffDelete(jsonReq('DELETE', `/api/menu/${ITEM}`), ctx(ITEM));
    expect(deleted.status).toBe(200);
    expect(await read(deleted)).toEqual({ deleted: true, id: ITEM });
    expect(menuItem(ITEM)).toBeUndefined();
    expect(requests()).toHaveLength(0);
  });

  it('rolls back a create whose sizes fail to save', async () => {
    state.fail = (table, op) => (table === 'menu_item_variants' && op === 'insert' ? { message: 'boom' } : null);
    const res = await staffCreate(
      jsonReq('POST', '/api/menu', { name: 'Flat White', category: 'Coffee', variants: [{ label: 'Regular', price_inr: 170 }] }),
    );
    expect(res.status).toBe(500);
    expect(state.tables.menu_items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Looking at and withdrawing requests (staff side)
// ---------------------------------------------------------------------------

describe('GET /api/menu/requests', () => {
  it('401s without a counter actor', async () => {
    state.actor = null;
    expect((await listMine(jsonReq('GET', '/api/menu/requests'))).status).toBe(401);
  });

  it('lists pending requests by default and every status with ?status=all', async () => {
    await patchAs({ name: 'Latte 2' });
    await patchAs({ name: 'Latte 3' }); // replaces the first
    await staffDelete(jsonReq('DELETE', `/api/menu/${OTHER_ITEM}`), ctx(OTHER_ITEM));

    const pending = await read<{ requests: MenuChangeRequest[] }>(await listMine(jsonReq('GET', '/api/menu/requests')));
    expect(pending.requests).toHaveLength(2);
    expect(pending.requests.every((r) => r.status === 'pending')).toBe(true);
    // Newest first.
    expect(pending.requests[0].action).toBe('delete');

    const all = await read<{ requests: MenuChangeRequest[] }>(await listMine(jsonReq('GET', '/api/menu/requests?status=all')));
    expect(all.requests).toHaveLength(3);
  });

  it('rejects an unknown status', async () => {
    expect((await listMine(jsonReq('GET', '/api/menu/requests?status=bogus'))).status).toBe(400);
  });

  it('says who is asking, so the UI can show Cancel only where the cancel route allows it', async () => {
    const asked = async () => (await read<{ viewer: unknown }>(await listMine(jsonReq('GET', '/api/menu/requests')))).viewer;
    expect(await asked()).toEqual({ id: 'ravi', role: 'staff' });

    state.actor = { user: { id: 'asha' }, role: 'manager', via: 'device' };
    expect(await asked()).toEqual({ id: 'asha', role: 'manager' });

    asOwnerOnPos();
    expect(await asked()).toEqual({ id: 'owner-1', role: 'owner' });
  });

  it('carries the viewer on an empty list too', async () => {
    const body = await read<{ requests: unknown[]; viewer: unknown }>(await listMine(jsonReq('GET', '/api/menu/requests')));
    expect(body.requests).toEqual([]);
    expect(body.viewer).toEqual({ id: 'ravi', role: 'staff' });
  });
});

describe('DELETE /api/menu/requests/[id] (cancel)', () => {
  async function pendingRequest() {
    const res = await patchAs({ name: 'Latte 2' });
    return (await read<{ request: MenuChangeRequest }>(res)).request;
  }
  const cancel = (id: string) => cancelRequest(jsonReq('DELETE', `/api/menu/requests/${id}`), ctx(id));

  it('lets the requester cancel', async () => {
    const pending = await pendingRequest();
    const res = await cancel(pending.id);
    expect(res.status).toBe(200);
    expect((await read<{ request: MenuChangeRequest }>(res)).request).toMatchObject({ status: 'cancelled', decided_by: 'ravi' });
    expect(requests()[0].status).toBe('cancelled');
  });

  it('refuses another staff member', async () => {
    const pending = await pendingRequest();
    state.actor = { user: { id: 'kiran' }, role: 'staff', via: 'device' };
    expect((await cancel(pending.id)).status).toBe(403);
    expect(requests()[0].status).toBe('pending');
  });

  it('lets a manager and the owner cancel someone else\'s', async () => {
    const first = await pendingRequest();
    state.actor = { user: { id: 'asha' }, role: 'manager', via: 'device' };
    expect((await cancel(first.id)).status).toBe(200);

    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const second = await pendingRequest();
    asOwnerOnPos();
    expect((await cancel(second.id)).status).toBe(200);
  });

  it('409s once the request is no longer pending, 404s for an unknown one, 401s without a session', async () => {
    const pending = await pendingRequest();
    expect((await cancel(pending.id)).status).toBe(200);
    expect((await cancel(pending.id)).status).toBe(409);
    expect((await cancel(uuid(98))).status).toBe(404);
    expect((await cancel('not-an-id')).status).toBe(404);
    state.actor = null;
    expect((await cancel(pending.id)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Owner app
// ---------------------------------------------------------------------------

describe('owner menu routes', () => {
  const body = { name: 'Flat White', category: 'Coffee', variants: [{ label: 'Regular', price_inr: 170 }] };

  it('refuse anyone who is not the owner', async () => {
    state.owner = null;
    const uploadForm = new FormData();
    uploadForm.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    const responses = [
      await ownerCreate(jsonReq('POST', '/api/owner/menu', body)),
      await ownerPatch(jsonReq('PATCH', `/api/owner/menu/${ITEM}`, { name: 'x' }), ctx(ITEM)),
      await ownerDelete(jsonReq('DELETE', `/api/owner/menu/${ITEM}`), ctx(ITEM)),
      await ownerUpload(new Request('https://hioc.in/api/owner/menu/upload', { method: 'POST', body: uploadForm })),
      await ownerList(jsonReq('GET', '/api/owner/menu-requests')),
      await decide(jsonReq('PATCH', `/api/owner/menu-requests/${uuid(5)}`, { action: 'approve' }), ctx(uuid(5))),
    ];
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(state.tables.menu_items).toHaveLength(2);
    expect(menuItem(ITEM)?.name).toBe('Latte');
  });

  it('are not opened by a counter actor (a PIN operator is never the owner)', async () => {
    state.owner = null;
    state.actor = { user: { id: 'owner-1' }, role: 'manager', via: 'device' };
    expect((await ownerCreate(jsonReq('POST', '/api/owner/menu', body))).status).toBe(403);
  });

  it('create, edit and delete apply at once with no approval', async () => {
    const created = await ownerCreate(jsonReq('POST', '/api/owner/menu', body));
    expect(created.status).toBe(201);
    expect((await read<{ item: { name: string } }>(created)).item.name).toBe('Flat White');

    const edited = await ownerPatch(
      jsonReq('PATCH', `/api/owner/menu/${ITEM}`, { name: 'Oat Latte', addon_group_ids: [G2] }),
      ctx(ITEM),
    );
    expect(edited.status).toBe(200);
    expect(menuItem(ITEM)?.name).toBe('Oat Latte');
    expect(state.tables.menu_item_addon_groups.filter((l) => l.menu_item_id === ITEM).map((l) => l.addon_group_id)).toEqual([G2]);

    const snoozed = await ownerPatch(
      jsonReq('PATCH', `/api/owner/menu/${ITEM}`, { is_available: true, unavailable_until: '2026-10-19T10:00:00.000Z' }),
      ctx(ITEM),
    );
    expect(snoozed.status).toBe(200);

    const deleted = await ownerDelete(jsonReq('DELETE', `/api/owner/menu/${ITEM}`), ctx(ITEM));
    expect(deleted.status).toBe(200);
    expect(await read(deleted)).toEqual({ ok: true });
    expect(menuItem(ITEM)).toBeUndefined();
    expect(requests()).toHaveLength(0);
  });

  it('answer the same validation errors and 404s as the POS routes', async () => {
    expect((await ownerCreate(jsonReq('POST', '/api/owner/menu', { ...body, variants: [] }))).status).toBe(400);
    expect((await ownerPatch(jsonReq('PATCH', '/api/owner/menu/x', {}), ctx('x'))).status).toBe(404);
    expect((await ownerPatch(jsonReq('PATCH', `/api/owner/menu/${uuid(99)}`, { name: 'x' }), ctx(uuid(99)))).status).toBe(404);
    expect((await ownerDelete(jsonReq('DELETE', `/api/owner/menu/${uuid(99)}`), ctx(uuid(99)))).status).toBe(404);
    expect((await ownerPatch(jsonReq('PATCH', `/api/owner/menu/${ITEM}`, { short_code: 'MOC' }), ctx(ITEM))).status).toBe(409);
  });

  it('cancel the requests waiting on an item the owner deletes', async () => {
    await patchAs({ name: 'Latte 2' });
    await ownerDelete(jsonReq('DELETE', `/api/owner/menu/${ITEM}`), ctx(ITEM));
    expect(requests()[0]).toMatchObject({ status: 'cancelled', menu_item_id: null, decision_note: 'The item was deleted' });
  });

  it('upload an image', async () => {
    const uploadForm = new FormData();
    uploadForm.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    const res = await ownerUpload(new Request('https://hioc.in/api/owner/menu/upload', { method: 'POST', body: uploadForm }));
    expect(res.status).toBe(201);
    expect(await read(res)).toEqual({ url: 'https://x/menu-images/f.jpg' });
  });
});

describe('GET /api/owner/menu-requests', () => {
  it('lists by status, newest first, with the pending count', async () => {
    const a = (await read<{ request: MenuChangeRequest }>(await patchAs({ name: 'Latte 2' }))).request;
    await patchAs({ name: 'Mocha 2' }, OTHER_ITEM);
    await decide(jsonReq('PATCH', `/api/owner/menu-requests/${a.id}`, { action: 'reject' }), ctx(a.id));

    const pending = await read<{ requests: MenuChangeRequest[]; pendingCount: number }>(
      await ownerList(jsonReq('GET', '/api/owner/menu-requests')),
    );
    expect(pending.requests.map((r) => r.item_name)).toEqual(['Mocha']);
    expect(pending.pendingCount).toBe(1);

    const rejected = await read<{ requests: MenuChangeRequest[]; pendingCount: number }>(
      await ownerList(jsonReq('GET', '/api/owner/menu-requests?status=rejected')),
    );
    expect(rejected.requests.map((r) => r.id)).toEqual([a.id]);
    expect(rejected.pendingCount).toBe(1);

    const all = await read<{ requests: MenuChangeRequest[] }>(await ownerList(jsonReq('GET', '/api/owner/menu-requests?status=all')));
    expect(all.requests.map((r) => r.item_name)).toEqual(['Mocha', 'Latte']);

    expect((await ownerList(jsonReq('GET', '/api/owner/menu-requests?status=bogus'))).status).toBe(400);
  });
});

describe('PATCH /api/owner/menu-requests/[id] (decide)', () => {
  const approve = (id: string, note?: string) =>
    decide(jsonReq('PATCH', `/api/owner/menu-requests/${id}`, { action: 'approve', ...(note ? { note } : {}) }), ctx(id));
  const reject = (id: string, note?: string) =>
    decide(jsonReq('PATCH', `/api/owner/menu-requests/${id}`, { action: 'reject', ...(note ? { note } : {}) }), ctx(id));
  const staffRequest = async (res: Response) => (await read<{ request: MenuChangeRequest }>(res)).request;

  it('approving an edit applies only the payload fields and marks the request approved', async () => {
    const pending = await staffRequest(
      await patchAs(
        form({
          name: 'Oat Latte',
          variants: [
            { label: 'Small', price_inr: 120 },
            { label: 'Regular', price_inr: 160 },
          ],
          addon_group_ids: [G2],
        }),
      ),
    );
    // Someone else changes the sort order in the meantime: the request must not undo it.
    menuItem(ITEM)!.sort_order = 70;

    const res = await approve(pending.id, 'Looks right');
    expect(res.status).toBe(200);
    const out = await read<{ request: MenuChangeRequest; item: { name: string; sort_order: number; variants: { label: string }[] } }>(res);
    expect(out.request).toMatchObject({ status: 'approved', decided_by: 'owner-1', decision_note: 'Looks right' });
    expect(out.request.decided_at).toBeTruthy();
    expect(out.item.name).toBe('Oat Latte');
    expect(out.item.sort_order).toBe(70);
    expect(out.item.variants.map((v) => v.label)).toEqual(['Small', 'Regular']);

    expect(menuItem(ITEM)?.name).toBe('Oat Latte');
    // Sizes fully replaced, in the order sent.
    expect(
      state.tables.menu_item_variants
        .filter((v) => v.menu_item_id === ITEM)
        .map((v) => [v.label, v.price_inr, v.sort_order]),
    ).toEqual([
      ['Small', 120, 0],
      ['Regular', 160, 10],
    ]);
    // Add-on links fully replaced.
    expect(state.tables.menu_item_addon_groups.filter((l) => l.menu_item_id === ITEM).map((l) => l.addon_group_id)).toEqual([G2]);
    expect(requests()[0].status).toBe('approved');
  });

  it('approving a create adds the item and links the request to it', async () => {
    const pending = await staffRequest(
      await staffCreate(
        jsonReq('POST', '/api/menu', {
          name: 'Flat White',
          category: 'Coffee',
          variants: [{ label: 'Regular', price_inr: 170 }],
          addon_group_ids: [G1],
        }),
      ),
    );
    expect(state.tables.menu_items).toHaveLength(2);

    const res = await approve(pending.id);
    expect(res.status).toBe(200);
    const out = await read<{ request: MenuChangeRequest; item: { id: string; name: string } }>(res);
    expect(out.item.name).toBe('Flat White');
    expect(out.request.status).toBe('approved');
    expect(out.request.menu_item_id).toBe(out.item.id);
    expect(requests()[0].menu_item_id).toBe(out.item.id);
    expect(state.tables.menu_items).toHaveLength(3);
    expect(state.tables.menu_item_variants.filter((v) => v.menu_item_id === out.item.id)).toHaveLength(1);
    expect(state.tables.menu_item_addon_groups.filter((l) => l.menu_item_id === out.item.id)).toHaveLength(1);
  });

  it('approving a delete removes the item', async () => {
    const pending = await staffRequest(await staffDelete(jsonReq('DELETE', `/api/menu/${ITEM}`), ctx(ITEM)));
    const res = await approve(pending.id);
    expect(res.status).toBe(200);
    const out = await read<{ request: MenuChangeRequest; item?: unknown }>(res);
    expect(out.request.status).toBe('approved');
    expect(out.item).toBeUndefined();
    expect(menuItem(ITEM)).toBeUndefined();
    expect(state.tables.menu_item_variants.filter((v) => v.menu_item_id === ITEM)).toHaveLength(0);
    // The request keeps its name and snapshot after the item is gone.
    expect(requests()[0]).toMatchObject({ status: 'approved', menu_item_id: null, item_name: 'Latte' });
  });

  it('409s on a request that is no longer pending, and nothing is applied twice', async () => {
    const pending = await staffRequest(await patchAs({ name: 'Oat Latte' }));
    expect((await approve(pending.id)).status).toBe(200);
    menuItem(ITEM)!.name = 'Changed since';
    const again = await approve(pending.id);
    expect(again.status).toBe(409);
    expect((await read<{ error: string }>(again)).error).toBe('This request was already approved.');
    expect(menuItem(ITEM)?.name).toBe('Changed since');
    expect((await reject(pending.id)).status).toBe(409);
  });

  it('applies a request once even when approved twice at the same time', async () => {
    const pending = await staffRequest(
      await patchAs({ variants: [{ label: 'Regular', price_inr: 160 }] }),
    );
    const [one, two] = await Promise.all([approve(pending.id), approve(pending.id)]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(state.tables.menu_item_variants.filter((v) => v.menu_item_id === ITEM)).toHaveLength(1);
  });

  it('rejecting sets the status and note and leaves the menu alone', async () => {
    const pending = await staffRequest(await patchAs({ name: 'Oat Latte' }));
    const res = await reject(pending.id, 'Not this month');
    expect(res.status).toBe(200);
    expect((await read<{ request: MenuChangeRequest }>(res)).request).toMatchObject({
      status: 'rejected',
      decided_by: 'owner-1',
      decision_note: 'Not this month',
    });
    expect(menuItem(ITEM)?.name).toBe('Latte');
    expect((await approve(pending.id)).status).toBe(409);
  });

  it('keeps the request pending when applying it fails', async () => {
    const pending = await staffRequest(
      await staffCreate(
        jsonReq('POST', '/api/menu', {
          name: 'Flat White',
          category: 'Coffee',
          short_code: 'MOC', // already Mocha's
          variants: [{ label: 'Regular', price_inr: 170 }],
        }),
      ),
    );
    const res = await approve(pending.id, 'go');
    expect(res.status).toBe(409);
    expect((await read<{ error: string }>(res)).error).toBe('Code already in use');
    expect(requests()[0]).toMatchObject({ status: 'pending', decided_by: null, decided_at: null, decision_note: null });
    expect(state.tables.menu_items).toHaveLength(2);

    // Fixing the clash lets the same request go through.
    menuItem(OTHER_ITEM)!.short_code = null;
    expect((await approve(pending.id)).status).toBe(200);
    expect(state.tables.menu_items).toHaveLength(3);
  });

  it('answers 500 and keeps the request pending on an unexpected write failure', async () => {
    const pending = await staffRequest(await patchAs({ variants: [{ label: 'Regular', price_inr: 160 }] }));
    state.fail = (table, op) => (table === 'menu_item_variants' && op === 'insert' ? { message: 'boom' } : null);
    const res = await approve(pending.id);
    expect(res.status).toBe(500);
    expect(requests()[0].status).toBe('pending');
  });

  it('409s, leaving the request pending, when the item has since been deleted', async () => {
    const edit = await staffRequest(await patchAs({ name: 'Oat Latte' }));
    state.tables.menu_items.splice(0, state.tables.menu_items.length, ...state.tables.menu_items.filter((r) => r.id !== ITEM));
    edit.menu_item_id = null;
    requests()[0].menu_item_id = null;
    const res = await approve(edit.id);
    expect(res.status).toBe(409);
    expect((await read<{ error: string }>(res)).error).toContain('no longer on the menu');
    expect(requests()[0].status).toBe('pending');

    // Still there on paper but gone from the menu: same answer.
    requests()[0].menu_item_id = ITEM;
    expect((await approve(edit.id)).status).toBe(409);
    expect(requests()[0].status).toBe('pending');
  });

  it('validates the request and the body', async () => {
    const pending = await staffRequest(await patchAs({ name: 'Oat Latte' }));
    const send = (id: string, body: unknown) => decide(jsonReq('PATCH', `/api/owner/menu-requests/${id}`, body), ctx(id));
    expect((await send(pending.id, { action: 'maybe' })).status).toBe(400);
    expect((await send(pending.id, {})).status).toBe(400);
    expect((await send(pending.id, { action: 'reject', note: 5 })).status).toBe(400);
    expect((await send(pending.id, { action: 'reject', note: 'x'.repeat(501) })).status).toBe(400);
    expect((await send('not-an-id', { action: 'approve' })).status).toBe(404);
    expect((await send(uuid(98), { action: 'approve' })).status).toBe(404);
    expect(requests()[0].status).toBe('pending');
  });

  it('refuses a stored payload that no longer validates, without claiming it', async () => {
    const pending = await staffRequest(await patchAs({ name: 'Oat Latte' }));
    requests()[0].payload = { name: '' };
    const res = await approve(pending.id);
    expect(res.status).toBe(400);
    expect(requests()[0].status).toBe('pending');
  });
});

describe('createPayloadFromValues', () => {
  it('carries every field of a create', () => {
    const payload = createPayloadFromValues({
      name: 'A',
      description: '',
      category: 'Coffee',
      parent_category: 'Hot',
      is_veg: true,
      is_available: true,
      sort_order: 0,
      image_url: '',
      unavailable_until: null,
      short_code: null,
      in_store_only: false,
      gst_exempt: false,
      sold_by_weight: false,
      variants: [{ label: 'Regular', price_inr: 1 }],
      addon_group_ids: [],
    });
    expect(Object.keys(payload).sort()).toEqual(
      [
        'name', 'description', 'category', 'parent_category', 'is_veg', 'is_available', 'in_store_only', 'gst_exempt',
        'sold_by_weight', 'sort_order', 'image_url', 'short_code', 'variants', 'addon_group_ids',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

describe('supabase/2026-10-menu-change-requests.sql', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/2026-10-menu-change-requests.sql'), 'utf8');

  it('creates the table with the contract\'s columns and checks', () => {
    expect(sql).toMatch(/create table if not exists public\.menu_change_requests\b/);
    expect(sql).toContain("check (action in ('create', 'update', 'delete'))");
    expect(sql).toContain("check (status in ('pending', 'approved', 'rejected', 'cancelled'))");
    expect(sql).toMatch(/menu_item_id\s+uuid references public\.menu_items\(id\) on delete set null/);
    expect(sql).toMatch(/requested_by\s+uuid references public\.profiles\(id\) on delete set null/);
    expect(sql).toMatch(/decided_by\s+uuid references public\.profiles\(id\) on delete set null/);
    expect(sql).toContain('(status, requested_at desc)');
    expect(sql).toMatch(/\(menu_item_id\) where status = 'pending'/);
  });

  it('turns row level security on and closes the table to anon and authenticated', () => {
    expect(sql).toMatch(/alter table public\.menu_change_requests\s+enable row level security/);
    expect(sql).toMatch(/revoke all on public\.menu_change_requests\s+from anon, authenticated/);
    expect(sql).not.toMatch(/create policy\s+\S*menu_change_requests/i);
  });

  it('adds is_owner() the way is_staff() is built and granted', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.is_owner()'));
    expect(fn).toContain('security definer');
    expect(fn).toContain('set search_path = public');
    expect(fn).toContain("role = 'owner'");
    expect(sql).toContain('revoke execute on function public.is_owner() from public, anon');
    expect(sql).toContain('grant execute on function public.is_owner() to authenticated, service_role');
  });

  it('makes direct menu writes owner-only on the three tables, leaving reads public', () => {
    for (const t of ['menu_items', 'menu_item_variants', 'menu_item_addon_groups']) {
      expect(sql).toContain(t);
    }
    expect(sql).toContain("array['menu_items', 'menu_item_variants']");
    expect(sql).toMatch(/drop policy if exists %I on public\.%I', t \|\| '_staff_write'/);
    expect(sql).toMatch(/drop policy if exists menu_item_addon_groups_staff_write/);
    expect(sql).toMatch(/drop policy if exists menu_item_addon_groups_staff_delete/);
    // Every policy it creates is owner-only.
    const creates = sql.match(/create policy[^;]*;/gi) ?? [];
    expect(creates.length).toBeGreaterThanOrEqual(5);
    for (const c of creates) {
      expect(c).toContain('is_owner()');
      expect(c).not.toContain('is_staff()');
    }
    expect(sql).not.toMatch(/create policy[^;]*for select/i);
    // add-on groups / options / store settings are untouched.
    expect(sql).not.toMatch(/policy[^;]*public\.(addon_groups|addon_options|store_settings)\b/);
    expect(sql).not.toMatch(/array\[[^\]]*'(addon_groups|addon_options|store_settings)'/);
  });
});
