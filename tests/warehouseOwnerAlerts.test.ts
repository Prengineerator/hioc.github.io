import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner alerts (lib/inventory/ownerAlerts.ts, docs/WAREHOUSE-SPEC.md WH-D9..D11):
// what the email and the WhatsApp template say for each event, who they go to,
// that an address is never sent the same alert twice, that WhatsApp is logged
// as skipped (with the reason) until a template is configured, and that a
// failure never throws into the request that triggered it.

const state: {
  flags: { inventory: boolean; warehouse: boolean };
  settings: Record<string, unknown> | null;
  settingsError: boolean;
  request: Record<string, unknown> | null;
  batches: Record<string, { item_id: string; qty_remaining: number }[]>;
  sentRows: { event: string; request_id: string; channel: string; to_address: string }[];
  inserted: Record<string, unknown>[];
  ownerEmails: string[];
} = {
  flags: { inventory: true, warehouse: true },
  settings: null,
  settingsError: false,
  request: null,
  batches: {},
  sentRows: [],
  inserted: [],
  ownerEmails: [],
};

vi.mock('@/lib/flags', () => ({ flags: new Proxy({}, { get: (_t, k) => (state.flags as Record<string, boolean>)[k as string] ?? false }) }));
vi.mock('@/lib/url', () => ({ absoluteUrl: (p: string) => `https://hioc.in${p}` }));
vi.mock('@/lib/staff/displayName', () => ({
  getStaffDisplayNames: (_a: unknown, ids: string[]) =>
    Promise.resolve(new Map(ids.map((id) => [id, ({ 'u-asha': 'Asha', 'u-vik': 'Vikram', 'u-meera': 'Meera' } as Record<string, string>)[id] ?? 'Staff']))),
}));
vi.mock('@/lib/reports/ownerDigestServer', () => ({ ownerLoginEmails: () => Promise.resolve(state.ownerEmails) }));
const { emailSend, waSend } = vi.hoisted(() => ({
  emailSend: vi.fn((_input: Record<string, unknown>) => Promise.resolve({ ok: true, providerRef: 're_1', error: '' })),
  waSend: vi.fn((_input: Record<string, unknown>) => Promise.resolve({ ok: true, providerRef: 'wamid.1', error: '' })),
}));
vi.mock('@/lib/notifications/adapters', () => ({ emailAdapter: { send: emailSend }, whatsappAdapter: { send: waSend } }));

function makeAdmin() {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => ((filters[c] = v), chain),
        in: (c: string, v: unknown) => ((filters[c] = v), chain),
        gt: () => chain,
        limit: () => chain,
        order: () => chain,
        insert: (row: Record<string, unknown>) => {
          state.inserted.push({ table, ...row });
          return Promise.resolve({ error: null });
        },
        maybeSingle: () => {
          if (table === 'warehouse_alert_settings') {
            return Promise.resolve(state.settingsError ? { data: null, error: { code: '42P01', message: 'missing' } } : { data: state.settings, error: null });
          }
          if (table === 'stock_requests') return Promise.resolve({ data: state.request, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === 'warehouse_alerts') {
            const hit = state.sentRows.filter(
              (r) => r.event === filters.event && r.request_id === filters.request_id && r.channel === filters.channel && r.to_address === filters.to_address,
            );
            return resolve({ data: hit, error: null });
          }
          if (table === 'warehouse_batches' || table === 'inventory_batches') return resolve({ data: state.batches[table] ?? [], error: null });
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

const alerts = await import('@/lib/inventory/ownerAlerts');
const { renderOwnerAlert, parseAlertSettingsPatch, alertRecipients, sendOwnerAlert, summarizeLines, DEFAULT_ALERT_SETTINGS } = alerts;

const REQ = 'req-1';
const placed = {
  request_number: 12,
  route: 'from_warehouse',
  note: 'Before <5pm>',
  requested_by: 'u-asha',
  received_by: null,
  assigned_to: null,
  deliverer_name: '',
  stock_request_lines: [
    { item_id: 'milk', qty_requested: 20, qty_picked: null, qty_received: null, inventory_items: { name: 'Full-cream milk', unit: 'l' } },
    { item_id: 'cups', qty_requested: 500, qty_picked: null, qty_received: null, inventory_items: { name: 'Paper cup', unit: 'pcs' } },
  ],
};

beforeEach(() => {
  state.flags = { inventory: true, warehouse: true };
  state.settings = { enabled: true, email_owner_logins: true, emails: ['partner@example.com'], whatsapp_phones: ['+919876543210'] };
  state.settingsError = false;
  state.request = structuredClone(placed);
  state.batches = {
    warehouse_batches: [{ item_id: 'milk', qty_remaining: 14 }, { item_id: 'milk', qty_remaining: 0.5 }],
    inventory_batches: [{ item_id: 'milk', qty_remaining: 6 }, { item_id: 'cups', qty_remaining: 900 }],
  };
  state.sentRows = [];
  state.inserted = [];
  state.ownerEmails = ['Owner@HIOC.in'];
  emailSend.mockClear();
  waSend.mockClear();
  delete process.env.WHATSAPP_TPL_STOCK_ALERT;
  delete process.env.RESEND_FROM_REPORTS;
});

describe('renderOwnerAlert', () => {
  const base = {
    number: 12,
    route: 'from_warehouse' as const,
    by: 'Asha',
    deliveredBy: '',
    note: 'Before <5pm>',
    lines: [
      { name: 'Full-cream milk', unit: 'l', qty: 20, warehouseOnHand: 14.5, storeOnHand: 6 },
      { name: 'Paper cup', unit: 'pcs', qty: 500, warehouseOnHand: 0, storeOnHand: 900 },
    ],
  };

  it('a new request: who asked, each line with what the warehouse and store hold, a short warning, and the link', () => {
    const m = renderOwnerAlert({ ...base, event: 'request_placed' });
    expect(m.subject).toBe('New stock request #12 from Asha — 2 items');
    expect(m.text).toContain('- Full-cream milk — 20 L (warehouse has 14.5 L, store has 6 L) — warehouse is short');
    expect(m.text).toContain('https://hioc.in/owner/warehouse');
    expect(m.html).toContain('href="https://hioc.in/owner/warehouse"');
    expect(m.html).toContain('Before &lt;5pm&gt;');
    expect(m.html).not.toContain('<5pm>');
  });

  it('the WhatsApp variables: headline, number, who, a short summary — no newlines', () => {
    const m = renderOwnerAlert({ ...base, event: 'request_placed', by: 'Asha\nX' });
    expect(m.whatsappVars).toEqual(['New stock request', '12', 'Asha X', 'Full-cream milk 20 L, Paper cup 500 pcs']);
  });

  it('a return names who carries it; arrived-different shows sent against arrived', () => {
    const ret = renderOwnerAlert({ ...base, event: 'return_sent', deliveredBy: 'Ravi', lines: [{ name: 'Paper cup', unit: 'pcs', qty: 100 }] });
    expect(ret.subject).toBe('Stock on its way back to the warehouse — #12, 1 item');
    expect(ret.text).toContain('carried by Ravi');
    const diff = renderOwnerAlert({ ...base, event: 'arrived_different', by: 'Meera', lines: [{ name: 'Full-cream milk', unit: 'l', qty: 12, arrived: 10 }] });
    expect(diff.subject).toBe('Stock #12 arrived different from what was sent');
    expect(diff.text).toContain('- Full-cream milk — sent 12 L, arrived 10 L');
    expect(diff.whatsappVars[3]).toBe('1 item: Full-cream milk 12 L');
  });

  it('summarizes long requests', () => {
    const lines = ['A', 'B', 'C', 'D', 'E'].map((n) => ({ name: n, unit: 'pcs', qty: 1 }));
    expect(summarizeLines(lines)).toBe('A 1 pcs, B 1 pcs, C 1 pcs and 2 more');
  });
});

describe('settings', () => {
  it('normalises emails and phones, and refuses bad ones', () => {
    expect(parseAlertSettingsPatch({ emails: [' A@B.com ', 'a@b.com', ''], whatsappPhones: ['98765 43210', '+919876543210', ''] })).toEqual({
      ok: true,
      patch: { emails: ['a@b.com'], whatsappPhones: ['+919876543210'] },
    });
    expect(parseAlertSettingsPatch({ emails: ['nope'] }).ok).toBe(false);
    expect(parseAlertSettingsPatch({ whatsappPhones: ['12345'] }).ok).toBe(false);
    expect(parseAlertSettingsPatch({ enabled: 'yes' }).ok).toBe(false);
    expect(parseAlertSettingsPatch({ emails: Array.from({ length: 11 }, (_, i) => `a${i}@b.com`) }).ok).toBe(false);
  });

  it('recipients: owner logins (unless off) plus extras, de-duplicated; nobody when alerts are off', () => {
    const s = { ...DEFAULT_ALERT_SETTINGS, emails: ['owner@hioc.in', 'p@x.com'], whatsappPhones: ['+919876543210'] };
    expect(alertRecipients(s, ['Owner@HIOC.in'])).toEqual({ emails: ['owner@hioc.in', 'p@x.com'], phones: ['+919876543210'] });
    expect(alertRecipients({ ...s, emailOwnerLogins: false }, ['o@h.in']).emails).toEqual(['owner@hioc.in', 'p@x.com']);
    expect(alertRecipients({ ...s, enabled: false }, ['o@h.in'])).toEqual({ emails: [], phones: [] });
  });
});

describe('sendOwnerAlert', () => {
  it('emails every recipient with the request’s lines and stock levels, and logs each send', async () => {
    const out = await sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ);
    expect(emailSend).toHaveBeenCalledTimes(2);
    expect(emailSend.mock.calls.map((c) => c[0].to)).toEqual(['owner@hioc.in', 'partner@example.com']);
    const first = emailSend.mock.calls[0][0] as { subject: string; body: string };
    expect(first.subject).toBe('New stock request #12 from Asha — 2 items');
    expect(first.body).toContain('warehouse has 14.5 L, store has 6 L');
    expect(first.body).toContain('Paper cup — 500 pcs (warehouse has 0 pcs, store has 900 pcs) — warehouse is short');
    const logged = state.inserted.filter((r) => r.table === 'warehouse_alerts');
    expect(logged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'request_placed', request_id: REQ, channel: 'email', to_address: 'owner@hioc.in', status: 'sent', provider_ref: 're_1' }),
      ]),
    );
    expect(out.filter((o) => o.channel === 'email').every((o) => o.status === 'sent')).toBe(true);
  });

  it('WhatsApp is skipped, with the reason logged, until a template is configured', async () => {
    const out = await sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ);
    expect(waSend).not.toHaveBeenCalled();
    expect(out).toContainEqual({ channel: 'whatsapp', to: '+919876543210', status: 'skipped', detail: 'not_configured:WHATSAPP_TPL_STOCK_ALERT' });
    expect(state.inserted).toContainEqual(expect.objectContaining({ channel: 'whatsapp', status: 'skipped' }));
  });

  it('with a template, sends it to each number with the variables', async () => {
    process.env.WHATSAPP_TPL_STOCK_ALERT = 'stock_alert_1';
    await sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ);
    expect(waSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '+919876543210',
        templateName: 'stock_alert_1',
        templateVars: ['New stock request', '12', 'Asha', 'Full-cream milk 20 L, Paper cup 500 pcs'],
      }),
    );
  });

  it('never sends an address the same alert twice', async () => {
    state.sentRows = [{ event: 'request_placed', request_id: REQ, channel: 'email', to_address: 'owner@hioc.in' }];
    const out = await sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ);
    expect(emailSend.mock.calls.map((c) => c[0].to)).toEqual(['partner@example.com']);
    expect(out).toContainEqual({ channel: 'email', to: 'owner@hioc.in', status: 'already_sent', detail: '' });
  });

  it('logs a provider failure as failed', async () => {
    emailSend.mockResolvedValueOnce({ ok: false, providerRef: '', error: 'resend credentials missing' });
    await sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ);
    expect(state.inserted).toContainEqual(expect.objectContaining({ to_address: 'owner@hioc.in', status: 'failed', detail: 'resend credentials missing' }));
  });

  it('arrived-different lists only the lines that differ, and is "by" whoever counted it in', async () => {
    state.request = {
      ...structuredClone(placed),
      received_by: 'u-meera',
      assigned_to: 'u-vik',
      stock_request_lines: [
        { item_id: 'milk', qty_requested: 12, qty_picked: 12, qty_received: 10, inventory_items: { name: 'Full-cream milk', unit: 'l' } },
        { item_id: 'cups', qty_requested: 100, qty_picked: 100, qty_received: 100, inventory_items: { name: 'Paper cup', unit: 'pcs' } },
      ],
    };
    await sendOwnerAlert(makeAdmin() as never, 'arrived_different', REQ);
    const body = (emailSend.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain('Meera counted #12 in (delivered by Vikram)');
    expect(body).toContain('Full-cream milk — sent 12 L, arrived 10 L');
    expect(body).not.toContain('Paper cup');
  });

  it('does nothing with the warehouse off, with alerts off, or for a request that is gone', async () => {
    state.flags.warehouse = false;
    expect(await sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ)).toEqual([]);
    state.flags.warehouse = true;
    state.settings = { ...state.settings, enabled: false };
    expect(await sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ)).toEqual([]);
    state.settings = { ...state.settings, enabled: true };
    state.request = null;
    expect(await sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ)).toEqual([]);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('falls back to emailing the owner logins when the settings table is missing', async () => {
    state.settingsError = true;
    await sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ);
    expect(emailSend.mock.calls.map((c) => c[0].to)).toEqual(['owner@hioc.in']);
  });

  it('never throws', async () => {
    emailSend.mockRejectedValueOnce(new Error('boom'));
    await expect(sendOwnerAlert(makeAdmin() as never, 'request_placed', REQ)).resolves.toEqual([]);
  });
});
