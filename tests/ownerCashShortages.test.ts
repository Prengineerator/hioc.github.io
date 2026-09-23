import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for the owner cash-shortage review queue
// (docs/PHASE-5-CASH-COUNTS.md, CC-4). Covers the decision rules that live
// only in app/api/owner/cash-shortages/**: only a pending shortage can be
// decided, an approve/waive already applied (or locked by payroll) refuses a
// second decision, waive requires a note, and reassign moves who it's
// charged to (user_id) while leaving original_user_id — whose count actually
// revealed it — untouched and status still 'pending'. Mocks the Supabase
// admin client as a tiny in-memory relational store so the route's own logic
// runs without a live DB.

type Row = Record<string, unknown>;
type Filter = { col: string; op: 'eq' | 'in' | 'gte' | 'lte'; val: unknown };

// Route params go through isUuid() (params.id, and userId on reassign), so
// every id below is a valid-looking UUID rather than a readable slug.
const OWNER = '00000000-0000-4000-8000-000000000001';
const ASHA = '00000000-0000-4000-8000-000000000002'; // originally counted the drawer short
const VIKRAM = '00000000-0000-4000-8000-000000000003'; // active — a valid reassign target
const DEACTIVATED = '00000000-0000-4000-8000-000000000004'; // role flipped to 'customer' — not a valid target
const COUNT_0 = '00000000-0000-4000-8000-000000000010'; // Asha's clock-in count (the chain's previous)
const COUNT_1 = '00000000-0000-4000-8000-000000000011'; // Asha's clock-out count — the one that came up short
const S_PENDING = '00000000-0000-4000-8000-000000000020';
const S_WAIVED = '00000000-0000-4000-8000-000000000021';
const S_LOCKED = '00000000-0000-4000-8000-000000000022'; // approved AND paid out (payroll_run_id set)
const RUN_1 = '00000000-0000-4000-8000-000000000030';
const NOT_FOUND = '00000000-0000-4000-8000-0000000000ff';

const tables: Record<string, Row[]> = {};

function resetTables() {
  tables.profiles = [
    { id: OWNER, name: 'The Owner', role: 'owner' },
    { id: ASHA, name: 'Asha', role: 'staff' },
    { id: VIKRAM, name: 'Vikram', role: 'staff' },
    { id: DEACTIVATED, name: 'Old Staffer', role: 'customer' },
  ];
  tables.cash_counts = [
    {
      id: COUNT_0,
      kind: 'clock_in',
      user_id: ASHA,
      counted_total_inr: 4500,
      expected_total_inr: 4500,
      variance_inr: 0,
      previous_count_id: null,
      created_at: '2026-09-20T04:00:00.000Z',
    },
    {
      id: COUNT_1,
      kind: 'clock_out',
      user_id: ASHA,
      counted_total_inr: 4200,
      expected_total_inr: 4540,
      variance_inr: -340,
      previous_count_id: COUNT_0,
      created_at: '2026-09-20T12:00:00.000Z',
    },
  ];
  tables.cash_shortages = [
    {
      id: S_PENDING,
      count_id: COUNT_1,
      user_id: ASHA,
      original_user_id: ASHA,
      amount_inr: 340,
      business_date: '2026-09-20',
      status: 'pending',
      decided_by: null,
      decided_at: null,
      decision_note: '',
      payroll_run_id: null,
      created_at: '2026-09-20T12:00:01.000Z',
    },
    {
      id: S_WAIVED,
      count_id: COUNT_1,
      user_id: ASHA,
      original_user_id: ASHA,
      amount_inr: 100,
      business_date: '2026-08-15',
      status: 'waived',
      decided_by: OWNER,
      decided_at: '2026-08-16T00:00:00.000Z',
      decision_note: 'Register was miscounted, forgiven.',
      payroll_run_id: null,
      created_at: '2026-08-15T12:00:00.000Z',
    },
    {
      id: S_LOCKED,
      count_id: COUNT_1,
      user_id: VIKRAM,
      original_user_id: VIKRAM,
      amount_inr: 500,
      business_date: '2026-07-10',
      status: 'approved',
      decided_by: OWNER,
      decided_at: '2026-07-11T00:00:00.000Z',
      decision_note: 'Approved.',
      payroll_run_id: RUN_1,
      created_at: '2026-07-10T12:00:00.000Z',
    },
  ];
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(({ col, op, val }) => {
    const v = row[col];
    if (op === 'eq') return v === val;
    if (op === 'in') return Array.isArray(val) && (val as unknown[]).includes(v);
    if (op === 'gte') return String(v) >= String(val);
    if (op === 'lte') return String(v) <= String(val);
    return true;
  });
}

function makeAdmin() {
  function from(table: string) {
    const filters: Filter[] = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let updatePayload: Row | null = null;

    function currentRows(): Row[] {
      let r = (tables[table] ?? []).filter((row) => matches(row, filters));
      if (orderCol) {
        const col = orderCol;
        r = [...r].sort((a, b) => {
          const av = String(a[col]);
          const bv = String(b[col]);
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return orderAsc ? cmp : -cmp;
        });
      }
      if (limitN !== null) r = r.slice(0, limitN);
      return r;
    }

    function applyUpdateAndReturn(): { data: Row[]; error: null } {
      if (updatePayload) {
        const targets = (tables[table] ?? []).filter((row) => matches(row, filters));
        for (const row of targets) Object.assign(row, updatePayload);
      }
      return { data: currentRows(), error: null };
    }

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push({ col, op: 'eq', val });
        return chain;
      },
      in: (col: string, val: unknown[]) => {
        filters.push({ col, op: 'in', val });
        return chain;
      },
      gte: (col: string, val: unknown) => {
        filters.push({ col, op: 'gte', val });
        return chain;
      },
      lte: (col: string, val: unknown) => {
        filters.push({ col, op: 'lte', val });
        return chain;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return chain;
      },
      limit: (n: number) => {
        limitN = n;
        return chain;
      },
      update: (payload: Row) => {
        updatePayload = payload;
        return chain;
      },
      maybeSingle: () => {
        const { data } = applyUpdateAndReturn();
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        return Promise.resolve(applyUpdateAndReturn()).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    from,
    auth: {
      admin: {
        listUsers: () => Promise.resolve({ data: { users: [] }, error: null }),
      },
    },
  };
}

const state: { owner: { id: string } | null } = { owner: { id: OWNER } };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => makeAdmin(),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

const { GET } = await import('@/app/api/owner/cash-shortages/route');
const { PATCH } = await import('@/app/api/owner/cash-shortages/[id]/route');

function patchReq(body: unknown) {
  return new Request('http://t/api/owner/cash-shortages/x', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: { id } };
}

beforeEach(() => {
  resetTables();
  state.owner = { id: OWNER };
});

describe('GET /api/owner/cash-shortages', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    const res = await GET(new Request('http://t/api/owner/cash-shortages'));
    expect(res.status).toBe(403);
  });

  it('narrows to one status and enriches with the count that revealed it', async () => {
    const res = await GET(new Request('http://t/api/owner/cash-shortages?status=pending'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shortages).toHaveLength(1);
    const row = body.shortages[0];
    expect(row.id).toBe(S_PENDING);
    expect(row.originalUserName).toBe('Asha');
    expect(row.count.countedTotalInr).toBe(4200);
    expect(row.count.expectedTotalInr).toBe(4540);
    expect(row.previousCount.countedTotalInr).toBe(4500);
    expect(row.previousCount.userName).toBe('Asha');
    expect(row.locked).toBe(false);
  });

  it('400s an unknown status', async () => {
    const res = await GET(new Request('http://t/api/owner/cash-shortages?status=bogus'));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/owner/cash-shortages/[id] — decision rules', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    const res = await PATCH(patchReq({ action: 'approve' }), ctx(S_PENDING));
    expect(res.status).toBe(403);
  });

  it('approves a pending shortage', async () => {
    const res = await PATCH(patchReq({ action: 'approve', note: 'Confirmed with Asha' }), ctx(S_PENDING));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shortage.status).toBe('approved');
    expect(body.shortage.decidedByName).toBe('The Owner');
    expect(body.shortage.decisionNote).toBe('Confirmed with Asha');
  });

  it('refuses to decide an already-decided (non-locked) shortage', async () => {
    const res = await PATCH(patchReq({ action: 'approve' }), ctx(S_WAIVED));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already waived/i);
  });

  it('refuses to decide a locked (paid-out) shortage, with a specific message', async () => {
    const res = await PATCH(patchReq({ action: 'waive', note: 'try to undo' }), ctx(S_LOCKED));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/paid out/i);
  });

  it('waive requires a note', async () => {
    const noNote = await PATCH(patchReq({ action: 'waive' }), ctx(S_PENDING));
    expect(noNote.status).toBe(400);

    const blankNote = await PATCH(patchReq({ action: 'waive', note: '   ' }), ctx(S_PENDING));
    expect(blankNote.status).toBe(400);

    const withNote = await PATCH(
      patchReq({ action: 'waive', note: 'Drawer was recounted, forgiven' }),
      ctx(S_PENDING),
    );
    expect(withNote.status).toBe(200);
    const body = await withNote.json();
    expect(body.shortage.status).toBe('waived');
  });

  it('reassign moves user_id, keeps original_user_id, and stays pending', async () => {
    const res = await PATCH(
      patchReq({ action: 'reassign', userId: VIKRAM, note: 'Vikram was actually on the register' }),
      ctx(S_PENDING),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shortage.status).toBe('pending'); // still awaiting the owner's approve/waive
    expect(body.shortage.userId).toBe(VIKRAM);
    expect(body.shortage.userName).toBe('Vikram');
    expect(body.shortage.originalUserId).toBe(ASHA); // whose count revealed it — never changes
    expect(body.shortage.originalUserName).toBe('Asha');
    expect(body.shortage.decidedBy).toBeNull(); // reassign is not a decision
    expect(body.shortage.decidedAt).toBeNull();

    // The owner can still decide it under the new person afterwards.
    const approved = await PATCH(patchReq({ action: 'approve' }), ctx(S_PENDING));
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    expect(approvedBody.shortage.status).toBe('approved');
    expect(approvedBody.shortage.userId).toBe(VIKRAM);
    expect(approvedBody.shortage.originalUserId).toBe(ASHA);
  });

  it('reassign requires a note and a real userId', async () => {
    const noNote = await PATCH(patchReq({ action: 'reassign', userId: VIKRAM }), ctx(S_PENDING));
    expect(noNote.status).toBe(400);

    const badUser = await PATCH(patchReq({ action: 'reassign', userId: 'not-a-uuid', note: 'x' }), ctx(S_PENDING));
    expect(badUser.status).toBe(400);
  });

  it('refuses to reassign to a deactivated account', async () => {
    const res = await PATCH(patchReq({ action: 'reassign', userId: DEACTIVATED, note: 'try anyway' }), ctx(S_PENDING));
    expect(res.status).toBe(400);
  });

  it('400s an unknown action', async () => {
    const res = await PATCH(patchReq({ action: 'delete' }), ctx(S_PENDING));
    expect(res.status).toBe(400);
  });

  it('404s an id that does not exist', async () => {
    const res = await PATCH(patchReq({ action: 'approve' }), ctx(NOT_FOUND));
    expect(res.status).toBe(404);
  });
});
