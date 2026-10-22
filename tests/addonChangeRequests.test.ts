import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeMenuAdmin, uuid, type Row } from './helpers/fakeMenuAdmin';
import type {
  AddonGroupChangeRequest,
  MenuChangeRequest,
} from '@/lib/menu/changeRequestTypes';

// Add-on changes need the owner's approval (supabase/2026-10-addon-change-requests.sql).
// A new add-on group or an edit to one by staff or a manager on the POS is
// stored as a pending request (202) in the same menu_change_requests the menu
// items use, and the owner approves or rejects it from the owner app; the
// owner's own add-on edits apply at once. The routes run against an in-memory
// database (helpers/fakeMenuAdmin.ts), so the real validator, writers, claim
// and rollback code is what is tested.

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
  createAdminSupabaseClient: () => ({ from: (table: string) => state.db.from(table) }),
}));

const MILK = uuid(11);
const SYRUP = uuid(12);
const REGULAR = uuid(21);
const OAT = uuid(22);
const VANILLA = uuid(23);
const LATTE = uuid(1);

const { POST: createGroup } = await import('@/app/api/addon-groups/route');
const { PATCH: editGroup } = await import('@/app/api/addon-groups/[id]/route');
const { PATCH: staffPatchItem } = await import('@/app/api/menu/[id]/route');
const { DELETE: cancelRequest } = await import('@/app/api/menu/requests/[id]/route');
const { DELETE: ownerDeleteItem } = await import('@/app/api/owner/menu/[id]/route');
const { GET: ownerList } = await import('@/app/api/owner/menu-requests/route');
const { PATCH: decide } = await import('@/app/api/owner/menu-requests/[id]/route');
const { diffAddonPayload, validateAddonGroupBody } = await import('@/lib/menu/addonChanges');
const {
  buildAddonRequestDiff,
  changedAddonFieldLabels,
  choiceRuleLabel,
  diffAddonOptions,
  requestActionLabel,
} = await import('@/components/owner/menu/menuDiff');
const { describeChange, requestLabel } = await import('@/components/staff/menu/requestSummary');

function seed(): Record<string, Row[]> {
  return {
    menu_items: [
      {
        id: LATTE,
        name: 'Latte',
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
      },
    ],
    menu_item_variants: [{ id: uuid(31), menu_item_id: LATTE, label: 'Regular', price_inr: 150, sort_order: 0 }],
    menu_item_addon_groups: [{ menu_item_id: LATTE, addon_group_id: MILK }],
    addon_groups: [
      { id: MILK, name: 'Milk', display_name: 'Choice of Milk', selection_type: 'single', min_select: 0, max_select: 1, sort_order: 0 },
      { id: SYRUP, name: 'Syrup', display_name: 'Add Syrup', selection_type: 'multi', min_select: 0, max_select: 1, sort_order: 10 },
    ],
    addon_options: [
      { id: REGULAR, addon_group_id: MILK, name: 'Regular', price_inr: 0, sort_order: 0, is_available: true },
      { id: OAT, addon_group_id: MILK, name: 'Oat milk', price_inr: 40, sort_order: 10, is_available: true },
      { id: VANILLA, addon_group_id: SYRUP, name: 'Vanilla', price_inr: 30, sort_order: 0, is_available: true },
    ],
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
    unique: { addon_groups: ['name'] },
    fail: (table, op, payload) => state.fail?.(table, op, payload) ?? null,
    defaults: (table, row) =>
      table === 'menu_change_requests'
        ? {
            // As the database fills them in once the migration is applied.
            target: 'menu_item',
            addon_group_id: null,
            menu_item_id: null,
            payload: null,
            snapshot: null,
            status: 'pending',
            requested_by_name: null,
            requested_at: new Date(Date.UTC(2026, 9, 22, 6, 0, ++clock)).toISOString(),
            decided_by: null,
            decided_at: null,
            decision_note: null,
            ...row,
          }
        : table === 'addon_options'
          ? { is_available: true, ...row }
          : row,
  });
  state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
  state.owner = { id: 'owner-1' };
  state.permitted = true;
});

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
const options = (groupId: string) =>
  state.tables.addon_options.filter((o) => o.addon_group_id === groupId).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
const asOwnerOnPos = () => {
  state.actor = { user: { id: 'owner-1' }, role: 'owner', via: 'session' };
};

/** What the edit form sends for Choice of Milk, as it stands unless overridden. */
function milkForm(over: Record<string, unknown> = {}) {
  return {
    display_name: 'Choice of Milk',
    selection_type: 'single',
    min_select: 0,
    max_select: 1,
    options: [
      { id: REGULAR, name: 'Regular', price_inr: 0 },
      { id: OAT, name: 'Oat milk', price_inr: 40 },
    ],
    ...over,
  };
}

const newShots = {
  display_name: 'Extra Shots',
  selection_type: 'multi',
  min_select: 0,
  max_select: 2,
  options: [
    { name: 'Single shot', price_inr: 30 },
    { name: 'Double shot', price_inr: 50 },
  ],
};

const editMilk = (body: unknown) => editGroup(jsonReq('PATCH', `/api/addon-groups/${MILK}`, body), ctx(MILK));
const approve = (id: string, force = false) =>
  decide(jsonReq('PATCH', `/api/owner/menu-requests/${id}`, { action: 'approve', ...(force ? { force: true } : {}) }), ctx(id));

// ---------------------------------------------------------------------------
// The form's rules
// ---------------------------------------------------------------------------

describe('validateAddonGroupBody', () => {
  it('accepts a pick-one group, optional or required, and trims names', () => {
    const ok = validateAddonGroupBody({ ...milkForm(), display_name: '  Choice of Milk  ', min_select: 1 });
    expect(ok).toMatchObject({ ok: true, value: { display_name: 'Choice of Milk', min_select: 1, max_select: 1 } });
  });

  it('refuses a pick-one group that allows more than one', () => {
    expect(validateAddonGroupBody(milkForm({ max_select: 2 }))).toMatchObject({ ok: false, status: 400 });
  });

  it('keeps a pick-several group between 0 and the number of options', () => {
    expect(validateAddonGroupBody({ ...newShots, max_select: 3 })).toMatchObject({ ok: false, status: 400 });
    expect(validateAddonGroupBody({ ...newShots, min_select: 3, max_select: 2 })).toMatchObject({ ok: false });
    expect(validateAddonGroupBody({ ...newShots, max_select: 0 })).toMatchObject({ ok: false });
    expect(validateAddonGroupBody(newShots)).toMatchObject({ ok: true });
  });

  it('needs a name, options, unique option names and whole non-negative prices', () => {
    expect(validateAddonGroupBody({ ...newShots, display_name: ' ' })).toMatchObject({ ok: false });
    expect(validateAddonGroupBody({ ...newShots, options: [] })).toMatchObject({ ok: false });
    expect(
      validateAddonGroupBody({ ...newShots, options: [{ name: 'Shot', price_inr: 30 }, { name: 'shot', price_inr: 40 }] }),
    ).toMatchObject({ ok: false, message: '"shot" is listed twice.' });
    expect(validateAddonGroupBody({ ...newShots, options: [{ name: 'Shot', price_inr: 12.5 }, { name: 'B', price_inr: 1 }] })).toMatchObject({
      ok: false,
    });
    expect(validateAddonGroupBody({ ...newShots, options: [{ name: 'Shot', price_inr: -1 }, { name: 'B', price_inr: 1 }] })).toMatchObject({
      ok: false,
    });
  });
});

describe('diffAddonPayload', () => {
  const snapshot = {
    display_name: 'Choice of Milk',
    selection_type: 'single' as const,
    min_select: 0,
    max_select: 1,
    options: [
      { id: REGULAR, name: 'Regular', price_inr: 0 },
      { id: OAT, name: 'Oat milk', price_inr: 40 },
    ],
  };

  it('is empty when nothing differs', () => {
    expect(diffAddonPayload(snapshot, { ...snapshot })).toEqual({});
  });

  it('keeps changed fields only, and the whole option list when any option changes', () => {
    const changes = diffAddonPayload(snapshot, {
      ...snapshot,
      min_select: 1,
      options: [snapshot.options[0], { id: OAT, name: 'Oat milk', price_inr: 50 }],
    });
    expect(changes).toEqual({
      min_select: 1,
      options: [snapshot.options[0], { id: OAT, name: 'Oat milk', price_inr: 50 }],
    });
  });

  it('counts a new option and a reorder as an options change', () => {
    expect(diffAddonPayload(snapshot, { ...snapshot, options: [...snapshot.options, { name: 'Soy', price_inr: 30 }] })).toHaveProperty('options');
    expect(diffAddonPayload(snapshot, { ...snapshot, options: [snapshot.options[1], snapshot.options[0]] })).toHaveProperty('options');
  });
});

// ---------------------------------------------------------------------------
// Staff ask
// ---------------------------------------------------------------------------

describe('POST /api/addon-groups as staff', () => {
  it('stores a new group as a pending create and answers 202, creating nothing', async () => {
    const res = await createGroup(jsonReq('POST', '/api/addon-groups', newShots));
    expect(res.status).toBe(202);
    const { pending, request } = await read<{ pending: boolean; request: AddonGroupChangeRequest }>(res);
    expect(pending).toBe(true);
    expect(request).toMatchObject({
      target: 'addon_group',
      action: 'create',
      addon_group_id: null,
      menu_item_id: null,
      item_name: 'Extra Shots',
      status: 'pending',
      requested_by: 'ravi',
      requested_by_name: 'Ravi',
      payload: { display_name: 'Extra Shots', selection_type: 'multi', min_select: 0, max_select: 2 },
    });
    expect(request.payload?.options).toEqual(newShots.options);
    expect(state.tables.addon_groups).toHaveLength(2);
  });

  it('keeps validation errors as 400s, storing nothing', async () => {
    const res = await createGroup(jsonReq('POST', '/api/addon-groups', { ...newShots, selection_type: 'single' }));
    expect(res.status).toBe(400);
    expect(requests()).toHaveLength(0);
  });

  it('says at once when the name is already taken', async () => {
    const res = await createGroup(jsonReq('POST', '/api/addon-groups', { ...newShots, display_name: 'Milk' }));
    expect(res.status).toBe(409);
    expect(requests()).toHaveLength(0);
  });

  it('refuses existing option ids on a new group', async () => {
    const res = await createGroup(
      jsonReq('POST', '/api/addon-groups', { ...newShots, options: [{ id: OAT, name: 'Oat', price_inr: 1 }, { name: 'B', price_inr: 1 }] }),
    );
    expect(res.status).toBe(400);
  });

  it('answers 409 with the fix while the migration is missing, storing nothing', async () => {
    state.fail = (table, op, payload) =>
      table === 'menu_change_requests' && op === 'insert' && 'target' in (payload as Row)
        ? { code: 'PGRST204', message: "Could not find the 'target' column of 'menu_change_requests' in the schema cache" }
        : null;
    const res = await createGroup(jsonReq('POST', '/api/addon-groups', newShots));
    expect(res.status).toBe(409);
    expect((await read<{ error: string }>(res)).error).toMatch(/2026-10-addon-change-requests\.sql/);
  });

  it('is refused without the menu permission', async () => {
    state.permitted = false;
    expect((await createGroup(jsonReq('POST', '/api/addon-groups', newShots))).status).toBe(403);
  });
});

describe('PATCH /api/addon-groups/[id] as staff', () => {
  it('stores only what changes, with the group as it stands, and answers 202', async () => {
    const res = await editMilk(
      milkForm({
        options: [
          { id: REGULAR, name: 'Regular', price_inr: 0 },
          { id: OAT, name: 'Oat milk', price_inr: 50 },
          { name: 'Soy milk', price_inr: 35 },
        ],
      }),
    );
    expect(res.status).toBe(202);
    const { request } = await read<{ request: AddonGroupChangeRequest }>(res);
    expect(request).toMatchObject({ target: 'addon_group', action: 'update', addon_group_id: MILK, item_name: 'Choice of Milk' });
    expect(Object.keys(request.payload ?? {})).toEqual(['options']);
    expect(request.snapshot?.options).toEqual([
      { id: REGULAR, name: 'Regular', price_inr: 0 },
      { id: OAT, name: 'Oat milk', price_inr: 40 },
    ]);
    // The menu is untouched until the owner approves.
    expect(options(MILK).map((o) => o.price_inr)).toEqual([0, 40]);
  });

  it('refuses an edit that changes nothing', async () => {
    const res = await editMilk(milkForm());
    expect(res.status).toBe(400);
    expect(requests()).toHaveLength(0);
  });

  it('refuses a form that leaves out an option the group has (it gained one since)', async () => {
    const res = await editMilk(milkForm({ options: [{ id: REGULAR, name: 'Regular', price_inr: 0 }] }));
    expect(res.status).toBe(400);
  });

  it('refuses another group\'s option', async () => {
    const res = await editMilk(
      milkForm({
        options: [
          { id: REGULAR, name: 'Regular', price_inr: 0 },
          { id: OAT, name: 'Oat milk', price_inr: 40 },
          { id: VANILLA, name: 'Vanilla', price_inr: 30 },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('404s for a group that is not there', async () => {
    const missing = uuid(99);
    expect((await editGroup(jsonReq('PATCH', `/api/addon-groups/${missing}`, milkForm()), ctx(missing))).status).toBe(404);
  });

  it('replaces the older pending edit of the same group', async () => {
    await editMilk(milkForm({ display_name: 'Milk choice' }));
    await editMilk(milkForm({ display_name: 'Your milk' }));
    expect(requests().map((r) => r.status)).toEqual(['cancelled', 'pending']);
  });
});

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

describe('the owner on the POS', () => {
  it('creates a group with its options straight away, at the end of the list', async () => {
    asOwnerOnPos();
    const res = await createGroup(jsonReq('POST', '/api/addon-groups', newShots));
    expect(res.status).toBe(201);
    const { group } = await read<{ group: { id: string; name: string; sort_order: number; options: { name: string }[] } }>(res);
    expect(group).toMatchObject({ name: 'Extra Shots', display_name: 'Extra Shots', sort_order: 20 });
    expect(group.options.map((o) => o.name)).toEqual(['Single shot', 'Double shot']);
    expect(requests()).toHaveLength(0);
  });

  it('edits options in place, keeping their ids, and adds new ones', async () => {
    asOwnerOnPos();
    const res = await editMilk(
      milkForm({
        display_name: 'Milk',
        options: [
          { id: REGULAR, name: 'Regular', price_inr: 0 },
          { id: OAT, name: 'Oat', price_inr: 45 },
          { name: 'Soy milk', price_inr: 35 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(state.tables.addon_groups.find((g) => g.id === MILK)).toMatchObject({ display_name: 'Milk', name: 'Milk' });
    expect(options(MILK).map((o) => [o.id === OAT ? 'OAT' : o.id === REGULAR ? 'REGULAR' : 'new', o.name, o.price_inr])).toEqual([
      ['REGULAR', 'Regular', 0],
      ['OAT', 'Oat', 45],
      ['new', 'Soy milk', 35],
    ]);
  });
});

describe('approving and rejecting add-on requests', () => {
  it('approves a new group: it is created and the request links to it', async () => {
    const { request } = await read<{ request: AddonGroupChangeRequest }>(await createGroup(jsonReq('POST', '/api/addon-groups', newShots)));
    const res = await approve(request.id);
    expect(res.status).toBe(200);
    const body = await read<{ request: AddonGroupChangeRequest; addonGroup: { id: string; options: unknown[] } }>(res);
    expect(body.request).toMatchObject({ status: 'approved', decided_by: 'owner-1' });
    expect(body.request.addon_group_id).toBe(body.addonGroup.id);
    expect(body.addonGroup.options).toHaveLength(2);
    expect(requests()[0]).toMatchObject({ status: 'approved', addon_group_id: body.addonGroup.id });
  });

  it('approves an edit in place: same option ids, new price, new option', async () => {
    const { request } = await read<{ request: AddonGroupChangeRequest }>(
      await editMilk(
        milkForm({
          min_select: 1,
          options: [
            { id: REGULAR, name: 'Regular', price_inr: 0 },
            { id: OAT, name: 'Oat milk', price_inr: 50 },
            { name: 'Almond milk', price_inr: 60 },
          ],
        }),
      ),
    );
    expect((await approve(request.id)).status).toBe(200);
    expect(state.tables.addon_groups.find((g) => g.id === MILK)).toMatchObject({ min_select: 1 });
    const now = options(MILK);
    expect(now.find((o) => o.id === OAT)).toMatchObject({ price_inr: 50 });
    expect(now.map((o) => o.name)).toEqual(['Regular', 'Oat milk', 'Almond milk']);
  });

  it('holds a stale edit for "approve anyway" rather than overwrite a newer price', async () => {
    const { request } = await read<{ request: AddonGroupChangeRequest }>(
      await editMilk(milkForm({ options: [{ id: REGULAR, name: 'Regular', price_inr: 0 }, { id: OAT, name: 'Oat milk', price_inr: 50 }] })),
    );
    // The owner reprices oat milk directly in the meantime.
    asOwnerOnPos();
    await editMilk(milkForm({ options: [{ id: REGULAR, name: 'Regular', price_inr: 0 }, { id: OAT, name: 'Oat milk', price_inr: 45 }] }));

    const stale = await approve(request.id);
    expect(stale.status).toBe(409);
    expect(await read(stale)).toMatchObject({ stale: true, fields: ['options'] });
    expect(requests()[0].status).toBe('pending');

    expect((await approve(request.id, true)).status).toBe(200);
    expect(options(MILK).find((o) => o.id === OAT)).toMatchObject({ price_inr: 50 });
  });

  it('puts the request back to pending when the name was taken before approval', async () => {
    const { request } = await read<{ request: AddonGroupChangeRequest }>(await createGroup(jsonReq('POST', '/api/addon-groups', newShots)));
    state.tables.addon_groups.push({ id: uuid(13), name: 'Extra Shots', display_name: 'Extra Shots', selection_type: 'multi', min_select: 0, max_select: 1, sort_order: 30 });
    const res = await approve(request.id);
    expect(res.status).toBe(409);
    expect(requests()[0]).toMatchObject({ status: 'pending', decided_by: null, decided_at: null });
  });

  it('rejects without touching the menu', async () => {
    const { request } = await read<{ request: AddonGroupChangeRequest }>(await editMilk(milkForm({ display_name: 'Milk choice' })));
    const res = await decide(jsonReq('PATCH', `/api/owner/menu-requests/${request.id}`, { action: 'reject', note: 'Keep the name' }), ctx(request.id));
    expect(res.status).toBe(200);
    expect(requests()[0]).toMatchObject({ status: 'rejected', decision_note: 'Keep the name' });
    expect(state.tables.addon_groups.find((g) => g.id === MILK)).toMatchObject({ display_name: 'Choice of Milk' });
  });

  it('lets the requester cancel their own add-on request', async () => {
    const { request } = await read<{ request: AddonGroupChangeRequest }>(await editMilk(milkForm({ display_name: 'Milk choice' })));
    const res = await cancelRequest(jsonReq('DELETE', `/api/menu/requests/${request.id}`), ctx(request.id));
    expect(res.status).toBe(200);
    expect(requests()[0].status).toBe('cancelled');
  });

  it('lists add-on requests in the owner inbox and counts them as pending', async () => {
    await editMilk(milkForm({ display_name: 'Milk choice' }));
    const res = await ownerList(jsonReq('GET', '/api/owner/menu-requests'));
    const body = await read<{ requests: MenuChangeRequest[]; pendingCount: number }>(res);
    expect(body.pendingCount).toBe(1);
    expect(body.requests[0]).toMatchObject({ target: 'addon_group', addon_group_id: MILK });
  });

  it('leaves add-on requests alone when the owner deletes a menu item', async () => {
    await editMilk(milkForm({ display_name: 'Milk choice' }));
    await staffPatchItem(jsonReq('PATCH', `/api/menu/${LATTE}`, { name: 'Latte 2' }), ctx(LATTE));
    await ownerDeleteItem(jsonReq('DELETE', `/api/owner/menu/${LATTE}`), ctx(LATTE));
    expect(requests().map((r) => [r.target, r.status])).toEqual([
      ['addon_group', 'pending'],
      ['menu_item', 'cancelled'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// How a request reads
// ---------------------------------------------------------------------------

describe('reading an add-on request', () => {
  const base = {
    id: 'r1',
    item_name: 'Choice of Milk',
    status: 'pending' as const,
    requested_by: 'ravi',
    requested_by_name: 'Ravi',
    requested_at: '2026-10-22T06:00:00Z',
    decided_by: null,
    decided_at: null,
    decision_note: null,
    target: 'addon_group' as const,
    menu_item_id: null,
  };
  const snapshot = {
    display_name: 'Choice of Milk',
    selection_type: 'single' as const,
    min_select: 0,
    max_select: 1,
    options: [
      { id: REGULAR, name: 'Regular', price_inr: 0 },
      { id: OAT, name: 'Oat milk', price_inr: 40 },
    ],
  };

  it('describes the choice rule in words', () => {
    expect(choiceRuleLabel({ selection_type: 'single', min_select: 1, max_select: 1 })).toBe('Pick one (required)');
    expect(choiceRuleLabel({ selection_type: 'single', min_select: 0, max_select: 1 })).toBe('Pick one (optional)');
    expect(choiceRuleLabel({ selection_type: 'multi', min_select: 0, max_select: 3 })).toBe('Pick up to 3');
    expect(choiceRuleLabel({ selection_type: 'multi', min_select: 2, max_select: 2 })).toBe('Pick exactly 2');
    expect(choiceRuleLabel({ selection_type: 'multi', min_select: 1, max_select: 3 })).toBe('Pick 1–3');
  });

  it('lines options up by id: renamed or repriced, new, and untouched', () => {
    const rows = diffAddonOptions(snapshot.options, [
      { id: OAT, name: 'Oat', price_inr: 45 },
      { name: 'Soy milk', price_inr: 35 },
    ]);
    expect(rows.map((r) => r.status)).toEqual(['changed', 'added', 'same']);
    expect(rows[0]).toMatchObject({ before: { name: 'Oat milk', price_inr: 40 }, after: { name: 'Oat', price_inr: 45 } });
    // An option the request leaves out stays as it is.
    expect(rows[2]).toMatchObject({ key: REGULAR, before: { name: 'Regular' }, after: { name: 'Regular' } });
  });

  it('shows an edit as before → after, only for what changes', () => {
    const request: AddonGroupChangeRequest = {
      ...base,
      action: 'update',
      addon_group_id: MILK,
      snapshot,
      payload: { min_select: 1 },
    };
    const diff = buildAddonRequestDiff(request);
    expect(diff).toMatchObject({ mode: 'diff', name: null, options: null, rule: { before: 'Pick one (optional)', after: 'Pick one (required)' } });
    expect(changedAddonFieldLabels(request.payload)).toEqual(['Choice rule']);
    expect(requestActionLabel(request)).toBe('Edit add-on group');
    expect(requestLabel(request)).toBe('Edit add-on group');
    expect(describeChange(request)).toBe('Changes: choice rule');
  });

  it('shows a new group with the values it will start with', () => {
    const request: AddonGroupChangeRequest = {
      ...base,
      action: 'create',
      item_name: 'Extra Shots',
      addon_group_id: null,
      snapshot: null,
      payload: {
        display_name: 'Extra Shots',
        selection_type: 'multi',
        min_select: 0,
        max_select: 2,
        options: newShots.options,
      },
    };
    const diff = buildAddonRequestDiff(request);
    expect(diff.mode).toBe('proposed');
    expect(diff.name).toEqual({ before: null, after: 'Extra Shots' });
    expect(diff.rule).toEqual({ before: null, after: 'Pick up to 2' });
    expect(diff.options?.map((o) => o.status)).toEqual(['added', 'added']);
    expect(requestActionLabel(request)).toBe('New add-on group');
    expect(describeChange(request)).toBe('2 options');
  });
});
