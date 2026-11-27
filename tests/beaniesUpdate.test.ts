import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WhatsApp Beanies update (docs/BEANIES-UPDATE-SPEC.md): one informational Utility
// message per café order that earned Beanies, template hioc_beanies_update_1.
// Covers the six template variables, the fallback text, the IST expiry date, the
// ledger statement (balance, rupee value, FIFO expiry) and every skip case.
// All names, phones and figures are made up.

type Row = Record<string, unknown>;
const db: {
  profile: Row | null;
  optOuts: Row[];
  optOutError: Row | null;
  ledger: Row[];
  config: Row | null;
  existingNotification: Row | null;
  upserts: Row[];
  optOutQueries: string[][];
} = {
  profile: null,
  optOuts: [],
  optOutError: null,
  ledger: [],
  config: null,
  existingNotification: null,
  upserts: [],
  optOutQueries: [],
};

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      let range: [number, number] | null = null;
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        in: (_col: string, values: string[]) => {
          if (table === 'whatsapp_opt_outs') db.optOutQueries.push(values);
          return chain;
        },
        range: (a: number, b: number) => {
          range = [a, b];
          return chain;
        },
        maybeSingle: () => {
          if (table === 'profiles') return Promise.resolve({ data: db.profile, error: null });
          if (table === 'loyalty_config') return Promise.resolve({ data: db.config, error: null });
          if (table === 'notifications') return Promise.resolve({ data: db.existingNotification, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        upsert: (row: Row) => {
          db.upserts.push({ table, ...row });
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === 'whatsapp_opt_outs') return resolve({ data: db.optOuts, error: db.optOutError });
          if (table === 'loyalty_transactions') {
            const [from, to] = range ?? [0, 999];
            return resolve({ data: db.ledger.slice(from, to + 1), error: null });
          }
          return resolve({ data: [], error: null });
        },
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/flags', () => ({ flags: { notifications: true, marketing: false } }));

import { sendBeaniesUpdateNotification, beaniesExpiryText } from '@/lib/notifications/engine';
import { renderNotification, templateVarsFor } from '@/lib/notifications/templates';
import { getBeaniesStatement } from '@/lib/loyalty/ledger';

const ENV = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TPL_BEANIES', 'WHATSAPP_TPL_BEANIES_LANG', 'WHATSAPP_TPL_LANG'];
const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn();

const order = {
  id: 'order-1',
  order_number: 1042,
  // The order's own phone is deliberately a DIFFERENT number: it must never be used.
  customer_phone: '+919000000099',
  customer_name: 'Someone Else',
} as never;

// 95 Beanies earned 4 Nov 2026 19:00 UTC (= 5 Nov 00:30 IST), 25 just now: balance 120.
const ledger = (): Row[] => [
  { points: 95, created_at: '2026-11-04T19:00:00Z' },
  { points: 25, created_at: '2026-11-27T10:00:00Z' },
];

beforeEach(() => {
  db.profile = { name: 'Asha Rao', phone: '+919876500001', phone_verified: true };
  db.optOuts = [];
  db.optOutError = null;
  db.ledger = ledger();
  db.config = { inr_per_point: 1, points_expiry_days: 30, points_per_inr: 0.1 };
  db.existingNotification = null;
  db.upserts = [];
  db.optOutQueries = [];
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_ID = 'test-phone-id';
  process.env.WHATSAPP_TPL_BEANIES = 'hioc_beanies_update_1';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ messages: [{ id: 'wamid.test1' }] }) });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const send = (earned = 25, userId: string | null = 'user-1') =>
  sendBeaniesUpdateNotification({ order, userId, earned });
const skipRow = () => db.upserts.find((r) => r.table === 'notifications' && r.status === 'skipped');

describe('template variables and fallback text', () => {
  const facts = { name: 'Asha', earned: 25, balance: 120, valueInr: 120, expiryDate: '5 Dec' };
  const o = { order_number: 1042, customer_name: 'Ignored Name' } as never;

  it('fills the six variables in order: name, earned, order number, balance, rupee value, expiry', () => {
    expect(templateVarsFor(o, 'beanies', facts)).toEqual(['Asha', '25', 'HIOC-001042', '120', '120', '5 Dec']);
  });

  it('renders the spec wording (a bare number for the rupee value, ends on fixed text)', () => {
    expect(renderNotification(o, 'beanies', facts).body).toBe(
      'Hi Asha, you earned 25 HIOC Beanies on order HIOC-001042. Your balance is 120 Beanies, worth ₹120. The oldest of them expire on 5 Dec. Reply STOP to stop these updates.',
    );
  });
});

describe('expiry date in IST', () => {
  it('uses the IST calendar day, not the UTC one', () => {
    // 4 Dec 19:00 UTC is already 5 Dec 00:30 in India.
    expect(beaniesExpiryText(new Date('2026-12-04T19:00:00Z'), new Date('2026-11-27T10:00:00Z'))).toBe('5 Dec');
    // 5 Dec 18:29 UTC is still 5 Dec 23:59 IST.
    expect(beaniesExpiryText(new Date('2026-12-05T18:29:00Z'), new Date('2026-11-27T10:00:00Z'))).toBe('5 Dec');
    expect(beaniesExpiryText(new Date('2026-12-05T18:30:00Z'), new Date('2026-11-27T10:00:00Z'))).toBe('6 Dec');
  });

  it('a credit past its expiry but not yet swept reads as today, never a past date', () => {
    expect(beaniesExpiryText(new Date('2026-11-01T10:00:00Z'), new Date('2026-11-27T10:00:00Z'))).toBe('27 Nov');
  });
});

describe('getBeaniesStatement (balance, rupee value, FIFO expiry)', () => {
  it('balance 120 at ₹1 per Beanie is worth ₹120; the oldest credit expires 30 days after it was earned', async () => {
    const s = await getBeaniesStatement('user-1');
    expect(s?.balance).toBe(120);
    expect(s?.valueInr).toBe(120);
    expect(s?.expiresAt?.toISOString()).toBe('2026-12-04T19:00:00.000Z'); // 5 Dec IST
  });

  it('rounds the rupee value down: 125 Beanies at ₹0.5 each is ₹62, not ₹63', async () => {
    db.config = { inr_per_point: 0.5, points_expiry_days: 30 };
    db.ledger = [{ points: 100, created_at: '2026-11-04T19:00:00Z' }, { points: 25, created_at: '2026-11-27T10:00:00Z' }];
    const s = await getBeaniesStatement('user-1');
    expect(s?.balance).toBe(125);
    expect(s?.valueInr).toBe(62);
  });

  it('FIFO: spent Beanies come off the oldest credit first, so the next expiry moves to the next credit', async () => {
    db.ledger = [
      { points: 50, created_at: '2026-11-04T19:00:00Z' },
      { points: -50, created_at: '2026-11-10T10:00:00Z' }, // redeemed: the 4 Nov credit is fully spent
      { points: 70, created_at: '2026-11-12T10:00:00Z' },
      { points: 25, created_at: '2026-11-27T10:00:00Z' },
    ];
    const s = await getBeaniesStatement('user-1');
    expect(s?.balance).toBe(95);
    expect(s?.expiresAt?.toISOString()).toBe('2026-12-12T10:00:00.000Z');
  });

  it('has no expiry date when expiry is off', async () => {
    db.config = { inr_per_point: 1, points_expiry_days: 0 };
    expect((await getBeaniesStatement('user-1'))?.expiresAt).toBeNull();
  });
});

describe('sendBeaniesUpdateNotification', () => {
  it('sends hioc_beanies_update_1 with the six values to the verified profile phone, never the order phone', async () => {
    const r = await send();
    expect(r.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.to).toBe('919876500001'); // profile phone, not the order's +919000000099
    expect(payload.template.name).toBe('hioc_beanies_update_1');
    expect(payload.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual([
      'Asha', '25', 'HIOC-001042', '120', '120', '5 Dec',
    ]);
    const logged = db.upserts.find((u) => u.table === 'notifications' && u.status === 'sent');
    expect(logged).toMatchObject({ order_id: 'order-1', event: 'beanies', channel: 'whatsapp' });
  });

  it('sends with marketing off and no marketing consent: it is not a marketing message', async () => {
    // flags.marketing is false in this file's mock and the profile carries no consent field.
    expect((await send()).sent).toBe(true);
  });

  it('sends nothing for a second completion or a resend: a row already sent short-circuits', async () => {
    db.existingNotification = { id: 'n1', status: 'sent', attempts: 1, provider_ref: 'wamid.test1' };
    const r = await send();
    expect(r.skipped).toBe('already_sent');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips and logs the reason while WHATSAPP_TPL_BEANIES is unset', async () => {
    delete process.env.WHATSAPP_TPL_BEANIES;
    const r = await send();
    expect(r).toEqual({ sent: false, skipped: 'not_configured:WHATSAPP_TPL_BEANIES' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(skipRow()).toMatchObject({ event: 'beanies', channel: 'whatsapp', skip_reason: 'not_configured:WHATSAPP_TPL_BEANIES' });
  });

  it('skips when nothing was earned (0 Beanies) or there is no account', async () => {
    expect((await send(0)).skipped).toBe('nothing_earned');
    expect((await send(25, null)).skipped).toBe('nothing_earned');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unverified phone', { name: 'Asha', phone: '+919876500001', phone_verified: false }],
    ['no phone on the account', { name: 'Asha', phone: null, phone_verified: true }],
    ['no profile', null],
  ])('skips and logs for %s, even though the order has its own phone', async (_label, profile) => {
    db.profile = profile;
    const r = await send();
    expect(r.skipped).toBe('no_verified_phone');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(skipRow()).toMatchObject({ skip_reason: 'no_verified_phone' });
  });

  it('skips a customer who replied STOP, checking every spelling of their number', async () => {
    db.optOuts = [{ phone: '9876500001' }];
    const r = await send();
    expect(r.skipped).toBe('opted_out');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.optOutQueries[0]).toEqual(expect.arrayContaining(['+919876500001', '919876500001', '9876500001']));
  });

  it('fails closed when the opt-out list cannot be read', async () => {
    db.optOutError = { message: 'boom' };
    const r = await send();
    expect(r.skipped).toBe('opt_out_lookup_failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when there is no expiry date to state (expiry off), rather than inventing one', async () => {
    db.config = { inr_per_point: 1, points_expiry_days: 0 };
    expect((await send()).skipped).toBe('no_expiry_date');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws, even when the gateway call blows up', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const r = await send();
    expect(r.sent).toBe(false);
  });
});
