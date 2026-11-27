import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The delivery person's WhatsApp list (lib/inventory/pickupAlert.ts,
// docs/WAREHOUSE-SPEC.md WH-D17), through the shared assign action
// (lib/inventory/requestActions.ts): off until the template is named, a team
// member only (number from staff_accounts.phone), claim-before-send, once per
// number per request, a daily limit, the variables, a fixed status for the
// screens, and that nothing about the message can fail or undo the choice.

const MANAGER = '00000000-0000-4000-8000-000000000001';
const VIKRAM = '00000000-0000-4000-8000-000000000003';
const MEERA = '00000000-0000-4000-8000-000000000004';
const REQ = '00000000-0000-4000-8000-0000000000a1';
const TEMPLATE_ENV = 'WHATSAPP_TPL_STOCK_PICKUP';
const LANG_ENV = 'WHATSAPP_TPL_STOCK_PICKUP_LANG';

type Row = Record<string, unknown>;

const state: {
  request: Row;
  profiles: Row[];
  staff: Row[];
  alerts: Row[];
  insertError: { code: string; message: string } | null;
  insertThrows: boolean;
  updates: Row[];
  staffReadError: { code: string; message: string } | null;
  hideReads: number;
} = { request: {}, profiles: [], staff: [], alerts: [], insertError: null, insertThrows: false, updates: [], staffReadError: null, hideReads: 0 };

vi.mock('@/lib/flags', () => ({ flags: new Proxy({}, { get: () => true }) }));
vi.mock('@/lib/url', () => ({ absoluteUrl: (p: string) => `https://hioc.in${p}` }));
vi.mock('@/lib/staff/displayName', () => ({ getStaffDisplayNames: () => Promise.resolve(new Map()) }));
vi.mock('@/lib/cash/date', () => ({ istBusinessDate: () => '2026-11-01' }));
vi.mock('@/lib/api/background', () => ({ runAfterResponse: () => undefined }));
const { waSend, sendStockAssignedEmail } = vi.hoisted(() => ({
  waSend: vi.fn((_input: Record<string, unknown>) => Promise.resolve({ ok: true, providerRef: 'wamid.1', error: '' })),
  sendStockAssignedEmail: vi.fn((_a: unknown, _args: Record<string, unknown>) =>
    Promise.resolve({ kind: 'stock_assigned', status: 'sent', detail: '' }),
  ),
}));
vi.mock('@/lib/notifications/adapters', () => ({ emailAdapter: { send: vi.fn() }, whatsappAdapter: { send: waSend } }));
vi.mock('@/lib/inventory/notify', () => ({ sendStockAssignedEmail }));

let seq = 0;
function makeAdmin() {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let patch: Row | null = null;
      let counting = false;
      let since = '';
      const chain: Record<string, unknown> = {
        select: (_c?: string, opts?: { count?: string }) => {
          counting = opts?.count === 'exact';
          return chain;
        },
        eq: (c: string, v: unknown) => ((filters[c] = v), chain),
        in: (c: string, v: unknown) => ((filters[c] = v), chain),
        gte: (_c: string, v: string) => ((since = v), chain),
        limit: () => chain,
        update: (p: Row) => ((patch = p), chain),
        insert: (row: Row) => {
          if (state.insertThrows) throw new Error('boom');
          let error: { code: string; message: string } | null = state.insertError;
          const dup = state.alerts.some(
            (r) => row.status === 'sent' && r.status === 'sent' && r.event === row.event && r.request_id === row.request_id && r.channel === row.channel && r.to_address === row.to_address,
          );
          if (!error && dup) error = { code: '23505', message: 'duplicate key value (+919812345678)' };
          const id = `row-${++seq}`;
          if (!error) state.alerts.push({ id, created_at: new Date().toISOString(), ...row });
          return {
            select: () => ({ maybeSingle: () => Promise.resolve({ data: error ? null : { id }, error }) }),
            then: (resolve: (v: unknown) => void) => resolve({ error }),
          };
        },
        maybeSingle: () => {
          if (table === 'stock_requests') {
            if (patch) {
              state.updates.push(patch);
              return Promise.resolve({ data: { id: REQ }, error: null });
            }
            return Promise.resolve({ data: state.request, error: null });
          }
          if (table === 'staff_accounts') {
            if (state.staffReadError) return Promise.resolve({ data: null, error: state.staffReadError });
            return Promise.resolve({ data: state.staff.find((p) => p.user_id === filters.user_id) ?? null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === 'warehouse_alerts') {
            if (patch) {
              Object.assign(state.alerts.find((r) => r.id === filters.id) ?? {}, patch);
              return resolve({ error: null });
            }
            if (counting) {
              const n = state.alerts.filter((r) => r.event === filters.event && r.status === filters.status && String(r.created_at) >= since).length;
              return resolve({ data: null, count: n, error: null });
            }
            if (state.hideReads > 0) {
              state.hideReads -= 1;
              return resolve({ data: [], error: null });
            }
            return resolve({
              data: state.alerts.filter(
                (r) => r.event === filters.event && r.request_id === filters.request_id && r.channel === filters.channel && r.to_address === filters.to_address && r.status === filters.status,
              ),
              error: null,
            });
          }
          return resolve({ data: state.profiles, error: null });
        },
      };
      return chain;
    },
  };
}

const { patchStockRequest } = await import('@/lib/inventory/requestActions');
const { pickupItemsVar, pickupNameVar, pickupVars, SEND_TIMEOUT_MS, DAILY_LIMIT } = await import('@/lib/inventory/pickupAlert');
const { withPickupNotice } = await import('@/lib/inventory/pickupNotice');

const manager = { userId: MANAGER, role: 'manager' as const, isManager: true, surface: 'web' as const, deviceId: null };
const assign = async (body: Row) => {
  const res = await patchStockRequest(makeAdmin() as never, manager, REQ, { action: 'assign', ...body }, ['assign']);
  return { status: res.status, json: (await res.json()) as Row };
};

function request(over: Row = {}): Row {
  return {
    id: REQ,
    request_number: 12,
    status: 'requested',
    route: 'from_warehouse',
    requested_by: MEERA,
    assigned_to: null,
    picked_by: null,
    has_discrepancy: false,
    stock_request_lines: [
      { item_id: 'i2', qty_requested: 500, inventory_items: { name: 'Paper cup', unit: 'pcs' } },
      { item_id: 'i1', qty_requested: 20, inventory_items: { name: 'Full-cream milk', unit: 'l' } },
    ],
    ...over,
  };
}

beforeEach(() => {
  process.env[TEMPLATE_ENV] = 'stock_pickup_1';
  delete process.env[LANG_ENV];
  state.request = request();
  // The customer-account number on profiles must never be used.
  state.profiles = [
    { id: MANAGER, name: 'Boss', role: 'manager' },
    { id: VIKRAM, name: 'Vikram', role: 'staff', phone: '+919111111111' },
    { id: MEERA, name: 'Meera', role: 'staff' },
  ];
  state.staff = [
    { user_id: VIKRAM, phone: '+91 98123-45678' },
    { user_id: MEERA, phone: '' },
    { user_id: MANAGER, phone: '9000000001' },
  ];
  state.alerts = [];
  state.insertError = null;
  state.insertThrows = false;
  state.updates = [];
  state.staffReadError = null;
  state.hideReads = 0;
  waSend.mockReset();
  waSend.mockImplementation(() => Promise.resolve({ ok: true, providerRef: 'wamid.1', error: '' }));
  sendStockAssignedEmail.mockClear();
});
afterEach(() => {
  delete process.env[TEMPLATE_ENV];
  delete process.env[LANG_ENV];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const pickupRows = () => state.alerts.filter((r) => r.event === 'pickup_assigned');
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

describe('the variables', () => {
  it('lists every item with quantity and unit on one line', () => {
    expect(pickupItemsVar([{ name: 'Milk', unit: 'l', qty: 20 }, { name: 'Cups', unit: 'pcs', qty: 500 }])).toBe('Milk 20 L, Cups 500 pcs');
  });

  it('cuts a long list on an item boundary and ends "and N more"', () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({ name: `Item number ${i + 1}`, unit: 'pcs', qty: 10 }));
    const v = pickupItemsVar(lines);
    expect(v.length).toBeLessThanOrEqual(600);
    expect(v).toMatch(/ and \d+ more$/);
    const shown = v.replace(/ and \d+ more$/, '').split(', ');
    expect(shown.every((x) => /^Item number \d+ 10 pcs$/.test(x))).toBe(true);
    expect(shown.length + Number(/and (\d+) more$/.exec(v)![1])).toBe(80);
  });

  it('keeps only letters, spaces, hyphens and apostrophes in the name; caps it; falls back to "there"', () => {
    expect(pickupNameVar("  Ravi\n\t Kumar-Singh O'Neil ")).toBe("Ravi Kumar-Singh O'Neil");
    expect(pickupNameVar('Ravi.com/win http://x.in')).toBe('Ravi com win http x in');
    expect(pickupNameVar('राहुल शर्मा')).toBe('राहुल शर्मा');
    expect(pickupNameVar('R4vi 99 !!')).toBe('R vi');
    expect(pickupNameVar('a'.repeat(100))).toHaveLength(40);
    expect(pickupNameVar('')).toBe('there');
    expect(pickupNameVar('1234 ...')).toBe('there');
    expect(pickupNameVar('A')).toBe('there');
  });

  it('cleans the items, and no variable is empty or has a newline, tab or 4 spaces', () => {
    const [name, num, items] = pickupVars('Ravi', 7, [{ name: 'Milk\n  full', unit: 'l', qty: 1 }]);
    expect([name, num, items]).toEqual(['Ravi', '7', 'Milk full 1 L']);
    expect(pickupVars('', 7, [])).toEqual(['there', '7', '-']);
    for (const v of pickupVars('a\n\nb', 7, [{ name: 'a    b', unit: 'l', qty: 1 }])) expect(v).not.toMatch(/\n|\t| {4}/);
  });
});

describe('choosing who delivers, with the template named', () => {
  it('off until set up: no call, no row, the reply is exactly as before', async () => {
    delete process.env[TEMPLATE_ENV];
    const r = await assign({ assigneeId: VIKRAM });
    expect(r.json).toEqual({ ok: true, emailed: 'sent' });
    expect(waSend).not.toHaveBeenCalled();
    expect(state.alerts).toEqual([]);
  });

  it('a blank value is off too', async () => {
    process.env[TEMPLATE_ENV] = '  ';
    expect('whatsapp' in (await assign({ assigneeId: VIKRAM })).json).toBe(false);
    expect(waSend).not.toHaveBeenCalled();
  });

  it('a team member gets one message to staff_accounts.phone (normalised), recorded before it goes', async () => {
    process.env[LANG_ENV] = 'en_US';
    const r = await assign({ assigneeId: VIKRAM });
    expect(r.json).toEqual({ ok: true, emailed: 'sent', whatsapp: 'sent' });
    expect(waSend).toHaveBeenCalledTimes(1);
    expect(waSend.mock.calls[0][0]).toMatchObject({
      to: '+919812345678',
      channel: 'whatsapp',
      templateName: 'stock_pickup_1',
      templateLang: 'en_US',
      templateVars: ['Vikram', '12', 'Full-cream milk 20 L, Paper cup 500 pcs'],
    });
    expect(pickupRows()).toEqual([
      expect.objectContaining({ event: 'pickup_assigned', channel: 'whatsapp', to_address: '+919812345678', status: 'sent', detail: '', provider_ref: 'wamid.1' }),
    ]);
    expect(state.updates).toHaveLength(1);
  });

  it('the claim row exists at the moment the message goes', async () => {
    let seenAtSend: Row[] = [];
    waSend.mockImplementation(() => {
      seenAtSend = state.alerts.map((a) => ({ ...a }));
      return Promise.resolve({ ok: true, providerRef: 'w', error: '' });
    });
    await assign({ assigneeId: VIKRAM });
    expect(seenAtSend).toEqual([expect.objectContaining({ status: 'sent', to_address: '+919812345678' })]);
  });

  it('two spellings of the same number are the same number: sent once', async () => {
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'sent' });
    state.staff[0].phone = '09812345678';
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'already_sent' });
    expect(waSend).toHaveBeenCalledTimes(1);
  });

  it('an outside driver gets nothing, logs nothing, and the reply is as before', async () => {
    const r = await assign({ deliverer: { name: 'Ravi (driver)', phone: '9812345670' } });
    expect(r.json).toEqual({ ok: true, emailed: 'skipped' });
    expect(waSend).not.toHaveBeenCalled();
    expect(state.alerts).toEqual([]);
  });

  it('no number (empty, or not an Indian mobile): skipped with a reason, nothing sent', async () => {
    expect((await assign({ assigneeId: MEERA })).json).toMatchObject({ whatsapp: 'no_number' });
    state.staff[0].phone = '+6581234567';
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'no_number' });
    state.staff[0].phone = 'call me';
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'no_number' });
    expect(waSend).not.toHaveBeenCalled();
    expect(pickupRows()).toHaveLength(3);
    expect(pickupRows()[0]).toMatchObject({ status: 'skipped', to_address: '' });
    expect(String(pickupRows()[0].detail)).toMatch(/no whatsapp number/i);
  });

  it('is not sent when they deliver it to themselves', async () => {
    const r = await assign({ assigneeId: MANAGER });
    expect(r.json).toEqual({ ok: true, emailed: 'skipped' });
    expect(waSend).not.toHaveBeenCalled();
    expect(state.alerts).toEqual([]);
  });

  it('is not sent for a return to the warehouse, or a store-room request', async () => {
    state.request = request({ route: 'to_warehouse' });
    expect('whatsapp' in (await assign({ assigneeId: VIKRAM })).json).toBe(false);
    state.request = request({ route: 'store_room' });
    expect('whatsapp' in (await assign({ assigneeId: VIKRAM })).json).toBe(false);
    expect(waSend).not.toHaveBeenCalled();
    expect(state.alerts).toEqual([]);
  });

  it('once per number per request: 23505 on the claim means nothing is sent; a different person is messaged', async () => {
    // The read-first check says "not yet", then the claim is refused (a race with another screen).
    state.alerts = [{ id: 'x', event: 'pickup_assigned', request_id: REQ, channel: 'whatsapp', to_address: '+919812345678', status: 'sent', created_at: new Date().toISOString() }];
    const again = await assign({ assigneeId: VIKRAM });
    expect(again.json).toMatchObject({ whatsapp: 'already_sent' });
    expect(waSend).not.toHaveBeenCalled();
    state.staff.push({ user_id: MEERA, phone: '9876543210' });
    state.staff = state.staff.filter((p) => !(p.user_id === MEERA && p.phone === ''));
    expect((await assign({ assigneeId: MEERA })).json).toMatchObject({ whatsapp: 'sent' });
    expect(waSend).toHaveBeenCalledTimes(1);
    expect(waSend.mock.calls[0][0]).toMatchObject({ to: '+919876543210' });
  });

  it('a 23505 that only the claim sees (lost race) sends nothing', async () => {
    state.insertError = { code: '23505', message: 'duplicate key' };
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'already_sent' });
    expect(waSend).not.toHaveBeenCalled();
  });
});

describe('claim before send, and the provider', () => {
  it('23514 (database file not applied): nothing is sent, the choice stands, the log names the file and nothing personal', async () => {
    state.insertError = { code: '23514', message: 'violates check constraint; Failing row contains (+919812345678, Vikram)' };
    const err = quiet();
    const r = await assign({ assigneeId: VIKRAM });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, emailed: 'sent', whatsapp: 'not_set_up' });
    expect(waSend).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(1);
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('2026-11-warehouse-pickup-alert.sql');
    expect(logged).toContain('23514');
    expect(logged).not.toContain('9812345678');
    expect(logged).not.toContain('Vikram');
    expect(logged).not.toContain('Failing row');
  });

  it('any other claim error sends nothing either', async () => {
    state.insertError = { code: '08006', message: 'connection' };
    quiet();
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'not_set_up' });
    expect(waSend).not.toHaveBeenCalled();
  });

  it('the claim throwing changes nothing about the choice', async () => {
    state.insertThrows = true;
    quiet();
    const r = await assign({ assigneeId: VIKRAM });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ whatsapp: 'failed' });
    expect(waSend).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(1);
  });

  it('a refusal by the provider turns the row to failed with its reason, and frees a retry; the reply carries no provider text', async () => {
    waSend.mockResolvedValueOnce({ ok: false, providerRef: '', error: '(#131026) Message undeliverable' });
    const r = await assign({ assigneeId: VIKRAM });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, emailed: 'sent', whatsapp: 'failed' });
    expect(JSON.stringify(r.json)).not.toContain('131026');
    expect(pickupRows()[0]).toMatchObject({ status: 'failed', detail: '(#131026) Message undeliverable' });
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'sent' });
    expect(waSend).toHaveBeenCalledTimes(2);
  });

  it('the adapter throwing is a failure, the row is freed, the choice stands', async () => {
    waSend.mockRejectedValueOnce(new Error('network down'));
    const r = await assign({ assigneeId: VIKRAM });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ whatsapp: 'failed' });
    expect(pickupRows()[0]).toMatchObject({ status: 'failed' });
    expect(state.updates).toHaveLength(1);
  });

  it('no answer within the limit: the row stays sent (not confirmed), so a retry cannot send twice', async () => {
    vi.useFakeTimers();
    waSend.mockImplementation(() => new Promise(() => undefined));
    const pending = assign({ assigneeId: VIKRAM });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 100);
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, emailed: 'sent', whatsapp: 'not_confirmed' });
    expect(pickupRows()[0]).toMatchObject({ status: 'sent' });
    expect(String(pickupRows()[0].detail)).toMatch(/not confirmed/i);
    vi.useRealTimers();
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'not_confirmed' });
    expect(waSend).toHaveBeenCalledTimes(1);
  });
});

describe('an earlier row that nobody confirmed', () => {
  const earlier = (detail: string) => ({
    id: 'e1', event: 'pickup_assigned', request_id: REQ, channel: 'whatsapp', to_address: '+919812345678', status: 'sent', detail, created_at: new Date().toISOString(),
  });

  it('still "sending" or "Not confirmed": not_confirmed, nothing sent', async () => {
    for (const detail of ['sending', 'Not confirmed: no answer from WhatsApp within 8 seconds. It may still arrive.']) {
      state.alerts = [earlier(detail)];
      expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'not_confirmed' });
    }
    expect(waSend).not.toHaveBeenCalled();
  });

  it('confirmed by WhatsApp (empty detail): already_sent', async () => {
    state.alerts = [earlier('')];
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'already_sent' });
    expect(waSend).not.toHaveBeenCalled();
  });

  it('a 23505 on the claim with an unconfirmed row: not_confirmed, nothing sent', async () => {
    state.alerts = [earlier('sending')];
    state.hideReads = 1; // the first read misses it (a race); the claim is then refused
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'not_confirmed' });
    expect(waSend).not.toHaveBeenCalled();
  });

  it('a 23505 on the claim with a confirmed row: already_sent', async () => {
    state.alerts = [earlier('')];
    state.hideReads = 1;
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'already_sent' });
  });
});

describe('a failed read is not "no number saved"', () => {
  it('a staff_accounts read error: failed, no row, nothing sent, log has the code and no number', async () => {
    state.staffReadError = { code: '57014', message: 'timeout +919812345678' };
    const err = quiet();
    const r = await assign({ assigneeId: VIKRAM });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, emailed: 'sent', whatsapp: 'failed' });
    expect(state.alerts).toEqual([]);
    expect(waSend).not.toHaveBeenCalled();
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('57014');
    expect(logged).not.toContain('9812345678');
  });
});

describe('the owner alert log helper', () => {
  it('logAlert returns only the code, never the database error', async () => {
    const { logAlert } = await import('@/lib/inventory/ownerAlerts');
    state.insertError = { code: '23514', message: 'Failing row contains (+919812345678)' };
    quiet();
    const out = await logAlert(makeAdmin() as never, { event: 'pickup_assigned', requestId: REQ, channel: 'whatsapp', to: '+919812345678', status: 'sent', detail: '', providerRef: '' });
    expect(out).toEqual({ code: '23514' });
    state.insertError = null;
    expect(await logAlert(makeAdmin() as never, { event: 'pickup_assigned', requestId: REQ, channel: 'whatsapp', to: '', status: 'skipped', detail: 'x', providerRef: '' })).toBeNull();
  });
});

describe('the daily limit', () => {
  const sentRow = (i: number, ageHours = 1) => ({
    id: `old-${i}`,
    event: 'pickup_assigned',
    request_id: REQ,
    channel: 'whatsapp',
    to_address: `+9190000${String(i).padStart(5, '0')}`,
    status: 'sent',
    created_at: new Date(Date.now() - ageHours * 3600_000).toISOString(),
  });

  it(`at ${40} sent in 24 hours nothing more goes: skipped "daily limit", told not sent`, async () => {
    expect(DAILY_LIMIT).toBe(40);
    state.alerts = Array.from({ length: DAILY_LIMIT }, (_, i) => sentRow(i));
    const r = await assign({ assigneeId: VIKRAM });
    expect(r.json).toEqual({ ok: true, emailed: 'sent', whatsapp: 'limit_reached' });
    expect(waSend).not.toHaveBeenCalled();
    expect(state.alerts.at(-1)).toMatchObject({ status: 'skipped', detail: 'daily limit' });
  });

  it('messages older than 24 hours, and failed ones, do not count', async () => {
    state.alerts = [
      ...Array.from({ length: DAILY_LIMIT }, (_, i) => sentRow(i, 30)),
      { ...sentRow(99), status: 'failed', to_address: '+919000099999' },
    ];
    expect((await assign({ assigneeId: VIKRAM })).json).toMatchObject({ whatsapp: 'sent' });
  });
});

describe('what the screens say', () => {
  it('leaves the existing wording alone when there is nothing to add', () => {
    expect(withPickupNotice('#12: Vikram delivers it and has been emailed.', undefined, 'Vikram')).toBe('#12: Vikram delivers it and has been emailed.');
  });

  it('adds one short sentence for each outcome', () => {
    const n = (r: Parameters<typeof withPickupNotice>[1]) => withPickupNotice('#12: Ravi delivers it.', r, 'Ravi');
    expect(n('sent')).toBe('#12: Ravi delivers it. WhatsApp sent to Ravi.');
    expect(n('no_number')).toBe('#12: Ravi delivers it. No WhatsApp: no number saved.');
    expect(n('already_sent')).toContain('already has the WhatsApp');
    expect(n('not_set_up')).toContain('not set up');
    expect(n('limit_reached')).toContain('daily limit');
    expect(n('not_confirmed')).toContain('could not be confirmed, so tell Ravi');
    expect(n('failed')).toContain('could not be sent, so tell Ravi');
  });
});
