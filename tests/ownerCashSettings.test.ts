import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for the cash-count fields on
// PATCH /api/owner/attendance-settings (docs/PHASE-5-CASH-COUNTS.md, CC-4):
// cash_count_required (boolean) and cash_count_tolerance_inr (0–500), plus a
// regression check — a PATCH naming only one non-numeric field (store_networks
// or the cash-count fields) used to 400 "No writable settings fields
// provided" because that check ran before those fields were even computed.

type Row = Record<string, unknown>;

const BASE_ROW: Row = {
  id: 'as-1',
  is_singleton: true,
  store_lat: 28.6,
  store_lng: 77.2,
  geofence_radius_m: 150,
  max_accuracy_m: 100,
  max_fix_age_sec: 60,
  grace_period_min: 15,
  late_marks_per_halfday: 3,
  ot_threshold_min: 0,
  ot_multiplier: 1,
  auto_break_min: 0,
  auto_break_after_min: 360,
  half_day_min_minutes: 240,
  absent_below_minutes: 120,
  auto_close_grace_min: 120,
  max_session_hours: 14,
  location_retention_days: 365,
  max_leave_days_per_week: 1,
  store_networks: [] as string[],
  updated_by: null,
  updated_at: '',
};

const state: { owner: { id: string } | null; row: Row; cashColumnsExist: boolean } = {
  owner: { id: 'owner-1' },
  row: { ...BASE_ROW },
  cashColumnsExist: true,
};

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (table !== 'attendance_settings') throw new Error(`unexpected table ${table}`);
      let updatePayload: Row | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        update: (p: Row) => {
          updatePayload = p;
          return chain;
        },
        maybeSingle: () => {
          if (!updatePayload) return Promise.resolve({ data: { ...state.row }, error: null });
          const missing = Object.keys(updatePayload).find(
            (k) => (k === 'cash_count_required' || k === 'cash_count_tolerance_inr') && !state.cashColumnsExist,
          );
          if (missing) {
            return Promise.resolve({
              data: null,
              error: { code: 'PGRST204', message: `Could not find the '${missing}' column of 'attendance_settings' in the schema cache` },
            });
          }
          Object.assign(state.row, updatePayload);
          return Promise.resolve({ data: { ...state.row }, error: null });
        },
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

const { PATCH } = await import('@/app/api/owner/attendance-settings/route');

function req(body: unknown) {
  return new Request('http://t/api/owner/attendance-settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.row = { ...BASE_ROW, store_networks: [] };
  state.cashColumnsExist = true;
});

describe('PATCH /api/owner/attendance-settings — cash counts (CC-4)', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    const res = await PATCH(req({ cash_count_required: true }));
    expect(res.status).toBe(403);
  });

  it('turns the requirement on and off', async () => {
    const on = await PATCH(req({ cash_count_required: true }));
    expect(on.status).toBe(200);
    expect((await on.json()).settings.cash_count_required).toBe(true);

    const off = await PATCH(req({ cash_count_required: false }));
    expect(off.status).toBe(200);
    expect((await off.json()).settings.cash_count_required).toBe(false);
  });

  it('rejects a non-boolean cash_count_required', async () => {
    const res = await PATCH(req({ cash_count_required: 'yes' }));
    expect(res.status).toBe(400);
  });

  it('accepts a tolerance within 0-500', async () => {
    const res = await PATCH(req({ cash_count_tolerance_inr: 50 }));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.cash_count_tolerance_inr).toBe(50);
  });

  it('rejects a tolerance outside 0-500 or non-integer', async () => {
    expect((await PATCH(req({ cash_count_tolerance_inr: -1 }))).status).toBe(400);
    expect((await PATCH(req({ cash_count_tolerance_inr: 501 }))).status).toBe(400);
    expect((await PATCH(req({ cash_count_tolerance_inr: 12.5 }))).status).toBe(400);
  });

  it('a store_networks-only PATCH now succeeds (previously 400d before the fix)', async () => {
    const res = await PATCH(req({ store_networks: ['49.36.12.34'] }));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.store_networks).toEqual(['49.36.12.34']);
  });

  it('a cash-count-only PATCH succeeds without touching other fields', async () => {
    const res = await PATCH(req({ cash_count_tolerance_inr: 100 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.cash_count_tolerance_inr).toBe(100);
    expect(body.settings.geofence_radius_m).toBe(BASE_ROW.geofence_radius_m);
  });

  it('400s a PATCH with nothing to update', async () => {
    const res = await PATCH(req({}));
    expect(res.status).toBe(400);
  });

  it('409s with a clear message when the migration has not been applied', async () => {
    state.cashColumnsExist = false;
    const res = await PATCH(req({ cash_count_required: true }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/2026-09-cash-counts\.sql/);
  });
});
