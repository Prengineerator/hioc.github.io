import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_VARIANT_LABEL,
  addToken,
  addableTokens,
  candidateLabel,
  candidateName,
  customerOfferText,
  describeOfferForOwner,
  draftToOfferInput,
  emptyOfferDraft,
  moveToken,
  numberToField,
  offerToDraft,
  pickVariant,
  previewValues,
  removeToken,
  renderTemplatePreview,
  switchOfferType,
  templateProblems,
  templateToDraft,
  typedNumber,
  variantOptions,
} from '@/components/owner/marketing/drafts';
import {
  MODE_HELP,
  PARAM_FIELDS,
  buildPlaybookPatch,
  describeChanges,
  paramBounds,
  playbookHasOffer,
  playbookToDraft,
} from '@/components/owner/marketing/playbookForm';
import {
  MESSAGE_COST_HELP,
  SETTING_GROUPS,
  SETTING_KEYS,
  allowedRange,
  buildSettingsPatch,
  fieldBounds,
  hasSettingsProblems,
  settingFieldError,
  settingsToDraft,
} from '@/components/owner/marketing/settingsForm';
import {
  API,
  classifyFailure,
  errorTextFrom,
  isAborted,
  requestJson,
} from '@/components/owner/marketing/api';
import { parseOffer } from '@/lib/marketing/parse';
import {
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATES,
  PARAM_BOUNDS,
  PLAYBOOK_KEYS,
  TEMPLATE_MAX_VARS,
  defaultPlaybook,
  type FreeItemCandidate,
  type Offer,
  type PlaybookKey,
  type PlaybookView,
} from '@/lib/marketing/types';

const ITEM = '11111111-1111-4111-8111-111111111111';
const VARIANT = '22222222-2222-4222-8222-222222222222';
const OTHER_VARIANT = '33333333-3333-4333-8333-333333333333';

const candidate = (over: Partial<FreeItemCandidate> = {}): FreeItemCandidate => ({
  item_id: ITEM,
  item_name: 'Cold Coffee',
  variant_id: VARIANT,
  variant_label: 'Large',
  price_inr: 180,
  cost_inr: 45,
  value_per_rupee: 4,
  ...over,
});

function view<K extends PlaybookKey>(key: K, over: Partial<PlaybookView> = {}): PlaybookView {
  return {
    ...defaultPlaybook(key),
    mode: 'off',
    observed_treated: 0,
    observed_conversions: 0,
    last_planned_at: null,
    updated_at: null,
    label: key,
    description: '',
    learned_conversion_pct: 10,
    last_runs: [],
    ...over,
  } as unknown as PlaybookView;
}

describe('numbers typed into a box', () => {
  it('never turns a blank required field into a silent zero', () => {
    expect(typedNumber('')).toBeNaN();
    expect(typedNumber('   ')).toBeNaN();
    expect(typedNumber('', 0)).toBe(0);
    expect(typedNumber('₹1,200')).toBe(1200);
    expect(typedNumber('abc')).toBeNaN();
    expect(numberToField(45)).toBe('45');
    expect(numberToField(null)).toBe('');
    expect(numberToField(Number.NaN)).toBe('');
  });
});

describe('offer drafts', () => {
  const offers: Offer[] = [
    { type: 'none' },
    { type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 },
    { type: 'flat', amount_inr: 50, min_order_inr: 100, validity_days: 7 },
    { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 },
    { type: 'free_item', item_id: ITEM, variant_id: VARIANT, max_item_price: 300, min_order_inr: 0, validity_days: 5 },
  ];

  it('round-trips every offer type through the parser unchanged', () => {
    for (const offer of offers) {
      const parsed = parseOffer(draftToOfferInput(offerToDraft(offer)));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(offer);
    }
  });

  it('loads a type\'s defaults when the owner switches to it, and carries nothing over', () => {
    const flat = switchOfferType('flat');
    expect(flat.type).toBe('flat');
    expect(flat.amount_inr).toBe('50');
    expect(flat.percent).toBe('');
    expect(flat.cap_inr).toBe('');
    const none = switchOfferType('none');
    expect(none).toEqual({ ...emptyOfferDraft(), type: 'none' });
    expect(parseOffer(draftToOfferInput(switchOfferType('percent'))).ok).toBe(true);
    expect(parseOffer(draftToOfferInput(switchOfferType('free_item'))).ok).toBe(true);
  });

  it('uses the shared parser\'s sentence for a bad box', () => {
    const d = { ...switchOfferType('percent'), percent: '' };
    const r = parseOffer(draftToOfferInput(d));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Discount % must be a whole number between 1 and 50.');
    const over = parseOffer(draftToOfferInput({ ...switchOfferType('percent'), percent: '75' }));
    expect(over.ok).toBe(false);
  });

  it('treats a blank optional box (cap, minimum order) as 0 but a blank required one as missing', () => {
    const d = { ...switchOfferType('percent'), cap_inr: '', min_order_inr: '' };
    const r = parseOffer(draftToOfferInput(d));
    expect(r.ok && r.value).toMatchObject({ cap_inr: 0, min_order_inr: 0 });
    expect(parseOffer(draftToOfferInput({ ...d, validity_days: '' })).ok).toBe(false);
  });
});

describe('free-item picker', () => {
  const ranking = [candidate(), candidate({ variant_id: OTHER_VARIANT, item_name: 'Waffle', variant_label: 'Regular', price_inr: 150, cost_inr: 50, value_per_rupee: 3 })];

  it('lists Auto first, then the ranking best-first', () => {
    const options = variantOptions(ranking, '');
    expect(options[0]).toMatchObject({ value: '', label: AUTO_VARIANT_LABEL });
    expect(options.map((o) => o.value)).toEqual(['', VARIANT, OTHER_VARIANT]);
    expect(options[1].label).toBe('Cold Coffee (Large) · worth ₹180, costs ₹45 · 4.0× value');
    expect(options[2].label).toContain('Waffle ·'); // "Regular" needs no label
  });

  it('keeps a saved choice that is no longer ranked instead of silently swapping it to Auto', () => {
    const options = variantOptions(ranking, '99999999-9999-4999-8999-999999999999');
    expect(options[options.length - 1].label).toContain('Current choice');
  });

  it('sets item and variant together (the parser rejects one without the other)', () => {
    const base = switchOfferType('free_item');
    const picked = pickVariant(base, VARIANT, ranking);
    expect(picked).toMatchObject({ variant_id: VARIANT, item_id: ITEM });
    expect(parseOffer(draftToOfferInput(picked)).ok).toBe(true);
    expect(pickVariant(picked, '', ranking)).toMatchObject({ variant_id: '', item_id: '' });
    // a variant that dropped out of the ranking keeps the item id we already hold
    expect(pickVariant({ ...base, item_id: ITEM }, '99999999-9999-4999-8999-999999999999', ranking).item_id).toBe(ITEM);
  });

  it('names candidates and offers as the customer would', () => {
    expect(candidateName(candidate())).toBe('Cold Coffee (Large)');
    expect(candidateName(candidate({ variant_label: 'Regular' }))).toBe('Cold Coffee');
    expect(candidateLabel(candidate())).toContain('4.0× value');
    const auto: Offer = { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 };
    expect(describeOfferForOwner(auto, ranking)).toContain('best-value pick');
    const chosen: Offer = { ...auto, item_id: ITEM, variant_id: VARIANT };
    expect(describeOfferForOwner(chosen, ranking)).toBe('a FREE Cold Coffee (Large) with any order above ₹200');
    expect(describeOfferForOwner({ type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 }, [])).toBe('10% off (up to ₹60) on orders above ₹150');
    expect(describeOfferForOwner({ type: 'none' }, [])).toBe('No offer');
  });

  it('words the customer preview plainly, and only the owner is told the item is picked later', () => {
    const auto: Offer = { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 };
    // What goes into {{offer_text}} in a preview must read like a real message…
    expect(customerOfferText(auto, ranking)).toBe('a FREE item with any order above ₹200');
    expect(customerOfferText({ ...auto, item_id: ITEM, variant_id: VARIANT }, ranking)).toBe('a FREE Cold Coffee (Large) with any order above ₹200');
    expect(customerOfferText({ type: 'none' }, ranking)).toBe('');
    // …a saved choice that dropped out of the ranking is not mislabelled as "best value".
    const stale: Offer = { ...auto, item_id: ITEM, variant_id: OTHER_VARIANT };
    expect(describeOfferForOwner(stale, [candidate()])).toContain('your saved choice');
  });
});

describe('template editing', () => {
  const vars = ['first_name', 'points', 'code'] as const;

  it('reorders, adds and removes variables without mutating', () => {
    const v = [...vars];
    expect(moveToken(v, 1, -1)).toEqual(['points', 'first_name', 'code']);
    expect(moveToken(v, 1, 1)).toEqual(['first_name', 'code', 'points']);
    expect(moveToken(v, 0, -1)).toEqual(v);
    expect(moveToken(v, 2, 1)).toEqual(v);
    expect(removeToken(v, 1)).toEqual(['first_name', 'code']);
    expect(addToken(v, 'valid_till')).toEqual([...vars, 'valid_till']);
    expect(v).toEqual([...vars]);
    const full = Array.from({ length: TEMPLATE_MAX_VARS }, () => 'points' as const);
    expect(addToken(full, 'code')).toHaveLength(TEMPLATE_MAX_VARS);
  });

  it('offers the headline variable only to manual campaigns', () => {
    expect(addableTokens(false)).not.toContain('headline');
    expect(addableTokens(true)).toContain('headline');
  });

  it('previews with the REAL offer wording, not the stock sample', () => {
    const t = templateToDraft({ ...DEFAULT_TEMPLATES.winback, vars: [...DEFAULT_TEMPLATES.winback.vars] });
    expect(previewValues('20% off', undefined).offer_text).toBe('20% off');
    expect(previewValues('', undefined).offer_text).toContain('10% off');
    const text = renderTemplatePreview(t, '15% off (up to ₹90)');
    expect(text).toContain('Hi Asha,');
    expect(text).toContain("Here's 15% off (up to ₹90) on your next visit");
    expect(text).toContain('WBK7M3QX');
    expect(text).toContain('12 Oct');
    expect(renderTemplatePreview({ vars: [], body_preview: '  ' })).toBe('');
    expect(renderTemplatePreview({ vars: ['headline'], body_preview: 'Try {{1}}' }, '', 'Iced mocha')).toBe('Try Iced mocha');
  });

  it('finds nothing to complain about in any of the four shipped templates', () => {
    for (const t of Object.values(DEFAULT_TEMPLATES)) expect(templateProblems(t)).toEqual([]);
  });

  it('flags the usual reasons Meta rejects a template or a send fails', () => {
    const p = (body: string, v: string[]) => templateProblems({ vars: v as never, body_preview: body });
    expect(p('Hi {{1}}, you have {{5}} points. Bye', ['first_name', 'points', 'code'])[0]).toContain('{{5}}');
    expect(p('Hi {{1}}, hello. Bye', ['first_name', 'points'])[0]).toContain('{{2}}');
    expect(p('{{1}} hello there', ['first_name'])[0]).toContain('starts with a variable');
    expect(p('Hello there {{1}}', ['first_name'])[0]).toContain('ends with a variable');
    expect(p('Hi {{1}}{{2}} and bye', ['first_name', 'code'])[0]).toContain('next to each other');
    expect(p('Hi {{1}}, thanks for coming. See you!', ['first_name'])).toEqual([]);
    expect(p('', [])).toEqual([]);
    expect(p('x'.repeat(1025), ['first_name'])[0]).toContain('1024');
  });
});

describe('playbook cards → PATCH body', () => {
  it('lists exactly the params each playbook has (a new param must get a field)', () => {
    for (const key of PLAYBOOK_KEYS) {
      expect(PARAM_FIELDS[key].map((f) => f.name).sort()).toEqual(Object.keys(defaultPlaybook(key).params).sort());
      for (const f of PARAM_FIELDS[key]) {
        expect(paramBounds(key, f.name)).toEqual((PARAM_BOUNDS[key] as Record<string, { min: number; max: number }>)[f.name]);
        expect(f.help.length).toBeGreaterThan(10);
      }
    }
  });

  it('sends nothing when nothing changed', () => {
    for (const key of PLAYBOOK_KEYS) {
      const v = view(key);
      const r = buildPlaybookPatch(v, playbookToDraft(v));
      expect(r.changed).toEqual([]);
      expect(r.patch).toBeUndefined();
      expect(r.error).toBeUndefined();
    }
  });

  it('sends only what changed', () => {
    const v = view('winback_1');
    const d = playbookToDraft(v);
    d.mode = 'review';
    d.params = { ...d.params, min_days: '10' };
    const r = buildPlaybookPatch(v, d);
    expect(r.changed).toEqual(['mode', 'params']);
    expect(r.patch).toEqual({ mode: 'review', params: { min_days: 10 } });
  });

  it('carries an edited offer, template and prior', () => {
    const v = view('winback_1');
    const d = playbookToDraft(v);
    d.offer = switchOfferType('flat');
    d.template = { ...d.template, name: 'hioc_winback_2' };
    d.prior = '20';
    const r = buildPlaybookPatch(v, d);
    expect(r.changed).toEqual(['offer', 'template', 'prior']);
    expect(r.patch?.offer).toEqual({ type: 'flat', amount_inr: 50, min_order_inr: 150, validity_days: 10 });
    expect(r.patch?.template?.name).toBe('hioc_winback_2');
    expect(r.patch?.prior_conversion_pct).toBe(20);
  });

  it('reports the shared parser\'s sentence for a bad value instead of sending it', () => {
    const v = view('winback_1');
    const blank = playbookToDraft(v);
    blank.params = { ...blank.params, min_days: '' };
    const r1 = buildPlaybookPatch(v, blank);
    expect(r1.patch).toBeUndefined();
    expect(r1.error).toContain('Min days');

    const cross = playbookToDraft(v);
    cross.params = { ...cross.params, min_days: '50' }; // the patch carries only min_days; the stored max_days is 45
    expect(buildPlaybookPatch(v, cross).error).toContain('shortest lapse threshold');

    const lost = view('winback_3');
    const lostDraft = playbookToDraft(lost);
    lostDraft.params = { ...lostDraft.params, offset_days: '200' }; // stored "lost after" is 180
    expect(buildPlaybookPatch(lost, lostDraft).error).toContain('lost after');

    const prior = playbookToDraft(v);
    prior.prior = '150';
    expect(buildPlaybookPatch(v, prior).error).toContain('Expected conversion %');
    prior.prior = '';
    expect(buildPlaybookPatch(v, prior).error).toContain('Expected conversion %');

    const offer = playbookToDraft(v);
    offer.offer = { ...offer.offer, percent: '' };
    expect(buildPlaybookPatch(v, offer).error).toContain('Discount %');
  });

  it('rejects a bad template name and an empty variable list', () => {
    const v = view('points_expiring');
    const d = playbookToDraft(v);
    d.template = { ...d.template, name: 'Bad Name' };
    expect(buildPlaybookPatch(v, d).error).toContain('lowercase');
    const d2 = playbookToDraft(v);
    d2.template = { ...d2.template, vars: [] };
    expect(buildPlaybookPatch(v, d2).error).toContain('between 1 and 10 variables');
  });

  it('never offers a coupon on a points reminder', () => {
    expect(playbookHasOffer('points_expiring')).toBe(false);
    expect(playbookHasOffer('points_balance')).toBe(false);
    expect(playbookHasOffer('winback_2')).toBe(true);
    const v = view('points_balance');
    const d = playbookToDraft(v);
    d.offer = switchOfferType('percent');
    expect(buildPlaybookPatch(v, d).changed).toEqual([]);
  });

  it('describes the changes and each mode in words', () => {
    expect(describeChanges([])).toBe('No changes');
    expect(describeChanges(['mode', 'prior'])).toBe('Changed: mode, expected conversion');
    expect(MODE_HELP.auto).toContain('every guardrail passes');
    expect(MODE_HELP.review).toContain('Approvals');
  });
});

describe('settings form', () => {
  it('has a box for every editable setting and none for the kill switch (it saves by itself)', () => {
    const editable = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'enabled' && k !== 'updated_at');
    expect([...SETTING_KEYS].sort()).toEqual(editable.sort());
    for (const g of SETTING_GROUPS) for (const f of g.fields) expect(f.help.length).toBeGreaterThan(20);
  });

  it('says what message cost means', () => {
    expect(MESSAGE_COST_HELP).toContain('Meta marketing rate + 18% GST');
    expect(MESSAGE_COST_HELP).toContain('₹1.02');
  });

  it('starts with no changes and no problems', () => {
    const r = buildSettingsPatch(DEFAULT_SETTINGS, settingsToDraft(DEFAULT_SETTINGS));
    expect(r.patch).toEqual({});
    expect(r.errors).toEqual({});
    expect(r.formError).toBeNull();
    expect(hasSettingsProblems(r)).toBe(false);
  });

  it('sends only the boxes that changed', () => {
    const d = settingsToDraft(DEFAULT_SETTINGS);
    d.monthly_budget_inr = '2000';
    d.message_cost_inr = '1.05';
    d.holdout_pct = '20';
    expect(buildSettingsPatch(DEFAULT_SETTINGS, d).patch).toEqual({ monthly_budget_inr: 2000, message_cost_inr: 1.05, holdout_pct: 20 });
  });

  it('uses the SQL bounds and the parser sentences', () => {
    expect(settingFieldError('monthly_budget_inr', '1000000')).toBeNull();
    expect(settingFieldError('monthly_budget_inr', '1000001')).toBe('Monthly budget (₹) must be between 0 and 1000000.');
    expect(settingFieldError('monthly_budget_inr', '')).toContain('whole number');
    expect(settingFieldError('holdout_pct', '51')).toContain('between 0 and 50');
    expect(settingFieldError('message_cost_inr', '101')).toContain('between 0 and 100');
    expect(settingFieldError('pause_after_unread', '0')).toBeNull(); // 0 = off
    expect(settingFieldError('whatsapp_business_number', '')).toBeNull(); // cleared = link off
    expect(settingFieldError('whatsapp_business_number', 'call me')).toContain('valid phone number');
    expect(allowedRange('monthly_budget_inr')).toBe('Allowed: 0 to 10,00,000'); // Indian grouping, like every ₹ on the page
    expect(allowedRange('message_cost_inr')).toBe('Allowed: 0 to 100');
    expect(allowedRange('whatsapp_business_number')).toBe('');
    expect(fieldBounds('daily_send_cap')).toEqual({ min: 0, max: 10000 });
    expect(fieldBounds('whatsapp_business_number')).toBeNull();
  });

  it('holds back a save until every box is valid, and reports them all at once', () => {
    const d = settingsToDraft(DEFAULT_SETTINGS);
    d.monthly_budget_inr = '-5';
    d.holdout_pct = '99';
    const r = buildSettingsPatch(DEFAULT_SETTINGS, d);
    expect(Object.keys(r.errors).sort()).toEqual(['holdout_pct', 'monthly_budget_inr']);
    expect(hasSettingsProblems(r)).toBe(true);
    expect(r.patch).toEqual({});
  });

  it('keeps the send window in order (end after start), checked on the merged values', () => {
    const d = settingsToDraft(DEFAULT_SETTINGS); // 11 → 20
    d.send_window_end_hour = '9';
    const r = buildSettingsPatch(DEFAULT_SETTINGS, d);
    expect(r.formError).toBe('The send window must end after it starts.');
    expect(hasSettingsProblems(r)).toBe(true);
    d.send_window_end_hour = '24';
    expect(buildSettingsPatch(DEFAULT_SETTINGS, d).formError).toBeNull();
  });

  it('handles the phone number: typed, cleared, and unchanged', () => {
    const d = settingsToDraft(DEFAULT_SETTINGS);
    d.whatsapp_business_number = ' 9876543210 ';
    expect(buildSettingsPatch(DEFAULT_SETTINGS, d).patch).toEqual({ whatsapp_business_number: '9876543210' });
    const saved = { ...DEFAULT_SETTINGS, whatsapp_business_number: '+919876543210' };
    const d2 = settingsToDraft(saved);
    expect(buildSettingsPatch(saved, d2).patch).toEqual({});
    d2.whatsapp_business_number = '';
    expect(buildSettingsPatch(saved, d2).patch).toEqual({ whatsapp_business_number: '' });
  });

  it('compares a numeric column that arrives as a string by value', () => {
    const odd = { ...DEFAULT_SETTINGS, message_cost_inr: '1.020' as unknown as number };
    expect(buildSettingsPatch(odd, settingsToDraft(odd)).patch).toEqual({});
  });
});

describe('API failures', () => {
  it('turns a 409 migration_missing into the instruction the spec asks for', () => {
    const f = classifyFailure(409, { error: 'migration_missing' });
    expect(f.kind).toBe('migration_missing');
    expect(f.message).toBe('Apply supabase/2026-10-marketing-agent.sql in Supabase → SQL editor, then reload.');
    expect(classifyFailure(409, null).kind).toBe('migration_missing');
  });

  it('keeps a real 409 conflict as a message, not a migration problem', () => {
    const f = classifyFailure(409, { error: 'This campaign was already approved.' });
    expect(f).toMatchObject({ kind: 'invalid', message: 'This campaign was already approved.' });
  });

  it('classifies the rest', () => {
    expect(classifyFailure(401, {}).kind).toBe('signed_out');
    expect(classifyFailure(403, {}).kind).toBe('signed_out');
    expect(classifyFailure(400, { error: 'Monthly budget (₹) must be between 0 and 1000000.' })).toMatchObject({
      kind: 'invalid',
      message: 'Monthly budget (₹) must be between 0 and 1000000.',
    });
    expect(classifyFailure(400, null).message).toContain('not accepted');
    expect(classifyFailure(429, { error: 'Too many test messages. Try again in an hour.' }).kind).toBe('invalid');
    expect(classifyFailure(500, { error: 'Boom' })).toMatchObject({ kind: 'server', message: 'Boom' });
    expect(classifyFailure(500, { error: 'x'.repeat(500) }).message).toContain('Something went wrong');
    expect(classifyFailure(502, null).kind).toBe('server');
  });

  it('reads an error out of whatever shape it comes in', () => {
    expect(errorTextFrom({ error: 'a' })).toBe('a');
    expect(errorTextFrom({ error: { message: 'b' } })).toBe('b');
    expect(errorTextFrom({ message: 'c' })).toBe('c');
    expect(errorTextFrom('d')).toBe('d');
    expect(errorTextFrom(null)).toBe('');
    expect(errorTextFrom(42)).toBe('');
  });

  it('builds the endpoints from spec §6', () => {
    expect(API.overview).toBe('/api/owner/marketing/overview');
    expect(API.overviewSummary).toBe('/api/owner/marketing/overview?summary=1');
    expect(API.campaigns()).toBe('/api/owner/marketing/campaigns');
    expect(API.campaigns('pending_approval')).toBe('/api/owner/marketing/campaigns?status=pending_approval');
    expect(API.campaign('abc', 2)).toBe('/api/owner/marketing/campaigns/abc?page=2');
    expect(API.approve('abc')).toBe('/api/owner/marketing/campaigns/abc/approve');
    expect(API.cancel('abc')).toBe('/api/owner/marketing/campaigns/abc/cancel');
    expect(API.playbook('winback_1')).toBe('/api/owner/marketing/playbooks/winback_1');
    expect(API.campaignPreview).toBe('/api/owner/marketing/campaigns/preview');
    expect(API.optOut).toBe('/api/owner/marketing/consent/opt-out');
  });
});

describe('requestJson (never throws)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (body: unknown, status = 200) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  it('returns the parsed body on success and sends JSON', async () => {
    const fetchMock = respond({ settings: { enabled: true } });
    vi.stubGlobal('fetch', fetchMock);
    const r = await requestJson<{ settings: { enabled: boolean } }>(API.settings, { method: 'PATCH', body: { enabled: true } });
    expect(r).toEqual({ ok: true, data: { settings: { enabled: true } } });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/owner/marketing/settings');
    expect(init).toMatchObject({ method: 'PATCH', cache: 'no-store', body: '{"enabled":true}' });
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('classifies a 409 migration_missing', async () => {
    vi.stubGlobal('fetch', respond({ error: 'migration_missing' }, 409));
    const r = await requestJson(API.overview);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('migration_missing');
  });

  it('reports a dead network as a network failure, not an exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const r = await requestJson(API.overview);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('network');
      expect(isAborted(r.error)).toBe(false);
    }
  });

  it('tells an aborted request apart, so a newer one wins silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));
    const r = await requestJson(API.overview);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(isAborted(r.error)).toBe(true);
  });

  it('treats an unreadable success body as a server problem', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));
    const r = await requestJson(API.overview);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server');
  });
});
