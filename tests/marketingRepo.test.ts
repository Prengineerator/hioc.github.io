import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb, Row } from './helpers/marketingDb';
import { NOW_SEND, daysAgo, newDb, rowsOf } from './helpers/marketingWorld';

// lib/marketing/server/repo.ts: the ONE place that knows what "migration not applied" looks
// like, and the paged, abort-on-failure readers every engine module stands on.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));

const R = await import('@/lib/marketing/server/repo');
const admin = () => h.db.client as never;

beforeEach(() => {
  h.db = newDb();
});

describe('isMigrationMissing — the single helper', () => {
  it.each([
    ['42P01', 'undefined table'],
    ['PGRST205', 'table not in the schema cache'],
    ['42703', 'undefined column (a read)'],
    ['PGRST204', 'column not in the schema cache (a write)'],
    ['42883', 'undefined function'],
    ['PGRST202', 'function not in the schema cache'],
  ])('%s (%s) means the migration is missing', (code) => {
    expect(R.isMigrationMissing({ code, message: 'whatever' })).toBe(true);
  });

  it.each(['23505', '42501', 'XX000', 'PGRST116', '22P02'])('%s does not', (code) => {
    expect(R.isMigrationMissing({ code, message: 'a real failure' })).toBe(false);
  });

  it('recognises the message when the response carried no code', () => {
    expect(R.isMigrationMissing({ message: 'relation "public.marketing_settings" does not exist' })).toBe(true);
    expect(R.isMigrationMissing({ message: 'Could not find the table \'public.marketing_settings\' in the schema cache' })).toBe(true);
    expect(R.isMigrationMissing({ message: 'Could not find the function public.claim_marketing_recipients' })).toBe(true);
    expect(R.isMigrationMissing({ message: 'column coupons.assigned_phone does not exist' })).toBe(true);
    expect(R.isMigrationMissing({ message: 'permission denied' })).toBe(false);
  });

  it('is false for no error at all', () => {
    expect(R.isMigrationMissing(null)).toBe(false);
    expect(R.isMigrationMissing(undefined)).toBe(false);
  });

  it('assertOk throws the typed error for a missing migration and a plain one otherwise', () => {
    expect(() => R.assertOk('x', null)).not.toThrow();
    expect(() => R.assertOk('read', { code: '42P01', message: 'gone' })).toThrow(R.MigrationMissingError);
    try {
      R.assertOk('read', { code: '23505', message: 'dup' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).not.toBeInstanceOf(R.MigrationMissingError);
      expect((err as Error).message).toBe('read: dup');
    }
    expect(R.isMigrationMissingError(new R.MigrationMissingError('t'))).toBe(true);
    expect(R.isMigrationMissingError(new Error('t'))).toBe(false);
  });

  it('every loader turns a missing table into the typed error', async () => {
    h.db.setMissing('marketing_settings', true);
    await expect(R.loadSettings(admin())).rejects.toBeInstanceOf(R.MigrationMissingError);
    h.db.setMissing('marketing_playbooks', true);
    await expect(R.loadPlaybooks(admin())).rejects.toBeInstanceOf(R.MigrationMissingError);
    h.db.setMissing('marketing_consent', true);
    await expect(R.loadConsentRows(admin())).rejects.toBeInstanceOf(R.MigrationMissingError);
  });
});

describe('toE164', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['098765 43210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['+14155550123', '+14155550123'],
  ])('%s → %s', (input, out) => expect(R.toE164(input)).toBe(out));

  it.each(['', '   ', 'abc', '12345', '5876543210', null, undefined])('%j is not a phone', (input) => expect(R.toE164(input as string)).toBeNull());
});

describe('pageAll', () => {
  it('reads every page — PostgREST caps a response at 1000 rows and the rest must not vanish', async () => {
    h.db.tables.marketing_consent = Array.from({ length: 2500 }, (_, i) => ({ phone: `+9198${String(i).padStart(8, '0')}`, status: 'opted_in' }));
    const rows = await R.loadConsentRows(admin());
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.phone)).size).toBe(2500);
  });

  it('a consent list longer than one page still finds the OPT-OUT on the last page', async () => {
    h.db.tables.marketing_consent = Array.from({ length: 1500 }, (_, i) => ({ phone: `+9198${String(i).padStart(8, '0')}`, status: i === 1499 ? 'opted_out' : 'opted_in' }));
    const rows = await R.loadConsentRows(admin());
    expect(rows.filter((r) => r.status === 'opted_out')).toHaveLength(1);
  });

  it('a page of exactly 1000 rows triggers one more read (and stops at the empty one)', async () => {
    h.db.tables.marketing_consent = Array.from({ length: 1000 }, (_, i) => ({ phone: `+9198${String(i).padStart(8, '0')}`, status: 'opted_in' }));
    expect(await R.loadConsentRows(admin())).toHaveLength(1000);
  });

  it('aborts on a failed page rather than returning the pages it got', async () => {
    h.db.tables.marketing_consent = Array.from({ length: 2500 }, (_, i) => ({ phone: `+9198${String(i).padStart(8, '0')}`, status: 'opted_in' }));
    let n = 0;
    await expect(
      R.pageAll('test read', async (from, to) => {
        if (++n === 2) return { data: null, error: { code: 'XX000', message: 'connection reset' } };
        return { data: Array.from({ length: to - from + 1 }, () => ({})), error: null };
      }),
    ).rejects.toThrow('test read: connection reset');
  });

  it('honours a max', async () => {
    const rows = await R.pageAll('x', async (from, to) => ({ data: Array.from({ length: to - from + 1 }, () => ({})), error: null }), { max: 1500 });
    expect(rows).toHaveLength(1500);
  });

  it('chunk splits evenly', () => {
    expect(R.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(R.chunk([], 3)).toEqual([]);
  });
});

describe('settings and playbooks', () => {
  it('coerces numeric columns that arrive as strings', async () => {
    h.db.tables.marketing_settings = [{ is_singleton: true, enabled: true, message_cost_inr: '1.020', monthly_budget_inr: '1500', whatsapp_business_number: '+919876500000' }];
    const s = await R.loadSettings(admin());
    expect(s).toMatchObject({ enabled: true, message_cost_inr: 1.02, monthly_budget_inr: 1500, daily_send_cap: 200 });
  });

  it('is null when the singleton row is missing, and only "true" enables', async () => {
    expect(await R.loadSettings(admin())).toBeNull();
    h.db.tables.marketing_settings = [{ is_singleton: true, enabled: 'true' }];
    expect((await R.loadSettings(admin()))!.enabled).toBe(false);
  });

  it('always yields five playbooks, defaults for any missing row, mode off', async () => {
    h.db.tables.marketing_playbooks = [{ key: 'winback_1', mode: 'auto', priority: 4, params: { min_days: 20 }, offer: { type: 'flat', amount_inr: 50, min_order_inr: 100, validity_days: 5 }, template: { name: 'mine' } }];
    const rows = await R.loadPlaybooks(admin());
    expect(rows.map((r) => r.key)).toEqual(['points_expiring', 'winback_3', 'winback_2', 'winback_1', 'points_balance']);
    const w1 = rows.find((r) => r.key === 'winback_1')!;
    // Stored values win, defaults fill what the jsonb lacks.
    expect(w1).toMatchObject({ mode: 'auto', params: { min_days: 20, max_days: 45, gap_multiplier: 2.5, default_days: 30 }, offer: { type: 'flat', amount_inr: 50 } });
    expect(w1.template).toMatchObject({ name: 'mine', lang: 'en', url_button: true });
    expect(rows.find((r) => r.key === 'points_expiring')!.mode).toBe('off');
  });

  it('falls back to the default offer and template for a corrupt jsonb', async () => {
    h.db.tables.marketing_playbooks = [{ key: 'winback_1', mode: 'review', offer: { type: 'lottery' }, template: 'nonsense', params: null }];
    const w1 = (await R.loadPlaybooks(admin())).find((r) => r.key === 'winback_1')!;
    expect(w1.offer).toMatchObject({ type: 'percent', percent: 10 });
    expect(w1.template.name).toBe('hioc_winback_1');
    expect(w1.params).toMatchObject({ default_days: 30 });
  });

  it('an unknown mode is off, never something that sends', async () => {
    h.db.tables.marketing_playbooks = [{ key: 'winback_1', mode: 'yolo' }];
    expect((await R.loadPlaybooks(admin())).find((r) => r.key === 'winback_1')!.mode).toBe('off');
  });
});

describe('send history', () => {
  const campaigns = () => {
    h.db.tables.marketing_campaigns = [
      { id: 'live', playbook_key: 'winback_1', status: 'completed', created_at: daysAgo(5) },
      { id: 'dead', playbook_key: 'winback_1', status: 'cancelled', created_at: daysAgo(5) },
      { id: 'expired', playbook_key: 'winback_2', status: 'expired', created_at: daysAgo(5) },
    ];
  };

  it('maps each recipient to its campaign\'s playbook and groups by phone', async () => {
    campaigns();
    h.db.tables.marketing_recipients = [
      { id: '1', campaign_id: 'live', phone: '+919111111111', arm: 'treatment', status: 'delivered', created_at: daysAgo(5), sent_at: daysAgo(5) },
      { id: '2', campaign_id: 'live', phone: '+919111111111', arm: 'holdout', status: 'holdout', created_at: daysAgo(4) },
    ];
    const { byPhone, all } = await R.loadSendHistory(admin(), NOW_SEND);
    expect(all).toHaveLength(2);
    expect(byPhone.get('+919111111111')).toHaveLength(2);
    expect(byPhone.get('+919111111111')![0]).toMatchObject({ playbook_key: 'winback_1', status: 'delivered', read_at: null, reference_at: null });
  });

  it('normalises absent timestamps to null (an absent read_at must not read as "read")', async () => {
    campaigns();
    h.db.tables.marketing_recipients = [{ id: '1', campaign_id: 'live', phone: '+919111111111', arm: 'treatment', status: 'sent', created_at: daysAgo(1) }];
    const { all } = await R.loadSendHistory(admin(), NOW_SEND);
    expect(all[0]).toEqual(expect.objectContaining({ sent_at: null, read_at: null, reference_at: null }));
  });

  it('drops a HOLDOUT of a cancelled or expired campaign — nobody was held out of anything', async () => {
    campaigns();
    h.db.tables.marketing_recipients = [
      { id: '1', campaign_id: 'dead', phone: '+919111111111', arm: 'holdout', status: 'holdout', created_at: daysAgo(4) },
      { id: '2', campaign_id: 'expired', phone: '+919222222222', arm: 'holdout', status: 'holdout', created_at: daysAgo(4) },
      { id: '3', campaign_id: 'live', phone: '+919333333333', arm: 'holdout', status: 'holdout', created_at: daysAgo(4) },
      // A treated recipient of a cancelled campaign that DID send is still a send.
      { id: '4', campaign_id: 'dead', phone: '+919444444444', arm: 'treatment', status: 'sent', created_at: daysAgo(4), sent_at: daysAgo(4) },
    ];
    const { byPhone } = await R.loadSendHistory(admin(), NOW_SEND);
    expect([...byPhone.keys()].sort()).toEqual(['+919333333333', '+919444444444']);
  });

  it('reaches back 365 days, plus anything still in flight however old', async () => {
    campaigns();
    h.db.tables.marketing_recipients = [
      { id: '1', campaign_id: 'live', phone: '+919111111111', arm: 'treatment', status: 'delivered', created_at: daysAgo(300), sent_at: daysAgo(300) },
      { id: '2', campaign_id: 'live', phone: '+919222222222', arm: 'treatment', status: 'delivered', created_at: daysAgo(400), sent_at: daysAgo(400) },
      { id: '3', campaign_id: 'live', phone: '+919333333333', arm: 'treatment', status: 'queued', created_at: daysAgo(400) },
    ];
    const { byPhone } = await R.loadSendHistory(admin(), NOW_SEND);
    expect([...byPhone.keys()].sort()).toEqual(['+919111111111', '+919333333333']);
  });

  it('the send-time read sees only messages that left in the last 30 days, and not the row being sent', async () => {
    h.db.tables.marketing_recipients = [
      { id: 'self', campaign_id: 'c', phone: '+919111111111', arm: 'treatment', status: 'sent', created_at: daysAgo(1), sent_at: daysAgo(1) },
      { id: 'recent', campaign_id: 'c2', phone: '+919111111111', arm: 'treatment', status: 'read', created_at: daysAgo(10), sent_at: daysAgo(10) },
      { id: 'old', campaign_id: 'c3', phone: '+919111111111', arm: 'treatment', status: 'sent', created_at: daysAgo(40), sent_at: daysAgo(40) },
      { id: 'failed', campaign_id: 'c4', phone: '+919111111111', arm: 'treatment', status: 'failed', created_at: daysAgo(2) },
      { id: 'other', campaign_id: 'c5', phone: '+919222222222', arm: 'treatment', status: 'sent', created_at: daysAgo(2), sent_at: daysAgo(2) },
    ];
    const rows = await R.loadRecentSendsForPhone(admin(), '+919111111111', NOW_SEND, 'self');
    expect(rows.map((r) => r.campaign_id)).toEqual(['c2']);
  });
});

describe('opt-outs and profiles', () => {
  it('lists every opt-out phone in both spellings so a match cannot be missed', async () => {
    h.db.tables.whatsapp_opt_outs = [{ phone: '+919111111111' }, { phone: '919222222222' }, { phone: '9333333333' }];
    const set = await R.loadOptOutPhones(admin());
    for (const p of ['+919111111111', '+919222222222', '+919333333333']) expect(set.has(p)).toBe(true);
  });

  it('reads verified profiles only', async () => {
    h.db.tables.profiles = [
      { id: 'a', phone: '+919111111111', phone_verified: true, role: 'customer' },
      { id: 'b', phone: '+919222222222', phone_verified: false, role: 'customer' },
    ];
    expect((await R.loadVerifiedProfiles(admin())).map((p) => p.id)).toEqual(['a']);
  });
});

describe('orders and order lines', () => {
  it('loads valid orders since a date and skips cancelled and rejected ones', async () => {
    h.db.tables.orders = [
      { id: 'a', created_at: daysAgo(5), total_inr: 300, status: 'completed' },
      { id: 'b', created_at: daysAgo(5), total_inr: 300, status: 'cancelled' },
      { id: 'c', created_at: daysAgo(5), total_inr: 300, status: 'rejected' },
      { id: 'd', created_at: daysAgo(500), total_inr: 300, status: 'completed' },
    ];
    const rows = await R.loadValidOrders(daysAgo(365));
    expect(rows.map((o) => o.id)).toEqual(['a']);
  });

  it('aborts (throws) when the orders cannot be read — planning on an empty list would call everyone "no orders"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.db.failNext('select orders');
    await expect(R.loadValidOrders(daysAgo(365))).rejects.toThrow('orders read failed');
  });

  const lines = () => {
    h.db.tables.orders = [
      { id: 'ok', created_at: daysAgo(10), status: 'completed' },
      { id: 'cancelled', created_at: daysAgo(10), status: 'cancelled' },
      { id: 'old', created_at: daysAgo(120), status: 'completed' },
    ];
    h.db.tables.order_items = [
      { id: '1', order_id: 'ok', variant_id: 'v1', quantity: 2, line_total_inr: 360, voided: false },
      { id: '2', order_id: 'ok', variant_id: null, quantity: 1, line_total_inr: 100, voided: false },
      { id: '3', order_id: 'ok', variant_id: 'v1', quantity: 1, line_total_inr: 180, voided: true },
      { id: '4', order_id: 'cancelled', variant_id: 'v1', quantity: 1, line_total_inr: 999 },
      { id: '5', order_id: 'old', variant_id: 'v1', quantity: 1, line_total_inr: 999 },
    ];
  };

  it('reads non-voided lines of valid orders in the window, keeping legacy lines with no variant', async () => {
    lines();
    const rows = await R.loadFoodCostLines(admin(), daysAgo(90));
    expect(rows).toEqual([
      { variant_id: 'v1', quantity: 2, line_total_inr: 360, voided: false },
      { variant_id: null, quantity: 1, line_total_inr: 100, voided: false },
      { variant_id: 'v1', quantity: 1, line_total_inr: 180, voided: true },
    ]);
  });

  it('retries without `voided` on a database that lacks the column (nothing there can be voided)', async () => {
    lines();
    h.db = newDb({ missingColumns: { order_items: ['voided'] } });
    lines();
    // The fake reports the missing column only for filters/payloads; emulate the select failing once.
    h.db.failNext('select order_items', { code: '42703', message: 'column order_items.voided does not exist' });
    const rows = await R.loadFoodCostLines(admin(), daysAgo(90));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.voided === false || r.voided === true)).toBe(true);
  });

  it('spend and sends are counted over the window given', async () => {
    h.db.tables.marketing_recipients = [
      { id: '1', status: 'sent', sent_at: daysAgo(1), cost_inr: 1.02 },
      { id: '2', status: 'delivered', sent_at: daysAgo(2), cost_inr: '1.020' },
      { id: '3', status: 'sent', sent_at: daysAgo(40), cost_inr: 1.02 },
      { id: '4', status: 'failed', sent_at: null, cost_inr: 0 },
      { id: '5', status: 'queued' },
      { id: '6', status: 'sending' },
    ];
    expect(await R.sumSpendSince(admin(), daysAgo(10))).toBeCloseTo(2.04);
    expect(await R.countSentSince(admin(), daysAgo(10))).toBe(2);
    expect(await R.countCommittedSends(admin())).toBe(2);
  });

  it('menu variants come with their item\'s name, category and availability, in menu order', async () => {
    h.db.tables.menu_items = [
      { id: 'i2', name: 'Waffle', category: 'Waffles', is_available: false, sort_order: 1 },
      { id: 'i1', name: 'Latte', category: 'Coffee', is_available: true, sort_order: 1 },
    ];
    h.db.tables.menu_item_variants = [
      { id: 'v2', menu_item_id: 'i2', label: 'Regular', price_inr: 150, sort_order: 1 },
      { id: 'v1b', menu_item_id: 'i1', label: 'Large', price_inr: 240, sort_order: 2 },
      { id: 'v1a', menu_item_id: 'i1', label: 'Small', price_inr: 180, sort_order: 1 },
    ];
    const rows = await R.loadMenuVariants(admin());
    expect(rows.map((r) => [r.variant_id, r.item_name, r.category, r.is_available])).toEqual([
      ['v1a', 'Latte', 'Coffee', true],
      ['v1b', 'Latte', 'Coffee', true],
      ['v2', 'Waffle', 'Waffles', false],
    ]);
    h.db.tables.menu_item_costs = [{ variant_id: 'v1a', cost_inr: '45.50' }];
    const inputs = R.toFreeItemInputs(rows, await R.loadCostMap(admin()));
    expect(inputs.find((v) => v.variant_id === 'v1a')!.cost_inr).toBe(45.5);
    expect(inputs.find((v) => v.variant_id === 'v1b')!.cost_inr).toBeNull();
  });
});

describe('row mappers', () => {
  it('a recipient row with missing optional columns still satisfies the contract', () => {
    const r = R.toRecipientRow({ id: 'x', campaign_id: 'c', phone: '+919111111111', status: 'queued' });
    expect(r).toMatchObject({ arm: 'treatment', skip_reason: '', vars: {}, coupon_id: null, click_token: null, cost_inr: 0, attributed_via: '', attempts: 0 });
  });

  it('a campaign row with a corrupt playbook_key has none', () => {
    const c = R.toCampaignRow({ id: 'c', kind: 'playbook', playbook_key: 'hack', status: 'draft' } as Row);
    expect(c.playbook_key).toBeNull();
    expect(c.template).toMatchObject({ name: '', vars: [] });
    expect(c.offer).toEqual({ type: 'none' });
  });
});
