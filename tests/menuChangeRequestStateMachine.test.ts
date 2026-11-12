import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeMenuAdmin, uuid, type Row } from './helpers/fakeMenuAdmin';
import {
  APPLY_GRACE_MS,
  MENU_CHANGE_STATUSES,
  MENU_CHANGE_TRANSITIONS,
  OPEN_MENU_CHANGE_STATUSES,
  approvalUnconfirmed,
  canCancelMenuChange,
  canDecideMenuChange,
  checkMenuChange,
  isPendingMenuChange,
  type MenuChangeTransitionName,
} from '@/lib/menu/changeRequestStatus';
import type { MenuChangeRequest, MenuChangeStatus } from '@/lib/menu/changeRequestTypes';

// The menu change request lifecycle (lib/menu/changeRequestStatus.ts) and the
// bugs it was made explicit to fix:
//  - an approval that failed part-way used to go back to pending with the item
//    half-changed (sizes deleted, the new ones never written); now every writer
//    leaves the item as it was;
//  - an approval interrupted between the claim and the end of the apply was
//    indistinguishable from a finished one; now it shows as unconfirmed.
// The routes run against the in-memory database (helpers/fakeMenuAdmin.ts).

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
const G1 = uuid(11);
const G2 = uuid(12);
const MILK = uuid(13);
const REGULAR_MILK = uuid(31);
const OAT = uuid(32);

const { PATCH: staffPatch, DELETE: staffDelete } = await import('@/app/api/menu/[id]/route');
const { POST: staffCreate } = await import('@/app/api/menu/route');
const { DELETE: cancelRequest } = await import('@/app/api/menu/requests/[id]/route');
const { PATCH: ownerPatch } = await import('@/app/api/owner/menu/[id]/route');
const { PATCH: decide } = await import('@/app/api/owner/menu-requests/[id]/route');
const { PATCH: editGroup } = await import('@/app/api/addon-groups/[id]/route');

let clock = 0;
let withAppliedAt = true;

function seed(): Record<string, Row[]> {
  return {
    menu_items: [
      {
        id: ITEM,
        name: 'Latte',
        description: 'Milky',
        category: 'Coffee',
        parent_category: 'Hot',
        is_veg: true,
        is_available: true,
        sort_order: 50,
        image_url: '',
        unavailable_until: null,
        short_code: 'LAT',
        in_store_only: false,
        gst_exempt: false,
      },
    ],
    menu_item_variants: [
      { id: uuid(21), menu_item_id: ITEM, label: 'Regular', price_inr: 150, sort_order: 0 },
      { id: uuid(22), menu_item_id: ITEM, label: 'Large', price_inr: 180, sort_order: 10 },
    ],
    menu_item_addon_groups: [{ menu_item_id: ITEM, addon_group_id: G1 }],
    addon_groups: [
      { id: G1, name: 'Sugar', display_name: 'Sugar', selection_type: 'single', min_select: 0, max_select: 1, sort_order: 0 },
      { id: G2, name: 'Syrup', display_name: 'Syrup', selection_type: 'multi', min_select: 0, max_select: 1, sort_order: 10 },
      { id: MILK, name: 'Milk', display_name: 'Choice of Milk', selection_type: 'single', min_select: 0, max_select: 1, sort_order: 20 },
    ],
    addon_options: [
      { id: REGULAR_MILK, addon_group_id: MILK, name: 'Regular', price_inr: 0, sort_order: 0, is_available: true },
      { id: OAT, addon_group_id: MILK, name: 'Oat milk', price_inr: 40, sort_order: 10, is_available: true },
    ],
    profiles: [
      { id: 'ravi', name: 'Ravi', role: 'staff' },
      { id: 'asha', name: 'Asha', role: 'manager' },
    ],
    menu_change_requests: [],
  };
}

beforeEach(() => {
  clock = 0;
  withAppliedAt = true;
  state.tables = seed();
  state.fail = null;
  state.db = makeFakeMenuAdmin(state.tables, {
    unique: { menu_items: ['short_code'], addon_groups: ['name'] },
    fail: (table, op, payload) => {
      // A database without supabase/2026-11-menu-inventory-state-machine.sql.
      if (!withAppliedAt && table === 'menu_change_requests' && op === 'update' && payload && 'applied_at' in (payload as Row)) {
        return { code: '42703', message: 'column "applied_at" of relation "menu_change_requests" does not exist' };
      }
      return state.fail?.(table, op, payload) ?? null;
    },
    defaults: (table, row) =>
      table === 'menu_change_requests'
        ? {
            target: 'menu_item',
            addon_group_id: null,
            menu_item_id: null,
            payload: null,
            snapshot: null,
            status: 'pending',
            requested_by_name: null,
            requested_at: new Date(Date.UTC(2026, 10, 12, 6, 0, ++clock)).toISOString(),
            decided_by: null,
            decided_at: null,
            decision_note: null,
            ...(withAppliedAt ? { applied_at: null } : {}),
            ...row,
          }
        : table === 'addon_options'
          ? { is_available: true, ...row }
          : row,
  });
  state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
  state.owner = { id: 'owner-1' };
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
const patchAs = (body: unknown) => staffPatch(jsonReq('PATCH', `/api/menu/${ITEM}`, body), ctx(ITEM));
const approve = (id: string, force = false) =>
  decide(jsonReq('PATCH', `/api/owner/menu-requests/${id}`, { action: 'approve', ...(force ? { force: true } : {}) }), ctx(id));
const requests = () => state.tables.menu_change_requests as unknown as MenuChangeRequest[];
const item = () => state.tables.menu_items.find((r) => r.id === ITEM);
const sizes = () =>
  state.tables.menu_item_variants
    .filter((v) => v.menu_item_id === ITEM)
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
    .map((v) => [v.label, v.price_inr]);
const links = () =>
  state.tables.menu_item_addon_groups
    .filter((l) => l.menu_item_id === ITEM)
    .map((l) => l.addon_group_id)
    .sort();
const staffRequest = async (res: Response) => {
  expect(res.status).toBe(202);
  return (await read<{ request: MenuChangeRequest }>(res)).request;
};

/** Fails the first statement that matches, once (so the undo that follows can run). */
function failOnce(table: string, op: string, when: (payload: unknown) => boolean = () => true) {
  let done = false;
  state.fail = (t, o, payload) => {
    if (done || t !== table || o !== op || !when(payload)) return null;
    done = true;
    return { message: 'boom' };
  };
}

const BIG_EDIT = {
  name: 'Oat Latte',
  variants: [
    { label: 'Small', price_inr: 120 },
    { label: 'Regular', price_inr: 160 },
  ],
  addon_group_ids: [G2],
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('the transition table', () => {
  const statuses: MenuChangeStatus[] = [...MENU_CHANGE_STATUSES];
  const owner = { id: 'owner-1', role: 'owner' };
  const manager = { id: 'asha', role: 'manager' };
  const requester = { id: 'ravi', role: 'staff' };
  const stranger = { id: 'kiran', role: 'staff' };
  const req = (status: MenuChangeStatus) => ({ status, requested_by: 'ravi' });

  it('leaves pending by approve, reject and cancel only, and only the system puts an approval back', () => {
    const table = MENU_CHANGE_TRANSITIONS.map((t) => `${t.name}: ${t.from} → ${t.to} by ${t.actors.join('/')}`);
    expect(table).toEqual([
      'approve: pending → approved by owner',
      'reject: pending → rejected by owner',
      'cancel: pending → cancelled by requester/manager/owner',
      'supersede: pending → cancelled by system',
      'item_deleted: pending → cancelled by system',
      'put_back: approved → pending by system',
    ]);
    expect(OPEN_MENU_CHANGE_STATUSES).toEqual(['pending']);
  });

  it('allows each transition only from its from-status (409 otherwise, naming what became of it)', () => {
    const who: Record<MenuChangeTransitionName, Parameters<typeof checkMenuChange>[2]> = {
      approve: owner,
      reject: owner,
      cancel: requester,
      supersede: 'system',
      item_deleted: 'system',
      put_back: 'system',
    };
    for (const t of MENU_CHANGE_TRANSITIONS) {
      for (const status of statuses) {
        const res = checkMenuChange(t.name, req(status), who[t.name]);
        if (status === t.from) expect(res.ok).toBe(true);
        else expect(res).toMatchObject({ ok: false, status: 409, message: `This request was already ${status}.` });
      }
    }
  });

  it('lets only the owner decide, and the requester, a manager or the owner cancel', () => {
    expect(checkMenuChange('approve', req('pending'), manager)).toMatchObject({ ok: false, status: 403 });
    expect(checkMenuChange('reject', req('pending'), requester)).toMatchObject({ ok: false, status: 403 });
    expect(checkMenuChange('cancel', req('pending'), stranger)).toMatchObject({ ok: false, status: 403 });
    for (const viewer of [requester, manager, owner]) expect(checkMenuChange('cancel', req('pending'), viewer).ok).toBe(true);
    // No person can put an approval back, nor the system decide one.
    expect(checkMenuChange('put_back', req('approved'), owner)).toMatchObject({ ok: false, status: 403 });
    expect(checkMenuChange('approve', req('pending'), 'system')).toMatchObject({ ok: false, status: 403 });
  });

  it('tells a stranger it is not theirs before telling them what became of it', () => {
    expect(checkMenuChange('cancel', req('approved'), stranger)).toMatchObject({ ok: false, status: 403 });
  });

  it('drives the screen helpers', () => {
    for (const status of statuses) {
      expect(isPendingMenuChange({ status })).toBe(status === 'pending');
      expect(canDecideMenuChange({ status })).toBe(status === 'pending');
      expect(canCancelMenuChange(req(status), requester)).toBe(status === 'pending');
    }
    expect(canCancelMenuChange(req('pending'), null)).toBe(false);
    expect(canCancelMenuChange({ status: 'pending', requested_by: null }, requester)).toBe(false);
  });
});

describe('approvalUnconfirmed', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  const decidedAgo = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const base = { status: 'approved' as MenuChangeStatus, action: 'update' as const, menu_item_id: ITEM, target: 'menu_item' as const };

  it('with the applied_at column: unstamped past the grace period', () => {
    expect(approvalUnconfirmed({ ...base, decided_at: decidedAgo(APPLY_GRACE_MS + 1), applied_at: null }, now)).toBe(true);
    expect(approvalUnconfirmed({ ...base, decided_at: decidedAgo(1000), applied_at: null }, now)).toBe(false);
    expect(approvalUnconfirmed({ ...base, decided_at: decidedAgo(APPLY_GRACE_MS + 1), applied_at: decidedAgo(1) }, now)).toBe(false);
  });

  it('without it: a create with no item, or a delete whose item is still linked', () => {
    const old = decidedAgo(APPLY_GRACE_MS * 10);
    expect(approvalUnconfirmed({ ...base, action: 'create', menu_item_id: null, decided_at: old }, now)).toBe(true);
    expect(approvalUnconfirmed({ ...base, action: 'create', decided_at: old }, now)).toBe(false);
    expect(approvalUnconfirmed({ ...base, action: 'delete', decided_at: old }, now)).toBe(true);
    expect(approvalUnconfirmed({ ...base, action: 'delete', menu_item_id: null, decided_at: old }, now)).toBe(false);
    expect(approvalUnconfirmed({ ...base, decided_at: old }, now)).toBe(false);
    expect(
      approvalUnconfirmed({ ...base, target: 'addon_group', action: 'create', menu_item_id: null, addon_group_id: null, decided_at: old }, now),
    ).toBe(true);
  });

  it('never for a request that is not approved', () => {
    for (const status of ['pending', 'rejected', 'cancelled'] as const) {
      expect(approvalUnconfirmed({ ...base, status, decided_at: null, applied_at: null }, now)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Writers go through it
// ---------------------------------------------------------------------------

describe('the routes ask the table', () => {
  it('cancel: 403 for someone else\'s, 409 once decided, and a lost race is a 409 too', async () => {
    const pending = await staffRequest(await patchAs({ name: 'Oat Latte' }));
    state.actor = { user: { id: 'kiran' }, role: 'staff', via: 'device' };
    expect((await cancelRequest(jsonReq('DELETE', `/api/menu/requests/${pending.id}`), ctx(pending.id))).status).toBe(403);

    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    // The owner approves between the cancel's read and its write: the guarded
    // write finds nothing pending and says so, rather than cancelling an approval.
    const real = state.db;
    let raced = false;
    state.db = {
      from(table: string) {
        if (table === 'menu_change_requests' && !raced) {
          const row = requests()[0];
          const chain = real.from(table);
          const origUpdate = chain.update;
          chain.update = (p: Row) => {
            raced = true;
            row.status = 'approved';
            return origUpdate(p);
          };
          return chain;
        }
        return real.from(table);
      },
    } as typeof real;
    const res = await cancelRequest(jsonReq('DELETE', `/api/menu/requests/${pending.id}`), ctx(pending.id));
    expect(res.status).toBe(409);
    expect(requests()[0].status).toBe('approved');
  });

  it('reject: 409 with what became of it once decided', async () => {
    const pending = await staffRequest(await patchAs({ name: 'Oat Latte' }));
    requests()[0].status = 'cancelled';
    const res = await decide(jsonReq('PATCH', `/api/owner/menu-requests/${pending.id}`, { action: 'reject' }), ctx(pending.id));
    expect(res.status).toBe(409);
    expect((await read<{ error: string }>(res)).error).toBe('This request was already cancelled.');
  });
});

// ---------------------------------------------------------------------------
// A failed apply leaves the item as it was
// ---------------------------------------------------------------------------

describe('approving an edit that fails part-way', () => {
  it('when the old sizes cannot be removed (the last step): name, sizes and add-ons are all put back', async () => {
    const pending = await staffRequest(await patchAs(BIG_EDIT));
    failOnce('menu_item_variants', 'delete');
    const res = await approve(pending.id);
    expect(res.status).toBe(500);
    expect(item()?.name).toBe('Latte');
    expect(sizes()).toEqual([
      ['Regular', 150],
      ['Large', 180],
    ]);
    expect(links()).toEqual([G1]);
    expect(requests()[0]).toMatchObject({ status: 'pending', decided_by: null, decided_at: null, applied_at: null });

    // Nothing half-done, so approving again is not "stale" and goes through.
    const again = await approve(pending.id);
    expect(again.status).toBe(200);
    expect(item()?.name).toBe('Oat Latte');
    expect(sizes()).toEqual([
      ['Small', 120],
      ['Regular', 160],
    ]);
    expect(links()).toEqual([G2]);
  });

  it('when the new add-on links cannot be written: the new sizes are taken away again, the old ones never left', async () => {
    const pending = await staffRequest(await patchAs(BIG_EDIT));
    const oldIds = state.tables.menu_item_variants.map((v) => v.id).sort();
    failOnce('menu_item_addon_groups', 'insert');
    expect((await approve(pending.id)).status).toBe(500);
    expect(item()?.name).toBe('Latte');
    // The very same rows: past orders pointing at a size keep their link.
    expect(state.tables.menu_item_variants.map((v) => v.id).sort()).toEqual(oldIds);
    expect(links()).toEqual([G1]);
    expect(requests()[0].status).toBe('pending');
  });

  it('when a dropped add-on link cannot be removed', async () => {
    const pending = await staffRequest(await patchAs(BIG_EDIT));
    failOnce('menu_item_addon_groups', 'delete');
    expect((await approve(pending.id)).status).toBe(500);
    expect(item()?.name).toBe('Latte');
    expect(sizes()).toEqual([
      ['Regular', 150],
      ['Large', 180],
    ]);
    expect(links()).toEqual([G1]);
  });

  it('says so when even putting it back fails', async () => {
    const pending = await staffRequest(await patchAs(BIG_EDIT));
    // Every variants delete fails: the replacement and its undo.
    state.fail = (t, op) => (t === 'menu_item_variants' && op === 'delete' ? { message: 'boom' } : null);
    const res = await approve(pending.id);
    expect(res.status).toBe(500);
    expect((await read<{ error: string }>(res)).error).toContain('could not be undone');
    // Still pending: approving it again anyway lays the whole change down.
    expect(requests()[0].status).toBe('pending');
  });

  it('a read-back failure after the change is in keeps the approval (it is applied, so it is not put back)', async () => {
    const pending = await staffRequest(await patchAs({ name: 'Oat Latte' }));
    // The writes succeed; the final embedded read of the item fails.
    state.fail = (t, op) => (t === 'menu_items' && op === 'select' && item()?.name === 'Oat Latte' ? { message: 'read failed' } : null);
    const res = await approve(pending.id);
    expect(res.status).toBe(200);
    expect(await read(res)).not.toHaveProperty('item');
    expect(requests()[0].status).toBe('approved');
    expect(requests()[0].applied_at).toBeTruthy();
  });

  it('the owner\'s own edit is undone the same way', async () => {
    failOnce('menu_item_variants', 'delete');
    const res = await ownerPatch(jsonReq('PATCH', `/api/owner/menu/${ITEM}`, BIG_EDIT), ctx(ITEM));
    expect(res.status).toBe(500);
    expect(item()?.name).toBe('Latte');
    expect(sizes()).toEqual([
      ['Regular', 150],
      ['Large', 180],
    ]);
    expect(links()).toEqual([G1]);
  });

  it('keeps add-on links the edit keeps, and replaces the sizes whole', async () => {
    const res = await ownerPatch(
      jsonReq('PATCH', `/api/owner/menu/${ITEM}`, { variants: [{ label: 'Regular', price_inr: 155 }], addon_group_ids: [G1, G2, G2] }),
      ctx(ITEM),
    );
    expect(res.status).toBe(200);
    expect(sizes()).toEqual([['Regular', 155]]);
    expect(links()).toEqual([G1, G2].sort());
  });
});

describe('an add-on group edit that fails part-way', () => {
  const groupEdit = {
    display_name: 'Milk',
    selection_type: 'single',
    min_select: 0,
    max_select: 1,
    options: [
      { id: REGULAR_MILK, name: 'Regular', price_inr: 0 },
      { name: 'Almond milk', price_inr: 50 },
      { id: OAT, name: 'Oat milk', price_inr: 45 },
    ],
  };
  const milkOptions = () =>
    state.tables.addon_options
      .filter((o) => o.addon_group_id === MILK)
      .map((o) => [o.name, o.price_inr])
      .sort();

  it('puts back the group, the options it changed, and removes the option it added; approving again adds it once', async () => {
    const res = await editGroup(jsonReq('PATCH', `/api/addon-groups/${MILK}`, groupEdit), ctx(MILK));
    const pending = await staffRequest(res);
    // The update of the last option (Oat milk, after Almond was inserted) fails.
    failOnce('addon_options', 'update', (p) => (p as Row).name === 'Oat milk');
    expect((await approve(pending.id)).status).toBe(500);
    expect(state.tables.addon_groups.find((g) => g.id === MILK)?.display_name).toBe('Choice of Milk');
    expect(milkOptions()).toEqual([
      ['Oat milk', 40],
      ['Regular', 0],
    ]);
    expect(requests()[0].status).toBe('pending');

    expect((await approve(pending.id)).status).toBe(200);
    expect(milkOptions()).toEqual([
      ['Almond milk', 50],
      ['Oat milk', 45],
      ['Regular', 0],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Interrupted approvals are detectable
// ---------------------------------------------------------------------------

describe('the applied stamp', () => {
  it('is written when an edit, a create or a delete is applied', async () => {
    const edit = await staffRequest(await patchAs({ name: 'Oat Latte' }));
    const res = await approve(edit.id);
    const out = await read<{ request: MenuChangeRequest }>(res);
    expect(out.request.applied_at).toBeTruthy();
    expect(requests()[0].applied_at).toBe(out.request.applied_at);

    const created = await staffRequest(
      await staffCreate(jsonReq('POST', '/api/menu', { name: 'Flat White', category: 'Coffee', variants: [{ label: 'Regular', price_inr: 170 }] })),
    );
    await approve(created.id);
    const stored = requests().find((r) => r.id === created.id)!;
    expect(stored.applied_at).toBeTruthy();
    expect(stored.menu_item_id).toBeTruthy();

    const del = await staffRequest(await staffDelete(jsonReq('DELETE', `/api/menu/${ITEM}`), ctx(ITEM)));
    await approve(del.id);
    expect(requests().find((r) => r.id === del.id)?.applied_at).toBeTruthy();
  });

  it('is never written for an approval that failed (so it is pending again, not "applied")', async () => {
    const pending = await staffRequest(await patchAs(BIG_EDIT));
    failOnce('menu_item_variants', 'insert');
    await approve(pending.id);
    expect(requests()[0]).toMatchObject({ status: 'pending', applied_at: null });
  });

  it('an approval whose put-back failed stays approved, unstamped — and so shows as unconfirmed', async () => {
    const pending = await staffRequest(await patchAs(BIG_EDIT));
    let putBackTried = false;
    state.fail = (t, op, payload) => {
      if (t === 'menu_item_variants' && op === 'insert') return { message: 'boom' };
      if (t === 'menu_change_requests' && op === 'update' && (payload as Row).status === 'pending') {
        putBackTried = true;
        return { message: 'connection lost' };
      }
      return null;
    };
    await approve(pending.id);
    expect(putBackTried).toBe(true);
    const row = requests()[0];
    expect(row).toMatchObject({ status: 'approved', applied_at: null });
    const later = new Date(new Date(row.decided_at as string).getTime() + APPLY_GRACE_MS + 1000);
    expect(approvalUnconfirmed(row, later)).toBe(true);
    // The item was left as it was all the same.
    expect(item()?.name).toBe('Latte');
  });

  it('on a database without the column, a create still gets its item linked', async () => {
    withAppliedAt = false;
    state.tables.menu_change_requests = [];
    const created = await staffRequest(
      await staffCreate(jsonReq('POST', '/api/menu', { name: 'Flat White', category: 'Coffee', variants: [{ label: 'Regular', price_inr: 170 }] })),
    );
    const res = await approve(created.id);
    expect(res.status).toBe(200);
    const out = await read<{ request: MenuChangeRequest }>(res);
    expect(out.request).not.toHaveProperty('applied_at');
    const stored = requests()[0];
    expect(stored.menu_item_id).toBeTruthy();
    expect(stored).not.toHaveProperty('applied_at');
    expect(approvalUnconfirmed(stored)).toBe(false);
  });
});
