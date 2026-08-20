import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

// Handler-level tests for the device registry (DEV-2/DEV-3). The properties
// worth pinning here are the ones no type checks and no UI review can see:
// the plaintext secret exists ONLY in the Set-Cookie header, the response never
// carries the stored hash, re-enrolling re-keys the machine in place, and
// revoking the machine you are on takes its cookie with it.

interface DeviceRow {
  id: string;
  name: string;
  default_order_type?: string | null;
  auto_print_kot?: boolean | null;
  auto_print_bill?: boolean | null;
  revoked_at?: string | null;
}

const state: {
  owner: { id: string } | null;
  /** What getEnrolledDevice() reports for the machine making the request. */
  currentDevice: DeviceRow | null;
  insertResult: { data: DeviceRow | null; error: { code?: string; message?: string } | null };
  updateResult: { data: DeviceRow | null; error: { code?: string; message?: string } | null };
  listResult: DeviceRow[];
  insertPayload?: Record<string, unknown>;
  updatePatch?: Record<string, unknown>;
  /** ids passed to .eq('id', …) on an update — the re-key write shows up here. */
  updatedIds: string[];
} = {
  owner: { id: 'owner-1' },
  currentDevice: null,
  insertResult: { data: { id: 'd1', name: 'Counter 1' }, error: null },
  updateResult: { data: { id: 'd1', name: 'Counter 1' }, error: null },
  listResult: [],
  updatedIds: [],
};

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: () => {
      let isUpdate = false;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        insert: (p: Record<string, unknown>) => {
          state.insertPayload = p;
          return chain;
        },
        update: (p: Record<string, unknown>) => {
          isUpdate = true;
          state.updatePatch = p;
          return chain;
        },
        eq: (col: string, val: string) => {
          if (isUpdate && col === 'id') state.updatedIds.push(val);
          return chain;
        },
        is: () => chain,
        // GET's terminal call.
        order: () => Promise.resolve({ data: state.listResult, error: null }),
        single: () => Promise.resolve(state.insertResult),
        maybeSingle: () => Promise.resolve(state.updateResult),
        // Some writes await the chain itself, with no select on the end.
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

vi.mock('@/lib/api/device', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/device')>('@/lib/api/device');
  return {
    DEVICE_COLUMNS: actual.DEVICE_COLUMNS,
    getEnrolledDevice: () => Promise.resolve(state.currentDevice),
    touchDeviceSeen: () => Promise.resolve(),
  };
});

const { GET, POST, PATCH } = await import('@/app/api/owner/devices/route');

function req(body: unknown, host = 'hioc.in') {
  return new Request('https://hioc.in/api/owner/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host },
    body: JSON.stringify(body),
  });
}

/** The token as the browser would receive it, out of the Set-Cookie header. */
function cookieToken(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  const m = raw?.match(/hioc_device=([^;]*)/);
  return m ? m[1] : null;
}

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.currentDevice = null;
  state.insertResult = { data: { id: 'd1', name: 'Counter 1' }, error: null };
  state.updateResult = { data: { id: 'd1', name: 'Counter 1' }, error: null };
  state.listResult = [];
  state.insertPayload = undefined;
  state.updatePatch = undefined;
  state.updatedIds = [];
});

describe('owner device registry (DEV-2)', () => {
  it('403s every method for a non-owner', async () => {
    state.owner = null;
    expect((await GET()).status).toBe(403);
    expect((await POST(req({ name: 'Counter 1' }))).status).toBe(403);
    expect((await PATCH(req({ id: 'd1', name: 'Till' }))).status).toBe(403);
  });

  it('stores only the hash, and hands the plaintext to the browser once', async () => {
    const res = await POST(req({ name: 'Counter 1' }));
    expect(res.status).toBe(200);

    const token = cookieToken(res);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // What went into the database is the hash of what went into the cookie —
    // and the plaintext appears nowhere else.
    const stored = state.insertPayload?.token_hash as string;
    expect(stored).toBe(createHash('sha256').update(token as string).digest('hex'));
    expect(stored).not.toBe(token);
    expect(JSON.stringify(await res.clone().json())).not.toContain(token);
    expect(state.insertPayload?.enrolled_by).toBe('owner-1');
  });

  it('sets the cookie httpOnly, Secure-agnostic, and scoped to the parent domain', async () => {
    const raw = (await POST(req({ name: 'Counter 1' }, 'staff.hioc.in'))).headers.get('set-cookie') ?? '';
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=lax/i);
    // Enrolled from the staff subdomain, readable on the owner one: the same
    // machine, not two.
    expect(raw).toMatch(/Domain=hioc\.in/i);
  });

  it('re-keys the row an enrolled machine already has, instead of adding one', async () => {
    state.currentDevice = { id: 'old-1', name: 'Counter 1' };
    state.updateResult = { data: { id: 'old-1', name: 'Till' }, error: null };

    const res = await POST(req({ name: 'Till' }));
    const body = await res.json();
    expect(body.rekeyed).toBe(true);
    expect(body.renamedFrom).toBe('Counter 1');
    expect(state.updatedIds).toContain('old-1');
    expect(state.insertPayload).toBeUndefined();
    // A new secret, and no second row to leave lying around active.
    expect(state.updatePatch?.token_hash).toEqual(expect.any(String));
    expect(state.updatePatch?.name).toBe('Till');
  });

  it('lets a machine re-key under the SAME name', async () => {
    // The ordinary re-enrollment. Inserting first and retiring afterwards would
    // collide with this machine's own name on the active-name index and come
    // back "already enrolled" — for the machine that already holds it.
    state.currentDevice = { id: 'old-1', name: 'Counter 1' };
    state.updateResult = { data: { id: 'old-1', name: 'Counter 1' }, error: null };

    const res = await POST(req({ name: 'Counter 1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rekeyed).toBe(true);
    expect(body.renamedFrom).toBeNull(); // nothing to report — same name
    expect(cookieToken(res)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('leaves the enrollment history alone when re-keying', async () => {
    state.currentDevice = { id: 'old-1', name: 'Counter 1' };
    state.updateResult = { data: { id: 'old-1', name: 'Counter 1' }, error: null };
    await POST(req({ name: 'Counter 1' }));
    // When this machine became known, and to whom, is not changed by handing it
    // a new key.
    expect(state.updatePatch).not.toHaveProperty('enrolled_at');
    expect(state.updatePatch).not.toHaveProperty('enrolled_by');
  });

  it('refuses a name another live device already answers to', async () => {
    state.insertResult = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const res = await POST(req({ name: 'Counter 1' }));
    expect(res.status).toBe(409);
    // And no cookie: a failed enrollment must not leave a secret behind.
    expect(cookieToken(res)).toBeNull();
  });

  it('names the missing migration instead of leaking PostgREST wording', async () => {
    // PostgREST answers PGRST205 ("Could not find the table … in the schema
    // cache"); the raw Postgres code only shows up through an RPC. Both mean
    // the same thing to the only person who will ever see this: the owner, on
    // the deploy where the migration has not been applied yet.
    for (const error of [
      { code: 'PGRST205', message: "Could not find the table 'public.pos_devices' in the schema cache" },
      { code: '42P01', message: 'relation does not exist' },
    ]) {
      state.insertResult = { data: null, error };
      const res = await POST(req({ name: 'Counter 1' }));
      expect((await res.json()).error).toContain('2026-08-pos-devices.sql');
    }
  });

  it('requires a name', async () => {
    expect((await POST(req({ name: '   ' }))).status).toBe(400);
  });
});

describe('device settings and revocation (DEV-2/DEV-3)', () => {
  it('accepts null as "defer to the store setting"', async () => {
    await PATCH(req({ id: 'd1', auto_print_kot: null, default_order_type: null }));
    // Present in the patch as null, not dropped — dropping it would make
    // "go back to the store setting" impossible to express.
    expect(state.updatePatch).toHaveProperty('auto_print_kot', null);
    expect(state.updatePatch).toHaveProperty('default_order_type', null);
  });

  it('accepts false as an answer, not as an absence', async () => {
    await PATCH(req({ id: 'd1', auto_print_bill: false }));
    expect(state.updatePatch).toHaveProperty('auto_print_bill', false);
  });

  it('refuses an order type the counter cannot mean', async () => {
    const res = await PATCH(req({ id: 'd1', default_order_type: 'delivery' }));
    expect(res.status).toBe(400);
  });

  it('rejects a patch that would change nothing', async () => {
    expect((await PATCH(req({ id: 'd1' }))).status).toBe(400);
  });

  it('404s a device that is already revoked', async () => {
    // The update is scoped to live rows, so PostgREST returns no row rather
    // than an error.
    state.updateResult = { data: null, error: null };
    const res = await PATCH(req({ id: 'gone', revoke: true }));
    expect(res.status).toBe(404);
  });

  it('clears the cookie when the machine revokes ITSELF', async () => {
    state.currentDevice = { id: 'd1', name: 'Counter 1' };
    state.updateResult = { data: { id: 'd1', name: 'Counter 1' }, error: null };
    const res = await PATCH(req({ id: 'd1', revoke: true }));
    const raw = res.headers.get('set-cookie') ?? '';
    expect(raw).toMatch(/hioc_device=;/);
    expect(raw).toMatch(/Max-Age=0/i);
  });

  it('leaves this machine alone when revoking a different one', async () => {
    state.currentDevice = { id: 'd1', name: 'Counter 1' };
    state.updateResult = { data: { id: 'd2', name: 'Event stand' }, error: null };
    const res = await PATCH(req({ id: 'd2', revoke: true }));
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
