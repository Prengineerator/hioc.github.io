import { beforeEach, describe, expect, it, vi } from 'vitest';

// Staff surface (lib/staff/surface.ts): these requests come from the POS unless
// a test sets globalThis.__staffSurface = 'web'.
vi.mock('@/lib/staff/surface', () => ({
  getStaffSurface: () =>
    Promise.resolve((globalThis as { __staffSurface?: 'pos' | 'web' }).__staffSurface ?? 'pos'),
}));


// PIN-3 — POST /api/menu, PATCH+DELETE /api/menu/[id], POST /api/menu/upload,
// all migrated to getCounterActor(). Focus: the auth + permission gate on
// each (menu_edit, hasPermission with roleHint) for both a classic session
// and an enrolled-device operator. None of these had a route test before.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  permitted: boolean;
} = { actor: null, permitted: true };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));

const hasPermissionCalls: unknown[][] = [];
vi.mock('@/lib/permissions', () => ({
  hasPermission: (...args: unknown[]) => {
    hasPermissionCalls.push(args);
    return Promise.resolve(state.permitted);
  },
}));

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        insert: () => chain,
        update: () => chain,
        delete: () => chain,
        maybeSingle: () => Promise.resolve({ data: { id: 'item-1' }, error: null }),
        single: () => Promise.resolve({ data: { id: 'item-1' }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      });
      return chain;
    },
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://x/menu-images/f.jpg' } }),
      }),
    },
  }),
}));

const ITEM_ID = '11111111-1111-1111-1111-111111111111';

const { POST: createMenuItem } = await import('@/app/api/menu/route');
const { PATCH: patchMenuItem, DELETE: deleteMenuItem } = await import('@/app/api/menu/[id]/route');
const { POST: uploadMenuImage } = await import('@/app/api/menu/upload/route');

beforeEach(() => {
  state.actor = null;
  state.permitted = true;
  hasPermissionCalls.length = 0;
});

describe('POST /api/menu (create)', () => {
  const POST = createMenuItem;
  function req(body: unknown) {
    return new Request('https://hioc.in/api/menu', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const body = { name: 'Latte', category: 'Coffee', variants: [{ label: 'Regular', price_inr: 150 }] };

  it('401s with no session and no operator', async () => {
    expect((await POST(req(body))).status).toBe(401);
  });

  it('403s without menu_edit permission', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.permitted = false;
    expect((await POST(req(body))).status).toBe(403);
  });

  it('PIN-3: an enrolled-device operator can create a menu item', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    expect((await POST(req(body))).status).toBe(201);
    expect(hasPermissionCalls[0]).toEqual([{ id: 'ravi' }, 'menu_edit', 'staff']);
  });

  it('refuses menu changes from the staff website, even for the owner', async () => {
    const g = globalThis as { __staffSurface?: 'pos' | 'web' };
    g.__staffSurface = 'web';
    try {
      state.actor = { user: { id: 'owner-1' }, role: 'owner', via: 'session' };
      const res = await POST(req(body));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('Menu changes can only be made on the POS.');
    } finally {
      g.__staffSurface = undefined;
    }
  });
});

describe('PATCH /api/menu/[id] (availability toggle + edit)', () => {
  const PATCH = patchMenuItem;
  const ctx = { params: { id: ITEM_ID } };
  function req(body: unknown) {
    return new Request(`https://hioc.in/api/menu/${ITEM_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('401s with no session and no operator', async () => {
    expect((await PATCH(req({ is_available: false }), ctx)).status).toBe(401);
  });

  it('403s without menu_edit permission', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.permitted = false;
    expect((await PATCH(req({ is_available: false }), ctx)).status).toBe(403);
  });

  it('PIN-3: an enrolled-device operator can toggle availability (the "86 it" action)', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const res = await PATCH(req({ is_available: false }), ctx);
    expect(res.status).toBe(200);
    expect(hasPermissionCalls[0]).toEqual([{ id: 'ravi' }, 'menu_edit', 'staff']);
  });
});

describe('DELETE /api/menu/[id]', () => {
  const DELETE = deleteMenuItem;
  const ctx = { params: { id: ITEM_ID } };

  it('401s with no session and no operator', async () => {
    expect((await DELETE(new Request('https://x'), ctx)).status).toBe(401);
  });

  it('PIN-3: an enrolled-device operator can delete', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    expect((await DELETE(new Request('https://x'), ctx)).status).toBe(200);
  });
});

describe('POST /api/menu/upload', () => {
  const POST = uploadMenuImage;

  it('401s with no session and no operator', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    const res = await POST(new Request('https://hioc.in/api/menu/upload', { method: 'POST', body: form }));
    expect(res.status).toBe(401);
  });

  it('PIN-3: an enrolled-device operator can upload an image', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    const res = await POST(new Request('https://hioc.in/api/menu/upload', { method: 'POST', body: form }));
    expect(res.status).toBe(201);
  });
});
