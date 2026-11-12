import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeMenuAdmin, uuid, type Row } from './helpers/fakeMenuAdmin';
import {
  clearsStaleSnooze,
  endOfDayIstIso,
  isMenuItemAvailable,
  manualAvailabilityBody,
  menuItemAvailability,
} from '@/lib/menu/availability';

// Effective availability incl. 86/snooze auto-reenable (S6/C3), no cron.
const now = new Date('2026-07-15T06:30:00Z');

describe('isMenuItemAvailable', () => {
  it('is available when manually available and not snoozed', () => {
    expect(isMenuItemAvailable({ is_available: true, unavailable_until: null }, now)).toBe(true);
  });

  it('is unavailable when manually turned off', () => {
    expect(isMenuItemAvailable({ is_available: false, unavailable_until: null }, now)).toBe(false);
  });

  it('is unavailable while inside a future snooze window', () => {
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    expect(isMenuItemAvailable({ is_available: true, unavailable_until: future }, now)).toBe(false);
  });

  it('auto-reenables once the snooze window has passed', () => {
    const past = new Date(now.getTime() - 60 * 1000).toISOString();
    expect(isMenuItemAvailable({ is_available: true, unavailable_until: past }, now)).toBe(true);
  });
});

// The three columns read as one state (lib/menu/availability.ts), the one the
// staff and owner menu tables label and the API's isMenuItemAvailable reads.
describe('menuItemAvailability', () => {
  const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const past = new Date(now.getTime() - 60 * 1000).toISOString();

  it('reads every combination of the columns', () => {
    expect(menuItemAvailability({ is_available: true, unavailable_until: null }, now)).toEqual({ state: 'available', until: null });
    expect(menuItemAvailability({ is_available: true, unavailable_until: past }, now)).toEqual({ state: 'available', until: null });
    expect(menuItemAvailability({ is_available: true, unavailable_until: future }, now)).toEqual({ state: 'snoozed', until: future });
    expect(menuItemAvailability({ is_available: false, unavailable_until: null }, now)).toEqual({ state: 'sold_out', until: null });
    // A person's sold-out wins over any snooze time left on the row.
    expect(menuItemAvailability({ is_available: false, unavailable_until: future }, now)).toEqual({ state: 'sold_out', until: null });
    expect(menuItemAvailability({ is_available: false, unavailable_until: null, stock_out_auto: true }, now)).toEqual({
      state: 'out_of_stock',
      until: null,
    });
    // The auto-hide mark means nothing on an item that is on.
    expect(menuItemAvailability({ is_available: true, unavailable_until: null, stock_out_auto: true }, now).state).toBe('available');
  });

  it('agrees with isMenuItemAvailable', () => {
    for (const is_available of [true, false]) {
      for (const unavailable_until of [null, past, future]) {
        const row = { is_available, unavailable_until };
        expect(isMenuItemAvailable(row, now)).toBe(menuItemAvailability(row, now).state === 'available');
      }
    }
  });
});

describe('manualAvailabilityBody', () => {
  it('names both columns for every click, so no click leaves an old snooze behind', () => {
    expect(manualAvailabilityBody('indefinite', now)).toEqual({ is_available: false, unavailable_until: null });
    expect(manualAvailabilityBody('back_on', now)).toEqual({ is_available: true, unavailable_until: null });
    expect(manualAvailabilityBody('2h', now)).toEqual({ is_available: true, unavailable_until: '2026-07-15T08:30:00.000Z' });
    expect(manualAvailabilityBody('eod', now)).toEqual({ is_available: true, unavailable_until: endOfDayIstIso(now) });
  });

  it('ends "today" at midnight IST', () => {
    // 06:30 UTC on 15 Jul is 12:00 IST; the day ends at 18:30 UTC.
    expect(endOfDayIstIso(now)).toBe('2026-07-15T18:30:00.000Z');
    // 20:00 UTC is already 16 Jul 01:30 IST.
    expect(endOfDayIstIso(new Date('2026-07-15T20:00:00Z'))).toBe('2026-07-16T18:30:00.000Z');
  });
});

describe('clearsStaleSnooze', () => {
  const until = '2026-07-15T18:30:00.000Z';

  it('is true when a sold-out item with a snooze on it is switched back on without naming the snooze', () => {
    expect(clearsStaleSnooze({ is_available: false, unavailable_until: until }, { is_available: true })).toBe(true);
  });

  it('is false otherwise', () => {
    // Nothing to clear.
    expect(clearsStaleSnooze({ is_available: false, unavailable_until: null }, { is_available: true })).toBe(false);
    // The edit says what the snooze should be.
    expect(clearsStaleSnooze({ is_available: false, unavailable_until: until }, { is_available: true, unavailable_until: until })).toBe(false);
    // An available item kept available (an edit form saving another field) keeps its snooze.
    expect(clearsStaleSnooze({ is_available: true, unavailable_until: until }, { is_available: true })).toBe(false);
    // Switching off.
    expect(clearsStaleSnooze({ is_available: false, unavailable_until: until }, { is_available: false })).toBe(false);
    expect(clearsStaleSnooze({ is_available: false, unavailable_until: until }, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The routes: switching an item back on clears a stale snooze
// ---------------------------------------------------------------------------

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  owner: { id: string } | null;
  tables: Record<string, Row[]>;
  db: ReturnType<typeof makeFakeMenuAdmin>;
} = { actor: null, owner: null, tables: {}, db: makeFakeMenuAdmin({}) };

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
const SNOOZE = '2099-01-01T00:00:00.000Z';
const { PATCH: staffPatch } = await import('@/app/api/menu/[id]/route');
const { PATCH: ownerPatch } = await import('@/app/api/owner/menu/[id]/route');

const req = (url: string, body: unknown) =>
  new Request(`https://hioc.in${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const item = () => state.tables.menu_items[0];

/** What the edit form sends: every field, as the item stands unless overridden. */
const form = (over: Record<string, unknown> = {}) => ({
  name: 'Latte',
  description: '',
  category: 'Coffee',
  parent_category: 'Hot',
  is_veg: true,
  is_available: false,
  in_store_only: false,
  gst_exempt: false,
  sold_by_weight: false,
  sort_order: 0,
  image_url: '',
  short_code: null,
  variants: [{ label: 'Regular', price_inr: 150 }],
  addon_group_ids: [],
  ...over,
});

beforeEach(() => {
  state.tables = {
    menu_items: [
      {
        id: ITEM,
        name: 'Latte',
        description: '',
        category: 'Coffee',
        parent_category: 'Hot',
        is_veg: true,
        // Sold out by hand, with a snooze from before still on the row.
        is_available: false,
        unavailable_until: SNOOZE,
        sort_order: 0,
        image_url: '',
        short_code: null,
        in_store_only: false,
        gst_exempt: false,
      },
    ],
    menu_item_variants: [{ id: uuid(21), menu_item_id: ITEM, label: 'Regular', price_inr: 150, sort_order: 0 }],
    menu_item_addon_groups: [],
    addon_groups: [],
    menu_change_requests: [],
    profiles: [],
  };
  state.db = makeFakeMenuAdmin(state.tables);
  state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
  state.owner = { id: 'owner-1' };
});

describe('switching an item back on', () => {
  it('a staff edit form that only moved the switch: on, and not still snoozed', async () => {
    expect((await staffPatch(req(`/api/menu/${ITEM}`, form({ is_available: true })), { params: { id: ITEM } })).status).toBe(200);
    expect(item()).toMatchObject({ is_available: true, unavailable_until: null });
    expect(isMenuItemAvailable(item() as { is_available: boolean; unavailable_until: string | null })).toBe(true);
  });

  it('the owner\'s edit form too', async () => {
    expect((await ownerPatch(req(`/api/owner/menu/${ITEM}`, form({ is_available: true })), { params: { id: ITEM } })).status).toBe(200);
    expect(item()).toMatchObject({ is_available: true, unavailable_until: null });
  });

  it('a body that names the snooze keeps what it says', async () => {
    const later = '2099-06-01T00:00:00.000Z';
    await staffPatch(req(`/api/menu/${ITEM}`, { is_available: true, unavailable_until: later }), { params: { id: ITEM } });
    expect(item()).toMatchObject({ is_available: true, unavailable_until: later });
  });

  it('an edit that keeps an available item available leaves its snooze alone', async () => {
    Object.assign(item(), { is_available: true });
    state.actor = { user: { id: 'owner-1' }, role: 'owner', via: 'session' };
    await staffPatch(req(`/api/menu/${ITEM}`, form({ is_available: true, description: 'Milky' })), { params: { id: ITEM } });
    expect(item()).toMatchObject({ is_available: true, unavailable_until: SNOOZE, description: 'Milky' });
  });
});
