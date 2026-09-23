import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-2/DEV-3 — /api/device/context, the POS's boot read.
//
// The one that matters: A DEVICE COOKIE ALONE GRANTS NOTHING. The device layer
// exists to carry settings and, from 6C, to host the operator switch — never to
// authorise. So an enrolled machine with no signed-in staffer must be refused
// exactly as a bare browser is, and the enrolled name must not come back.

const state: {
  staff: { id: string } | null;
  device: Record<string, unknown> | null;
  touched: string[];
} = { staff: { id: 'u1' }, device: null, touched: [] };

vi.mock('@/lib/api/auth', () => ({ getStaffUser: () => Promise.resolve(state.staff) }));

vi.mock('@/lib/api/device', () => ({
  DEVICE_COLUMNS: 'id, name',
  getEnrolledDevice: () => Promise.resolve(state.device),
  touchDeviceSeen: (d: { id: string }) => {
    state.touched.push(d.id);
    return Promise.resolve();
  },
}));

const { GET } = await import('@/app/api/device/context/route');

const ENROLLED = {
  id: 'd1',
  name: 'Counter 1',
  enrolled_by: 'owner-1',
  enrolled_at: '2026-08-20T00:00:00Z',
  last_seen_at: null,
  revoked_at: null,
  default_order_type: 'takeaway',
  auto_print_kot: false,
  auto_print_bill: null,
};

beforeEach(() => {
  state.staff = { id: 'u1' };
  state.device = null;
  state.touched = [];
});

describe('GET /api/device/context', () => {
  it('refuses an enrolled machine with no staff session', async () => {
    state.staff = null;
    state.device = ENROLLED;
    const res = await GET();
    expect(res.status).toBe(401);
    // Not even the name: a device list is a fact about the cafe's floor.
    expect(JSON.stringify(await res.json())).not.toContain('Counter 1');
    expect(state.touched).toEqual([]);
  });

  it('answers null for a browser that is not a known machine', async () => {
    // A personal phone, a cleared cookie, a revoked till. All normal, none an
    // error — the POS keeps selling on store-level defaults.
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ device: null });
    expect(state.touched).toEqual([]);
  });

  it('returns the machine and its defaults, and nothing else', async () => {
    state.device = ENROLLED;
    const res = await GET();
    const body = await res.json();
    expect(body.device).toEqual({
      id: 'd1',
      name: 'Counter 1',
      default_order_type: 'takeaway',
      // false and null are distinct answers all the way out to the client.
      auto_print_kot: false,
      auto_print_bill: null,
    });
    // Enrollment metadata is the owner screen's business, not the POS's.
    expect(body.device).not.toHaveProperty('enrolled_by');
    expect(body.device).not.toHaveProperty('token_hash');
  });

  it('records that the machine was seen', async () => {
    state.device = ENROLLED;
    await GET();
    expect(state.touched).toEqual(['d1']);
  });
});
