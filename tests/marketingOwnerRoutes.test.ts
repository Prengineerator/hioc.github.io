import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/marketingDb';
import { newDb, rowsOf, seedSettings } from './helpers/marketingWorld';

// The owner marketing APIs (spec §6): every route is OWNER ONLY (401), answers a typed 409
// {error:'migration_missing'} when a marketing table is absent, validates its body with the
// pure parsers, and returns the shapes lib/marketing/types.ts promises. The engine behind
// each route has its own tests; here the engine is stubbed so the ROUTE logic is what runs.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  owner: { id: 'owner-1' } as { id: string } | null,
  rateAllowed: true,
  rateCalls: [] as [string, number, number][],
  send: vi.fn(),
  getOverview: vi.fn(),
  getAudienceSummary: vi.fn(),
  listPlaybookViews: vi.fn(),
  patchPlaybook: vi.fn(),
  listCampaigns: vi.fn(),
  createManualDraft: vi.fn(),
  previewManual: vi.fn(),
  getCampaignDetail: vi.fn(),
  approveCampaign: vi.fn(),
  cancelCampaign: vi.fn(),
  listCosts: vi.fn(),
  putCosts: vi.fn(),
}));

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(h.owner) }));
vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: (key: string, max: number, secs: number) => {
    h.rateCalls.push([key, max, secs]);
    return Promise.resolve(h.rateAllowed);
  },
}));
vi.mock('@/lib/notifications/adapters', () => ({ whatsappAdapter: { send: h.send } }));
vi.mock('@/lib/marketing/server/overview', () => ({ getOverview: h.getOverview, getAudienceSummary: h.getAudienceSummary }));
vi.mock('@/lib/marketing/server/playbooks', () => ({ listPlaybookViews: h.listPlaybookViews, patchPlaybook: h.patchPlaybook }));
vi.mock('@/lib/marketing/server/costs', () => ({ listCosts: h.listCosts, putCosts: h.putCosts }));
vi.mock('@/lib/marketing/server/campaigns', () => ({
  listCampaigns: h.listCampaigns,
  createManualDraft: h.createManualDraft,
  previewManual: h.previewManual,
  getCampaignDetail: h.getCampaignDetail,
  approveCampaign: h.approveCampaign,
  cancelCampaign: h.cancelCampaign,
}));

const { MigrationMissingError } = await import('@/lib/marketing/server/repo');
const overview = await import('@/app/api/owner/marketing/overview/route');
const audience = await import('@/app/api/owner/marketing/audience/route');
const settings = await import('@/app/api/owner/marketing/settings/route');
const playbooks = await import('@/app/api/owner/marketing/playbooks/route');
const playbookKey = await import('@/app/api/owner/marketing/playbooks/[key]/route');
const campaigns = await import('@/app/api/owner/marketing/campaigns/route');
const preview = await import('@/app/api/owner/marketing/campaigns/preview/route');
const campaignId = await import('@/app/api/owner/marketing/campaigns/[id]/route');
const approve = await import('@/app/api/owner/marketing/campaigns/[id]/approve/route');
const cancel = await import('@/app/api/owner/marketing/campaigns/[id]/cancel/route');
const testSend = await import('@/app/api/owner/marketing/test-send/route');
const costs = await import('@/app/api/owner/marketing/costs/route');
const optOut = await import('@/app/api/owner/marketing/consent/opt-out/route');

const ID = '3f2b8c0e-1111-4222-8333-444455556666';
const url = (path: string) => `http://localhost/api/owner/marketing/${path}`;
const json = (body: unknown, method = 'POST') =>
  new Request(url('x'), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const params = <T extends Record<string, string>>(p: T) => ({ params: p });

const TEMPLATE = { name: 'hioc_winback_1', lang: 'en', vars: ['first_name', 'offer_text', 'code', 'valid_till'], url_button: true, body_preview: 'Hi {{1}}, {{2}} {{3}} {{4}}' };
const MANUAL = {
  name: 'Launch',
  audience: {},
  offer: { type: 'none' },
  template: { ...TEMPLATE, vars: ['first_name'] },
};

beforeEach(() => {
  h.db = newDb();
  seedSettings(h.db);
  h.owner = { id: 'owner-1' };
  h.rateAllowed = true;
  h.rateCalls = [];
  for (const fn of [h.send, h.getOverview, h.getAudienceSummary, h.listPlaybookViews, h.patchPlaybook, h.listCampaigns, h.createManualDraft, h.previewManual, h.getCampaignDetail, h.approveCampaign, h.cancelCampaign, h.listCosts, h.putCosts]) {
    fn.mockReset();
  }
  h.send.mockResolvedValue({ ok: true, providerRef: 'wamid.T', error: '' });
  process.env.WHATSAPP_TOKEN = 'token';
  process.env.WHATSAPP_PHONE_ID = 'phone-id';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------

type Call = () => Promise<Response>;
const ALL_ROUTES: [string, Call][] = [
  ['GET overview', () => overview.GET()],
  ['GET audience', () => audience.GET()],
  ['GET settings', () => settings.GET()],
  ['PATCH settings', () => settings.PATCH(json({ enabled: true }, 'PATCH'))],
  ['GET playbooks', () => playbooks.GET()],
  ['PATCH playbooks/[key]', () => playbookKey.PATCH(json({ mode: 'review' }, 'PATCH'), params({ key: 'winback_1' }))],
  ['GET campaigns', () => campaigns.GET(new Request(url('campaigns?status=active')))],
  ['POST campaigns', () => campaigns.POST(json(MANUAL))],
  ['POST campaigns/preview', () => preview.POST(json(MANUAL))],
  ['GET campaigns/[id]', () => campaignId.GET(new Request(url(`campaigns/${ID}`)), params({ id: ID }))],
  ['POST campaigns/[id]/approve', () => approve.POST(json({}), params({ id: ID }))],
  ['POST campaigns/[id]/cancel', () => cancel.POST(json({}), params({ id: ID }))],
  ['POST test-send', () => testSend.POST(json({ template: TEMPLATE }))],
  ['GET costs', () => costs.GET()],
  ['PUT costs', () => costs.PUT(json({ costs: [] }, 'PUT'))],
  ['POST consent/opt-out', () => optOut.POST(json({ phone: '9876543210' }))],
];

describe('every owner route', () => {
  it.each(ALL_ROUTES)('%s is owner-only: 401 without an owner session, and touches nothing', async (_name, call) => {
    h.owner = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    for (const fn of [h.getOverview, h.getAudienceSummary, h.listPlaybookViews, h.patchPlaybook, h.listCampaigns, h.createManualDraft, h.previewManual, h.getCampaignDetail, h.approveCampaign, h.cancelCampaign, h.listCosts, h.putCosts, h.send]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(h.db.log).toEqual([]);
  });

  const missing = () => {
    throw new MigrationMissingError('test');
  };
  const engineThrows: [string, Call, () => void][] = [
    ['GET overview', () => overview.GET(), () => h.getOverview.mockImplementation(missing)],
    ['GET audience', () => audience.GET(), () => h.getAudienceSummary.mockImplementation(missing)],
    ['GET playbooks', () => playbooks.GET(), () => h.listPlaybookViews.mockImplementation(missing)],
    ['PATCH playbooks/[key]', () => playbookKey.PATCH(json({ mode: 'review' }, 'PATCH'), params({ key: 'winback_1' })), () => h.patchPlaybook.mockImplementation(missing)],
    ['GET campaigns', () => campaigns.GET(new Request(url('campaigns?status=active'))), () => h.listCampaigns.mockImplementation(missing)],
    ['POST campaigns', () => campaigns.POST(json(MANUAL)), () => h.createManualDraft.mockImplementation(missing)],
    ['POST campaigns/preview', () => preview.POST(json(MANUAL)), () => h.previewManual.mockImplementation(missing)],
    ['GET campaigns/[id]', () => campaignId.GET(new Request(url('x')), params({ id: ID })), () => h.getCampaignDetail.mockImplementation(missing)],
    ['POST approve', () => approve.POST(json({}), params({ id: ID })), () => h.approveCampaign.mockImplementation(missing)],
    ['POST cancel', () => cancel.POST(json({}), params({ id: ID })), () => h.cancelCampaign.mockImplementation(missing)],
    ['GET costs', () => costs.GET(), () => h.listCosts.mockImplementation(missing)],
    ['PUT costs', () => costs.PUT(json({ costs: [] }, 'PUT')), () => h.putCosts.mockImplementation(missing)],
    ['GET settings', () => settings.GET(), () => h.db.setMissing('marketing_settings', true)],
    ['PATCH settings', () => settings.PATCH(json({ enabled: true }, 'PATCH')), () => h.db.setMissing('marketing_settings', true)],
    ['POST consent/opt-out', () => optOut.POST(json({ phone: '9876543210' })), () => h.db.setMissing('marketing_consent', true)],
  ];
  it.each(engineThrows)('%s answers 409 {error:"migration_missing"} when the migration is not applied', async (_n, call, arrange) => {
    arrange();
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'migration_missing' });
  });

  it('answers a bare 500 (no internals) for any other failure', async () => {
    h.getOverview.mockRejectedValue(new Error('connection to db:5432 refused'));
    const res = await overview.GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/5432|refused/);
  });
});

describe('overview and audience', () => {
  it('return the read models untouched', async () => {
    h.getOverview.mockResolvedValue({ enabled: true, kpis: {} });
    h.getAudienceSummary.mockResolvedValue({ total_customers: 3 });
    expect(await (await overview.GET()).json()).toEqual({ enabled: true, kpis: {} });
    expect(await (await audience.GET()).json()).toEqual({ total_customers: 3 });
  });
});

describe('settings', () => {
  it('GET returns the stored settings, or the defaults when the row is missing', async () => {
    let body = await (await settings.GET()).json();
    expect(body.settings).toMatchObject({ enabled: true, monthly_budget_inr: 1000, whatsapp_business_number: '+919876500000' });
    h.db.tables.marketing_settings = [];
    body = await (await settings.GET()).json();
    expect(body.settings).toMatchObject({ enabled: false, monthly_budget_inr: 1000, message_cost_inr: 1.02, updated_at: null });
  });

  it('PATCH saves the validated fields and stamps who changed them', async () => {
    const res = await settings.PATCH(json({ enabled: false, monthly_budget_inr: 2500, whatsapp_business_number: '098765 00001' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({ enabled: false, monthly_budget_inr: 2500, whatsapp_business_number: '+919876500001' });
    expect(rowsOf(h.db, 'marketing_settings')[0]).toMatchObject({ updated_by: 'owner-1', monthly_budget_inr: 2500 });
  });

  it.each([
    [{ monthly_budget_inr: -5 }, /Monthly budget/],
    [{ holdout_pct: 80 }, /Holdout/],
    [{ enabled: 'yes' }, /enabled/],
    [{}, /Nothing to update/],
    [{ send_window_start_hour: 15, send_window_end_hour: 12 }, /must end after/],
  ])('PATCH %j is a 400 with a message the owner can act on', async (body, message) => {
    const res = await settings.PATCH(json(body, 'PATCH'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(h.db.log).toEqual([]);
  });

  it('PATCH checks the send window AFTER merging with what is stored (a patch may carry one hour)', async () => {
    seedSettings(h.db, { send_window_start_hour: 11, send_window_end_hour: 20 });
    const res = await settings.PATCH(json({ send_window_end_hour: 9 }, 'PATCH'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must end after/);
    expect(rowsOf(h.db, 'marketing_settings')[0].send_window_end_hour).toBe(20);
  });

  it('PATCH rejects a body that is not a JSON object', async () => {
    const res = await settings.PATCH(new Request(url('settings'), { method: 'PATCH', body: 'nope' }));
    expect(res.status).toBe(400);
  });
});

describe('playbooks', () => {
  it('GET lists them', async () => {
    h.listPlaybookViews.mockResolvedValue([{ key: 'winback_1' }]);
    expect(await (await playbooks.GET()).json()).toEqual({ playbooks: [{ key: 'winback_1' }] });
  });

  it('PATCH validates the key, the body, and hands the parsed patch to the engine', async () => {
    h.patchPlaybook.mockResolvedValue({ ok: true, playbook: { key: 'winback_1', mode: 'review' } });
    const ok = await playbookKey.PATCH(json({ mode: 'review', params: { min_days: 20 } }, 'PATCH'), params({ key: 'winback_1' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ playbook: { key: 'winback_1', mode: 'review' } });
    expect(h.patchPlaybook).toHaveBeenCalledWith('winback_1', { mode: 'review', params: { min_days: 20 } }, 'owner-1');

    expect((await playbookKey.PATCH(json({ mode: 'review' }, 'PATCH'), params({ key: 'nope' }))).status).toBe(404);
    expect((await playbookKey.PATCH(json({ mode: 'sometimes' }, 'PATCH'), params({ key: 'winback_1' }))).status).toBe(400);
    expect((await playbookKey.PATCH(json({ params: { made_up: 1 } }, 'PATCH'), params({ key: 'winback_1' }))).status).toBe(400);
    // A points playbook cannot carry an offer.
    expect((await playbookKey.PATCH(json({ offer: { type: 'percent', percent: 10, validity_days: 7 } }, 'PATCH'), params({ key: 'points_balance' }))).status).toBe(400);
  });

  it('PATCH answers 400 when the MERGED playbook is invalid', async () => {
    h.patchPlaybook.mockResolvedValue({ ok: false, error: 'The shortest lapse threshold cannot be longer than the longest.' });
    const res = await playbookKey.PATCH(json({ params: { min_days: 40 } }, 'PATCH'), params({ key: 'winback_1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/shortest lapse threshold/);
  });
});

describe('campaigns', () => {
  it('GET requires a valid status filter and passes it on', async () => {
    h.listCampaigns.mockResolvedValue([{ id: 'a' }]);
    for (const status of ['pending_approval', 'active', 'history']) {
      const res = await campaigns.GET(new Request(url(`campaigns?status=${status}`)));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ campaigns: [{ id: 'a' }] });
      expect(h.listCampaigns).toHaveBeenLastCalledWith(status);
    }
    expect((await campaigns.GET(new Request(url('campaigns')))).status).toBe(400);
    expect((await campaigns.GET(new Request(url('campaigns?status=all')))).status).toBe(400);
    expect((await campaigns.GET(new Request(url('campaigns?status=constructor')))).status).toBe(400);
  });

  it('POST saves a draft: 201 with the campaign, created by the owner', async () => {
    h.createManualDraft.mockResolvedValue({ ok: true, campaign: { id: 'new', status: 'draft' } });
    const res = await campaigns.POST(json({ ...MANUAL, headline: 'Hi' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ campaign: { id: 'new', status: 'draft' } });
    expect(h.createManualDraft).toHaveBeenCalledWith(expect.objectContaining({ name: 'Launch', send_after: null }), 'owner-1');
  });

  it.each([
    [{ ...MANUAL, name: '' }, /name/],
    [{ ...MANUAL, offer: { type: 'percent', percent: 90, validity_days: 7 } }, /Discount/],
    [{ ...MANUAL, template: { ...TEMPLATE, vars: ['headline'] } }, /headline/],
    [{ ...MANUAL, send_after: 'tomorrow-ish' }, /send_after/],
    [{ ...MANUAL, template: { ...MANUAL.template, name: '' } }, /template name/],
  ])('POST rejects an invalid campaign %#', async (body, message) => {
    const res = await campaigns.POST(json(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(h.createManualDraft).not.toHaveBeenCalled();
  });

  it('POST: an audience with nobody in it is a 400; any other failure a 500', async () => {
    h.createManualDraft.mockResolvedValue({ ok: false, code: 'invalid', message: 'No opted-in customers match.' });
    expect((await campaigns.POST(json(MANUAL))).status).toBe(400);
    h.createManualDraft.mockResolvedValue({ ok: false, code: 'error', message: 'boom' });
    expect((await campaigns.POST(json(MANUAL))).status).toBe(500);
  });

  it('preview validates in PREVIEW mode: an unnamed campaign and an unset template name are fine', async () => {
    h.previewManual.mockResolvedValue({ eligible: 4, projection: {}, guardrail_flags: ['no_template'], samples: [] });
    const res = await preview.POST(json({ ...MANUAL, name: '', template: { ...MANUAL.template, name: '' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ eligible: 4, guardrail_flags: ['no_template'] });
    // …but the rest is still strict.
    expect((await preview.POST(json({ ...MANUAL, offer: { type: 'wat' } }))).status).toBe(400);
  });

  it('GET [id] returns the detail; a malformed id or an unknown campaign is a 404', async () => {
    h.getCampaignDetail.mockResolvedValue({ id: ID, recipients: [] });
    expect(await (await campaignId.GET(new Request(url(`campaigns/${ID}?page=3`)), params({ id: ID }))).json()).toEqual({ id: ID, recipients: [] });
    expect(h.getCampaignDetail).toHaveBeenLastCalledWith(ID, 3);
    await campaignId.GET(new Request(url(`campaigns/${ID}?page=abc`)), params({ id: ID }));
    expect(h.getCampaignDetail).toHaveBeenLastCalledWith(ID, 1);
    expect((await campaignId.GET(new Request(url('campaigns/not-a-uuid')), params({ id: 'not-a-uuid' }))).status).toBe(404);
    h.getCampaignDetail.mockResolvedValue(null);
    expect((await campaignId.GET(new Request(url(`campaigns/${ID}`)), params({ id: ID }))).status).toBe(404);
  });

  it.each([
    ['approve', () => approve.POST(json({}), params({ id: ID })), h.approveCampaign],
    ['cancel', () => cancel.POST(json({}), params({ id: ID })), h.cancelCampaign],
  ] as const)('%s maps the outcome: 200 {campaign}, 404, 409 for the wrong state', async (_n, call, fn) => {
    fn.mockResolvedValue({ ok: true, campaign: { id: ID, status: 'x' } });
    let res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ campaign: { id: ID, status: 'x' } });

    fn.mockResolvedValue({ ok: false, code: 'not_found', message: 'Campaign not found.' });
    expect((await call()).status).toBe(404);

    fn.mockResolvedValue({ ok: false, code: 'invalid_state', message: 'This campaign is already cancelled.' });
    res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already cancelled/);
  });

  it('approve records WHO approved; a malformed id never reaches the engine', async () => {
    h.approveCampaign.mockResolvedValue({ ok: true, campaign: {} });
    await approve.POST(json({}), params({ id: ID }));
    expect(h.approveCampaign).toHaveBeenCalledWith(ID, 'owner-1');
    expect((await approve.POST(json({}), params({ id: 'x' }))).status).toBe(404);
    expect((await cancel.POST(json({}), params({ id: 'x' }))).status).toBe(404);
  });
});

describe('test-send', () => {
  beforeEach(() => {
    h.db.tables.profiles = [{ id: 'owner-1', phone: '+919876500009', phone_verified: true }];
  });

  it('sends the template with SAMPLE values to the owner\'s own phone by default, rate-limited 5/hour', async () => {
    const res = await testSend.POST(json({ template: TEMPLATE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider_ref: 'wamid.T' });
    expect(h.rateCalls).toEqual([['mkt-test:owner-1', 5, 3600]]);

    const input = h.send.mock.calls[0][0];
    expect(input).toMatchObject({ to: '+919876500009', channel: 'whatsapp', templateName: 'hioc_winback_1', templateLang: 'en' });
    // first_name, offer_text, code, valid_till — the token samples.
    expect(input.templateVars).toEqual(['Asha', '10% off (up to ₹60) on orders above ₹150', 'WBK7M3QX', '12 Oct']);
    expect(input.templateButtons).toEqual([{ index: 0, text: 'TEST' }]);
    // Not a campaign send: nothing was logged as a recipient, no coupon was made.
    expect(rowsOf(h.db, 'marketing_recipients')).toEqual([]);
    expect(rowsOf(h.db, 'coupons')).toEqual([]);
  });

  it('is a 429 once the hourly limit is used', async () => {
    h.rateAllowed = false;
    const res = await testSend.POST(json({ template: TEMPLATE }));
    expect(res.status).toBe(429);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does not spend the rate limit on a request that is invalid', async () => {
    await testSend.POST(json({ template: { ...TEMPLATE, name: '' } }));
    await testSend.POST(json({ template: { ...TEMPLATE, vars: [] } }));
    expect(h.rateCalls).toEqual([]);
  });

  it('needs a template, and a phone from somewhere', async () => {
    expect((await testSend.POST(json({}))).status).toBe(400);
    h.db.tables.profiles = [{ id: 'owner-1', phone: '' }];
    const res = await testSend.POST(json({ template: TEMPLATE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/phone number/);
  });

  it('will not message an arbitrary number: it must be the owner\'s own, or have opted in itself', async () => {
    const stranger = await testSend.POST(json({ template: TEMPLATE, phone: '9812345678' }));
    expect(stranger.status).toBe(400);
    expect((await stranger.json()).error).toMatch(/not opted in/);
    expect(h.send).not.toHaveBeenCalled();

    h.db.tables.marketing_consent = [{ phone: '+919812345678', status: 'opted_in' }];
    expect((await testSend.POST(json({ template: TEMPLATE, phone: '9812345678' }))).status).toBe(200);
    expect(h.send.mock.calls[0][0].to).toBe('+919812345678');

    h.send.mockClear();
    h.db.tables.whatsapp_opt_outs = [{ phone: '+919812345678' }];
    expect((await testSend.POST(json({ template: TEMPLATE, phone: '9812345678' }))).status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('accepts the owner\'s own number typed in another format', async () => {
    expect((await testSend.POST(json({ template: TEMPLATE, phone: '098765 00009' }))).status).toBe(200);
  });

  it('rejects a phone that is not a number', async () => {
    expect((await testSend.POST(json({ template: TEMPLATE, phone: 'call me' }))).status).toBe(400);
  });

  it('reports not-configured as a result, never through the stub', async () => {
    delete process.env.WHATSAPP_TOKEN;
    const res = await testSend.POST(json({ template: TEMPLATE }));
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining('WHATSAPP_TOKEN') });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('passes Meta\'s error back so the owner can see why', async () => {
    h.send.mockResolvedValue({ ok: false, providerRef: '', error: '(#132001) Template name does not exist in the translation' });
    const res = await testSend.POST(json({ template: TEMPLATE }));
    expect(await res.json()).toEqual({ ok: false, error: '(#132001) Template name does not exist in the translation' });
  });

  it('omits the button when the template has none', async () => {
    await testSend.POST(json({ template: { ...TEMPLATE, url_button: false } }));
    expect(h.send.mock.calls[0][0].templateButtons).toBeUndefined();
  });
});

describe('costs', () => {
  it('GET returns the listing', async () => {
    h.listCosts.mockResolvedValue({ items: [], default_food_cost_pct: 35, coverage_pct: 0, free_item_ranking: [] });
    expect(await (await costs.GET()).json()).toEqual({ items: [], default_food_cost_pct: 35, coverage_pct: 0, free_item_ranking: [] });
  });

  it('PUT validates the body, and saves as the owner', async () => {
    h.putCosts.mockResolvedValue({ ok: true, response: { items: [], default_food_cost_pct: 35, coverage_pct: 10, free_item_ranking: [] } });
    const v = '11111111-2222-4333-8444-555555555555';
    const res = await costs.PUT(json({ costs: [{ variant_id: v, cost_inr: 42.5 }, { variant_id: '66666666-2222-4333-8444-555555555555', cost_inr: null }] }, 'PUT'));
    expect(res.status).toBe(200);
    expect(h.putCosts).toHaveBeenCalledWith([{ variant_id: v, cost_inr: 42.5 }, { variant_id: '66666666-2222-4333-8444-555555555555', cost_inr: null }], 'owner-1');

    for (const bad of [{ costs: 'no' }, { costs: [{ variant_id: 'nope', cost_inr: 1 }] }, { costs: [{ variant_id: v, cost_inr: -1 }] }, { costs: [{ variant_id: v, cost_inr: 1 }, { variant_id: v, cost_inr: 2 }] }, {}]) {
      expect((await costs.PUT(json(bad, 'PUT'))).status).toBe(400);
    }
  });

  it('PUT: an unknown variant the server cannot find is a 400', async () => {
    h.putCosts.mockResolvedValue({ ok: false, error: 'That item size does not exist on the menu (x).' });
    const res = await costs.PUT(json({ costs: [{ variant_id: '11111111-2222-4333-8444-555555555555', cost_inr: 1 }] }, 'PUT'));
    expect(res.status).toBe(400);
  });
});

describe('consent/opt-out', () => {
  it('records the owner\'s opt-out for a customer who asked in person', async () => {
    h.db.tables.marketing_consent = [{ phone: '+919812345678', status: 'opted_in', source: 'profile' }];
    const res = await optOut.POST(json({ phone: '98123 45678' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rowsOf(h.db, 'marketing_consent')[0]).toMatchObject({ status: 'opted_out', source: 'owner' });
    expect(rowsOf(h.db, 'marketing_consent_events')[0]).toMatchObject({ action: 'opt_out', source: 'owner', actor: 'owner-1' });
    expect(rowsOf(h.db, 'whatsapp_opt_outs')[0]).toMatchObject({ phone: '+919812345678', source: 'marketing:owner' });
  });

  it('rejects a missing or invalid phone', async () => {
    expect((await optOut.POST(json({}))).status).toBe(400);
    expect((await optOut.POST(json({ phone: 'abc' }))).status).toBe(400);
    expect(h.db.log).toEqual([]);
  });

  it('there is NO route through which the owner can opt anyone IN', () => {
    expect(Object.keys(optOut).filter((k) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual(['POST']);
  });
});
