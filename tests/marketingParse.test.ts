import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseAudienceFilter,
  parseCostsPut,
  parseManualCampaign,
  parseOffer,
  parsePlaybookPatch,
  parseSettingsPatch,
  parseTemplate,
  validateMergedSettings,
  validatePlaybookParams,
} from '@/lib/marketing/parse';
import {
  COSTS_PUT_MAX_ROWS,
  DEFAULT_PLAYBOOKS,
  DEFAULT_SETTINGS,
  MESSAGE_COST_BOUNDS,
  PARAM_BOUNDS,
  PLAYBOOK_KEYS,
  SETTINGS_BOUNDS,
  TEMPLATE_TOKENS,
} from '@/lib/marketing/types';
import type { IntSettingKey, PlaybookKey } from '@/lib/marketing/types';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

// Narrowing helpers that fail loudly with the parser's own message.
function okValue<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.value;
}
function errorOf(r: { ok: boolean; error?: string }): string {
  if (r.ok) throw new Error('expected an error, got ok');
  return r.error as string;
}

describe('parseSettingsPatch', () => {
  it('accepts any subset', () => {
    expect(okValue(parseSettingsPatch({ enabled: true }))).toEqual({ enabled: true });
    expect(okValue(parseSettingsPatch({ monthly_budget_inr: 2500, holdout_pct: 20 }))).toEqual({ monthly_budget_inr: 2500, holdout_pct: 20 });
  });

  it('rejects a non-object body and an empty patch', () => {
    for (const body of [null, undefined, 'x', 3, [], true]) expect(parseSettingsPatch(body).ok).toBe(false);
    expect(errorOf(parseSettingsPatch({}))).toBe('Nothing to update.');
  });

  it('ignores unknown keys (an old client cannot write a future column)', () => {
    expect(okValue(parseSettingsPatch({ enabled: false, updated_at: 'x', evil: 1 }))).toEqual({ enabled: false });
    expect(parseSettingsPatch({ updated_at: 'x' }).ok).toBe(false); // nothing valid left
  });

  it('enabled must be a real boolean', () => {
    for (const v of ['true', 1, 0, null]) expect(parseSettingsPatch({ enabled: v }).ok).toBe(false);
  });

  describe('integer bounds are inclusive and exact', () => {
    for (const key of Object.keys(SETTINGS_BOUNDS) as IntSettingKey[]) {
      const { min, max } = SETTINGS_BOUNDS[key];
      it(`${key} accepts ${min} and ${max}, rejects ${min - 1} and ${max + 1}`, () => {
        // send window fields have a cross-field rule; test them one at a time (end > start is checked on merge).
        expect(okValue(parseSettingsPatch({ [key]: min }))[key]).toBe(min);
        expect(okValue(parseSettingsPatch({ [key]: max }))[key]).toBe(max);
        expect(parseSettingsPatch({ [key]: min - 1 }).ok).toBe(false);
        expect(parseSettingsPatch({ [key]: max + 1 }).ok).toBe(false);
      });
    }

    it('rejects non-integers, strings and non-finite numbers', () => {
      for (const v of [1.5, '10', null, Number.NaN, Infinity, true]) {
        expect(parseSettingsPatch({ daily_send_cap: v }).ok).toBe(false);
      }
    });

    it('the error names the field and the range', () => {
      const e = errorOf(parseSettingsPatch({ holdout_pct: 60 }));
      expect(e).toContain('Holdout %');
      expect(e).toContain('between 0 and 50');
    });
  });

  it('message_cost_inr: 0–100, up to 3 decimals (extra places are rounded off)', () => {
    expect(okValue(parseSettingsPatch({ message_cost_inr: 1.02 })).message_cost_inr).toBe(1.02);
    expect(okValue(parseSettingsPatch({ message_cost_inr: 0 })).message_cost_inr).toBe(0);
    expect(okValue(parseSettingsPatch({ message_cost_inr: 100 })).message_cost_inr).toBe(100);
    expect(okValue(parseSettingsPatch({ message_cost_inr: 0.8631 })).message_cost_inr).toBe(0.863);
    expect(parseSettingsPatch({ message_cost_inr: -0.001 }).ok).toBe(false);
    expect(parseSettingsPatch({ message_cost_inr: 100.001 }).ok).toBe(false);
    expect(parseSettingsPatch({ message_cost_inr: '1.02' }).ok).toBe(false);
  });

  it('the send window must end after it starts, when both are in the patch', () => {
    expect(okValue(parseSettingsPatch({ send_window_start_hour: 9, send_window_end_hour: 21 }))).toEqual({ send_window_start_hour: 9, send_window_end_hour: 21 });
    expect(errorOf(parseSettingsPatch({ send_window_start_hour: 20, send_window_end_hour: 20 }))).toContain('end after it starts');
    expect(parseSettingsPatch({ send_window_start_hour: 22, send_window_end_hour: 10 }).ok).toBe(false);
    // 24 = midnight is a legal end
    expect(parseSettingsPatch({ send_window_start_hour: 23, send_window_end_hour: 24 }).ok).toBe(true);
  });

  it('validateMergedSettings checks the rule on the merged row', () => {
    expect(validateMergedSettings({ send_window_start_hour: 11, send_window_end_hour: 20 })).toBeNull();
    expect(validateMergedSettings({ send_window_start_hour: 11, send_window_end_hour: 11 })).not.toBeNull();
    expect(validateMergedSettings({ send_window_start_hour: 21, send_window_end_hour: 20 })).not.toBeNull();
  });

  describe('whatsapp_business_number', () => {
    it.each([
      ['+919876543210', '+919876543210'],
      ['9876543210', '+919876543210'],
      ['919876543210', '+919876543210'],
      ['+91 98765 43210', '+919876543210'],
      ['098765 43210', '+919876543210'],
      ['(+91) 98765-43210', '+919876543210'],
      ['+14155550100', '+14155550100'],
      ['  ', ''],
      ['', ''],
    ])('%j → %j', (input, expected) => {
      expect(okValue(parseSettingsPatch({ whatsapp_business_number: input })).whatsapp_business_number).toBe(expected);
    });

    it.each(['12345', 'call me', '+0123456789', '14155550100', '5876543210'])('rejects %j', (bad) => {
      expect(parseSettingsPatch({ whatsapp_business_number: bad }).ok).toBe(false);
    });

    it('rejects a non-string', () => {
      expect(parseSettingsPatch({ whatsapp_business_number: 9876543210 }).ok).toBe(false);
    });
  });
});

describe('parseOffer', () => {
  it('none', () => {
    expect(okValue(parseOffer({ type: 'none' }))).toEqual({ type: 'none' });
    expect(okValue(parseOffer({ type: 'none', percent: 99 }))).toEqual({ type: 'none' }); // extras dropped
  });

  it('percent', () => {
    expect(okValue(parseOffer({ type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 }))).toEqual({
      type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10,
    });
  });

  it('percent: cap and minimum default to 0, percent and validity are required', () => {
    expect(okValue(parseOffer({ type: 'percent', percent: 10, validity_days: 5 }))).toEqual({
      type: 'percent', percent: 10, cap_inr: 0, min_order_inr: 0, validity_days: 5,
    });
    expect(parseOffer({ type: 'percent', validity_days: 5 }).ok).toBe(false);
    expect(parseOffer({ type: 'percent', percent: 10 }).ok).toBe(false);
  });

  describe('bounds', () => {
    const p = (over: Record<string, unknown>) => parseOffer({ type: 'percent', percent: 10, cap_inr: 0, min_order_inr: 0, validity_days: 10, ...over });
    const f = (over: Record<string, unknown>) => parseOffer({ type: 'flat', amount_inr: 50, min_order_inr: 0, validity_days: 10, ...over });

    it('percent 1–50', () => {
      expect(p({ percent: 1 }).ok).toBe(true);
      expect(p({ percent: 50 }).ok).toBe(true);
      expect(p({ percent: 0 }).ok).toBe(false);
      expect(p({ percent: 51 }).ok).toBe(false);
      expect(p({ percent: 10.5 }).ok).toBe(false);
    });

    it('flat 1–1000', () => {
      expect(f({ amount_inr: 1 }).ok).toBe(true);
      expect(f({ amount_inr: 1000 }).ok).toBe(true);
      expect(f({ amount_inr: 0 }).ok).toBe(false);
      expect(f({ amount_inr: 1001 }).ok).toBe(false);
    });

    it('validity 1–60 days', () => {
      expect(p({ validity_days: 1 }).ok).toBe(true);
      expect(p({ validity_days: 60 }).ok).toBe(true);
      expect(p({ validity_days: 0 }).ok).toBe(false);
      expect(p({ validity_days: 61 }).ok).toBe(false);
    });

    it('minimum order 0–5000', () => {
      expect(p({ min_order_inr: 0 }).ok).toBe(true);
      expect(p({ min_order_inr: 5000 }).ok).toBe(true);
      expect(p({ min_order_inr: -1 }).ok).toBe(false);
      expect(p({ min_order_inr: 5001 }).ok).toBe(false);
    });

    it('cap 0–2000 (0 = no cap)', () => {
      expect(p({ cap_inr: 0 }).ok).toBe(true);
      expect(p({ cap_inr: 2000 }).ok).toBe(true);
      expect(p({ cap_inr: -1 }).ok).toBe(false);
      expect(p({ cap_inr: 2001 }).ok).toBe(false);
    });

    it('rationals and strings are refused everywhere (rupees are whole)', () => {
      expect(p({ cap_inr: 60.5 }).ok).toBe(false);
      expect(f({ amount_inr: '50' }).ok).toBe(false);
      expect(f({ min_order_inr: 99.99 }).ok).toBe(false);
    });
  });

  describe('free_item', () => {
    const base = { type: 'free_item', min_order_inr: 200, validity_days: 10 };

    it('auto-pick: no ids, price limit defaults to ₹250', () => {
      expect(okValue(parseOffer(base))).toEqual({
        type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10,
      });
    });

    it('a pinned item and size', () => {
      expect(okValue(parseOffer({ ...base, item_id: UUID_A, variant_id: UUID_B, max_item_price: 300 }))).toMatchObject({
        item_id: UUID_A, variant_id: UUID_B, max_item_price: 300,
      });
    });

    it('needs both ids or neither', () => {
      expect(parseOffer({ ...base, item_id: UUID_A }).ok).toBe(false);
      expect(parseOffer({ ...base, variant_id: UUID_B }).ok).toBe(false);
      expect(parseOffer({ ...base, item_id: null, variant_id: null }).ok).toBe(true);
    });

    it('ids must be uuids', () => {
      expect(parseOffer({ ...base, item_id: 'nope', variant_id: UUID_B }).ok).toBe(false);
      expect(parseOffer({ ...base, item_id: 5, variant_id: 5 }).ok).toBe(false);
    });

    it('max_item_price 1–2000', () => {
      expect(parseOffer({ ...base, max_item_price: 1 }).ok).toBe(true);
      expect(parseOffer({ ...base, max_item_price: 2000 }).ok).toBe(true);
      expect(parseOffer({ ...base, max_item_price: 0 }).ok).toBe(false);
      expect(parseOffer({ ...base, max_item_price: 2001 }).ok).toBe(false);
    });

    it('DROPS the frozen fields a client sends — a cost from the browser is not a cost', () => {
      const v = okValue(parseOffer({ ...base, item_id: UUID_A, variant_id: UUID_B, item_name: 'X', variant_label: 'Y', price_inr: 1, cost_inr: 0 }));
      expect(v).not.toHaveProperty('cost_inr');
      expect(v).not.toHaveProperty('price_inr');
      expect(v).not.toHaveProperty('item_name');
      expect(v).not.toHaveProperty('variant_label');
    });
  });

  it('rejects an unknown type, a non-object and a missing type', () => {
    expect(errorOf(parseOffer({ type: 'bogo', validity_days: 5 }))).toContain('offer.type');
    expect(parseOffer(null).ok).toBe(false);
    expect(parseOffer('percent').ok).toBe(false);
    expect(parseOffer({}).ok).toBe(false);
    expect(parseOffer({ type: 'points', points_value_inr: 10 }).ok).toBe(false); // the implicit points offer is not storable
  });
});

describe('parseTemplate', () => {
  const t = (over: Record<string, unknown> = {}) => ({
    name: 'hioc_winback_1',
    lang: 'en',
    vars: ['first_name', 'offer_text', 'code', 'valid_till'],
    url_button: true,
    body_preview: 'Hi {{1}}',
    ...over,
  });

  it('accepts a valid template', () => {
    expect(okValue(parseTemplate(t()))).toEqual(t());
  });

  it('name: ^[a-z0-9_]{1,512}$', () => {
    expect(parseTemplate(t({ name: 'a' })).ok).toBe(true);
    expect(parseTemplate(t({ name: 'a_b_9' })).ok).toBe(true);
    expect(parseTemplate(t({ name: 'a'.repeat(512) })).ok).toBe(true);
    for (const bad of ['', 'a'.repeat(513), 'Upper', 'has space', 'dash-ed', 'ünï', 'a.b']) {
      expect(parseTemplate(t({ name: bad })).ok).toBe(false);
    }
    expect(parseTemplate(t({ name: 5 })).ok).toBe(false);
  });

  it('name is trimmed', () => {
    expect(okValue(parseTemplate(t({ name: '  hioc_offer_1  ' }))).name).toBe('hioc_offer_1');
  });

  it('an empty name is allowed only when asked (the wizard preview)', () => {
    expect(parseTemplate(t({ name: '' })).ok).toBe(false);
    expect(okValue(parseTemplate(t({ name: '' }), { allowEmptyName: true })).name).toBe('');
    expect(parseTemplate(t({ name: 'Bad Name' }), { allowEmptyName: true }).ok).toBe(false);
  });

  it('lang: ^[a-z]{2}(_[A-Z]{2})?$', () => {
    for (const ok of ['en', 'hi', 'en_US', 'pt_BR']) expect(parseTemplate(t({ lang: ok })).ok).toBe(true);
    for (const bad of ['', 'EN', 'eng', 'en_us', 'en-US', 'e', 'en_USA', 7]) expect(parseTemplate(t({ lang: bad })).ok).toBe(false);
  });

  it('vars: 1–10 known tokens', () => {
    expect(parseTemplate(t({ vars: ['first_name'] })).ok).toBe(true);
    expect(parseTemplate(t({ vars: [] })).ok).toBe(false);
    const ten = Array.from({ length: 10 }, () => 'first_name');
    expect(parseTemplate(t({ vars: ten })).ok).toBe(true);
    expect(parseTemplate(t({ vars: [...ten, 'first_name'] })).ok).toBe(false);
    expect(parseTemplate(t({ vars: ['first_name', 'nickname'] })).ok).toBe(false);
    expect(parseTemplate(t({ vars: 'first_name' })).ok).toBe(false);
    expect(parseTemplate(t({ vars: [5] })).ok).toBe(false);
  });

  it('every known token except headline is valid; headline only where allowed', () => {
    for (const token of TEMPLATE_TOKENS.filter((x) => x !== 'headline')) {
      expect(parseTemplate(t({ vars: [token] })).ok).toBe(true);
    }
    expect(errorOf(parseTemplate(t({ vars: ['headline'] })))).toContain('manual campaigns');
    expect(parseTemplate(t({ vars: ['headline'] }), { allowHeadline: true }).ok).toBe(true);
  });

  it('a token may repeat', () => {
    expect(okValue(parseTemplate(t({ vars: ['first_name', 'first_name'] }))).vars).toEqual(['first_name', 'first_name']);
  });

  it('url_button must be a boolean', () => {
    expect(parseTemplate(t({ url_button: false })).ok).toBe(true);
    expect(parseTemplate(t({ url_button: 'yes' })).ok).toBe(false);
    expect(parseTemplate(t({ url_button: undefined })).ok).toBe(false);
  });

  it('body_preview is optional, text, and at most 1024 characters', () => {
    const { body_preview: _omit, ...without } = t();
    void _omit;
    expect(okValue(parseTemplate(without)).body_preview).toBe('');
    expect(parseTemplate(t({ body_preview: 'x'.repeat(1024) })).ok).toBe(true);
    expect(parseTemplate(t({ body_preview: 'x'.repeat(1025) })).ok).toBe(false);
    expect(parseTemplate(t({ body_preview: 5 })).ok).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(parseTemplate(null).ok).toBe(false);
    expect(parseTemplate('hioc').ok).toBe(false);
  });
});

describe('parsePlaybookPatch', () => {
  it('accepts a mode change', () => {
    for (const mode of ['off', 'review', 'auto'] as const) {
      expect(okValue(parsePlaybookPatch('winback_1', { mode }))).toEqual({ mode });
    }
    expect(errorOf(parsePlaybookPatch('winback_1', { mode: 'sometimes' }))).toContain("'off', 'review' or 'auto'");
    expect(parsePlaybookPatch('winback_1', { mode: 1 }).ok).toBe(false);
  });

  it('rejects non-objects and empty patches', () => {
    expect(parsePlaybookPatch('winback_1', null).ok).toBe(false);
    expect(errorOf(parsePlaybookPatch('winback_1', {}))).toBe('Nothing to update.');
    expect(errorOf(parsePlaybookPatch('winback_1', { unknown: 1 }))).toBe('Nothing to update.');
  });

  it('prior_conversion_pct 0–100, two decimals', () => {
    expect(okValue(parsePlaybookPatch('winback_1', { prior_conversion_pct: 12.5 })).prior_conversion_pct).toBe(12.5);
    expect(okValue(parsePlaybookPatch('winback_1', { prior_conversion_pct: 0 })).prior_conversion_pct).toBe(0);
    expect(okValue(parsePlaybookPatch('winback_1', { prior_conversion_pct: 100 })).prior_conversion_pct).toBe(100);
    expect(okValue(parsePlaybookPatch('winback_1', { prior_conversion_pct: 12.345 })).prior_conversion_pct).toBe(12.35);
    expect(parsePlaybookPatch('winback_1', { prior_conversion_pct: 100.01 }).ok).toBe(false);
    expect(parsePlaybookPatch('winback_1', { prior_conversion_pct: -1 }).ok).toBe(false);
    expect(parsePlaybookPatch('winback_1', { prior_conversion_pct: '12' }).ok).toBe(false);
  });

  describe('params', () => {
    for (const key of PLAYBOOK_KEYS) {
      const bounds = PARAM_BOUNDS[key] as Record<string, { min: number; max: number }>;
      for (const name of Object.keys(bounds)) {
        const { min, max } = bounds[name];
        it(`${key}.${name} accepts ${min} and ${max}, rejects ${min - 1} and ${max + 1}`, () => {
          // Cross-field rules (min ≤ max, max > offset) are exercised on their own below; here use values that satisfy them.
          const ok = (v: number) => parsePlaybookPatch(key, { params: { [name]: v } }).ok;
          expect(ok(min)).toBe(true);
          expect(ok(max)).toBe(true);
          expect(ok(min - 1)).toBe(false);
          expect(ok(max + 1)).toBe(false);
        });
      }
    }

    it('params may be partial', () => {
      expect(okValue(parsePlaybookPatch('points_expiring', { params: { days_ahead: 7 } })).params).toEqual({ days_ahead: 7 });
    });

    it('rejects an unknown or misspelt parameter instead of saving it silently', () => {
      expect(errorOf(parsePlaybookPatch('points_expiring', { params: { days_ahed: 7 } }))).toContain('days_ahed');
      expect(parsePlaybookPatch('winback_2', { params: { min_points: 20 } }).ok).toBe(false); // a param of another playbook
    });

    it('params must be an object of whole numbers (gap_multiplier may have decimals)', () => {
      expect(parsePlaybookPatch('points_expiring', { params: 5 }).ok).toBe(false);
      expect(parsePlaybookPatch('points_expiring', { params: { min_points: 20.5 } }).ok).toBe(false);
      expect(parsePlaybookPatch('points_expiring', { params: { min_points: '20' } }).ok).toBe(false);
      expect(okValue(parsePlaybookPatch('winback_1', { params: { gap_multiplier: 2.25 } })).params).toEqual({ gap_multiplier: 2.25 });
      expect(okValue(parsePlaybookPatch('winback_1', { params: { gap_multiplier: 2.256 } })).params).toEqual({ gap_multiplier: 2.26 });
    });

    it('winback_1: min_days may not exceed max_days (when both are sent)', () => {
      expect(parsePlaybookPatch('winback_1', { params: { min_days: 20, max_days: 40 } }).ok).toBe(true);
      expect(parsePlaybookPatch('winback_1', { params: { min_days: 20, max_days: 20 } }).ok).toBe(true);
      expect(parsePlaybookPatch('winback_1', { params: { min_days: 41, max_days: 40 } }).ok).toBe(false);
    });

    it('winback_3: "lost after" must come after the stage 3 offset', () => {
      expect(parsePlaybookPatch('winback_3', { params: { offset_days: 60, max_days: 180 } }).ok).toBe(true);
      expect(parsePlaybookPatch('winback_3', { params: { offset_days: 100, max_days: 100 } }).ok).toBe(false);
      expect(parsePlaybookPatch('winback_3', { params: { offset_days: 200, max_days: 100 } }).ok).toBe(false);
    });

    it('validatePlaybookParams checks the same rules on merged params', () => {
      expect(validatePlaybookParams('winback_1', { min_days: 50, max_days: 45 })).not.toBeNull();
      expect(validatePlaybookParams('winback_1', { min_days: 14, max_days: 45 })).toBeNull();
      expect(validatePlaybookParams('winback_3', { offset_days: 60, max_days: 60 })).not.toBeNull();
      expect(validatePlaybookParams('winback_3', { offset_days: 60, max_days: 180 })).toBeNull();
      expect(validatePlaybookParams('points_expiring', { min_points: 20 })).toBeNull();
    });
  });

  describe('offer', () => {
    it('a win-back playbook accepts every offer type', () => {
      expect(parsePlaybookPatch('winback_2', { offer: { type: 'percent', percent: 15, validity_days: 7 } }).ok).toBe(true);
      expect(parsePlaybookPatch('winback_2', { offer: { type: 'flat', amount_inr: 40, validity_days: 7 } }).ok).toBe(true);
      expect(parsePlaybookPatch('winback_2', { offer: { type: 'free_item', validity_days: 7 } }).ok).toBe(true);
      expect(parsePlaybookPatch('winback_2', { offer: { type: 'none' } }).ok).toBe(true);
    });

    it('a points playbook can only have no offer — the customer’s Beanies are the offer', () => {
      for (const key of ['points_expiring', 'points_balance'] as const) {
        expect(parsePlaybookPatch(key, { offer: { type: 'none' } }).ok).toBe(true);
        expect(errorOf(parsePlaybookPatch(key, { offer: { type: 'percent', percent: 10, validity_days: 7 } }))).toContain('Beanies reminders cannot carry an offer: the customer’s own Beanies are the offer.');
      }
    });

    it('surfaces an invalid offer', () => {
      expect(parsePlaybookPatch('winback_1', { offer: { type: 'percent', percent: 99, validity_days: 7 } }).ok).toBe(false);
    });
  });

  describe('template', () => {
    const template = { name: 'hioc_winback_1', lang: 'en', vars: ['first_name'], url_button: true };

    it('accepts a valid template', () => {
      expect(okValue(parsePlaybookPatch('winback_1', { template })).template).toMatchObject({ name: 'hioc_winback_1' });
    });

    it('rejects the manual-only headline token in a playbook template', () => {
      expect(parsePlaybookPatch('winback_1', { template: { ...template, vars: ['headline'] } }).ok).toBe(false);
    });

    it('rejects an empty template name (a playbook must be saved with a template)', () => {
      expect(parsePlaybookPatch('winback_1', { template: { ...template, name: '' } }).ok).toBe(false);
    });
  });

  it('accepts everything at once', () => {
    const v = okValue(
      parsePlaybookPatch('winback_1', {
        mode: 'review',
        params: { min_days: 10 },
        offer: { type: 'percent', percent: 12, cap_inr: 50, min_order_inr: 100, validity_days: 9 },
        template: { name: 'hioc_winback_1', lang: 'en', vars: ['first_name', 'offer_text', 'code', 'valid_till'], url_button: true },
        prior_conversion_pct: 14,
      }),
    );
    expect(Object.keys(v).sort()).toEqual(['mode', 'offer', 'params', 'prior_conversion_pct', 'template']);
  });

  it('the seeded default of every playbook is a valid patch for it', () => {
    for (const key of PLAYBOOK_KEYS) {
      const d = DEFAULT_PLAYBOOKS[key];
      const r = parsePlaybookPatch(key, { params: d.params, offer: d.offer, template: d.template, prior_conversion_pct: d.prior_conversion_pct });
      expect(r.ok, `${key}: ${r.ok ? '' : r.error}`).toBe(true);
    }
  });
});

describe('parseAudienceFilter', () => {
  it('missing or null is an empty filter (everyone)', () => {
    expect(okValue(parseAudienceFilter(undefined))).toEqual({});
    expect(okValue(parseAudienceFilter(null))).toEqual({});
    expect(okValue(parseAudienceFilter({}))).toEqual({});
  });

  it('accepts every field', () => {
    const f = okValue(
      parseAudienceFilter({
        stages: ['lapsed_1', 'lapsed_2'], vip_only: true, min_orders: 3, min_spend_inr: 1000,
        last_order_from_days: 30, last_order_to_days: 90, min_points: 50,
      }),
    );
    expect(f).toEqual({
      stages: ['lapsed_1', 'lapsed_2'], vip_only: true, min_orders: 3, min_spend_inr: 1000,
      last_order_from_days: 30, last_order_to_days: 90, min_points: 50,
    });
  });

  it('stages must be known, and are de-duplicated; an empty list means all', () => {
    expect(okValue(parseAudienceFilter({ stages: ['active', 'active'] })).stages).toEqual(['active']);
    expect(okValue(parseAudienceFilter({ stages: [] }))).toEqual({});
    expect(parseAudienceFilter({ stages: ['vip'] }).ok).toBe(false);
    expect(parseAudienceFilter({ stages: 'active' }).ok).toBe(false);
    expect(parseAudienceFilter({ stages: [3] }).ok).toBe(false);
  });

  it('bounds', () => {
    expect(parseAudienceFilter({ min_orders: 0 }).ok).toBe(true);
    expect(parseAudienceFilter({ min_orders: 1000 }).ok).toBe(true);
    expect(parseAudienceFilter({ min_orders: 1001 }).ok).toBe(false);
    expect(parseAudienceFilter({ min_orders: -1 }).ok).toBe(false);
    expect(parseAudienceFilter({ min_spend_inr: 1_000_000 }).ok).toBe(true);
    expect(parseAudienceFilter({ min_spend_inr: 1_000_001 }).ok).toBe(false);
    expect(parseAudienceFilter({ last_order_from_days: 730 }).ok).toBe(true);
    expect(parseAudienceFilter({ last_order_to_days: 731 }).ok).toBe(false);
    expect(parseAudienceFilter({ min_points: 100_001 }).ok).toBe(false);
    expect(parseAudienceFilter({ min_points: 1.5 }).ok).toBe(false);
  });

  it('"from" cannot be later than "to"', () => {
    expect(parseAudienceFilter({ last_order_from_days: 30, last_order_to_days: 30 }).ok).toBe(true);
    expect(parseAudienceFilter({ last_order_from_days: 31, last_order_to_days: 30 }).ok).toBe(false);
  });

  it('vip_only must be a boolean; false is dropped', () => {
    expect(okValue(parseAudienceFilter({ vip_only: false }))).toEqual({});
    expect(parseAudienceFilter({ vip_only: 'yes' }).ok).toBe(false);
  });

  it('null numeric fields are ignored, non-objects are refused', () => {
    expect(okValue(parseAudienceFilter({ min_orders: null }))).toEqual({});
    expect(parseAudienceFilter('everyone').ok).toBe(false);
    expect(parseAudienceFilter([]).ok).toBe(false);
  });
});

describe('parseManualCampaign', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    name: 'Diwali coffee push',
    audience: { stages: ['active'] },
    offer: { type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 },
    template: { name: 'hioc_offer_1', lang: 'en', vars: ['first_name', 'headline', 'offer_text', 'code', 'valid_till'], url_button: true },
    headline: 'Diwali special',
    send_after: null,
    ...over,
  });

  it('accepts a complete campaign and normalises it', () => {
    const v = okValue(parseManualCampaign(body()));
    expect(v).toMatchObject({
      name: 'Diwali coffee push',
      audience: { stages: ['active'] },
      headline: 'Diwali special',
      send_after: null,
    });
    expect(v.template.body_preview).toBe('');
  });

  it('name: 1–80 characters after trimming', () => {
    expect(okValue(parseManualCampaign(body({ name: '  Padded  ' }))).name).toBe('Padded');
    expect(parseManualCampaign(body({ name: 'x'.repeat(80) })).ok).toBe(true);
    expect(parseManualCampaign(body({ name: 'x'.repeat(81) })).ok).toBe(false);
    expect(parseManualCampaign(body({ name: '' })).ok).toBe(false);
    expect(parseManualCampaign(body({ name: '   ' })).ok).toBe(false);
    expect(parseManualCampaign(body({ name: 7 })).ok).toBe(false);
    expect(parseManualCampaign(body({ name: undefined })).ok).toBe(false);
  });

  it('headline: at most 60 characters, newlines flattened, blank dropped', () => {
    expect(parseManualCampaign(body({ headline: 'x'.repeat(60) })).ok).toBe(true);
    expect(parseManualCampaign(body({ headline: 'x'.repeat(61) })).ok).toBe(false);
    expect(okValue(parseManualCampaign(body({ headline: 'Two\nlines   here' }))).headline).toBe('Two lines here');
    expect(parseManualCampaign(body({ headline: 5 })).ok).toBe(false);
  });

  it('a template that uses {headline} needs one', () => {
    expect(errorOf(parseManualCampaign(body({ headline: '' })))).toContain('headline');
    expect(parseManualCampaign(body({ headline: undefined })).ok).toBe(false);
    // ...but a template that does not, does not.
    const noHeadline = { name: 'hioc_winback_1', lang: 'en', vars: ['first_name', 'code'], url_button: false };
    expect(parseManualCampaign(body({ template: noHeadline, headline: undefined })).ok).toBe(true);
  });

  it('audience defaults to everyone and is validated', () => {
    expect(okValue(parseManualCampaign(body({ audience: undefined }))).audience).toEqual({});
    expect(parseManualCampaign(body({ audience: { stages: ['bogus'] } })).ok).toBe(false);
    expect(parseManualCampaign(body({ audience: { min_orders: 5000 } })).ok).toBe(false);
  });

  it('offer is required and validated', () => {
    expect(parseManualCampaign(body({ offer: undefined })).ok).toBe(false);
    expect(parseManualCampaign(body({ offer: { type: 'percent', percent: 99, validity_days: 5 } })).ok).toBe(false);
    expect(parseManualCampaign(body({ offer: { type: 'none' } })).ok).toBe(true);
  });

  it('template is required and validated (headline token allowed)', () => {
    expect(parseManualCampaign(body({ template: undefined })).ok).toBe(false);
    expect(parseManualCampaign(body({ template: { name: 'Bad Name', lang: 'en', vars: ['first_name'], url_button: true } })).ok).toBe(false);
  });

  it('send_after: ISO or null, normalised to an ISO string', () => {
    expect(okValue(parseManualCampaign(body({ send_after: '2026-10-05T09:30:00+05:30' }))).send_after).toBe('2026-10-05T04:00:00.000Z');
    expect(okValue(parseManualCampaign(body({ send_after: null }))).send_after).toBeNull();
    expect(okValue(parseManualCampaign(body({ send_after: undefined }))).send_after).toBeNull();
    expect(parseManualCampaign(body({ send_after: 'tomorrow-ish' })).ok).toBe(false);
    expect(parseManualCampaign(body({ send_after: 12345 })).ok).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(parseManualCampaign(null).ok).toBe(false);
    expect(parseManualCampaign([]).ok).toBe(false);
  });

  describe('preview mode (the wizard’s live projection)', () => {
    it('accepts an unnamed campaign and an unset template name so the no_template flag can show', () => {
      const partial = body({ name: '', template: { name: '', lang: 'en', vars: ['first_name'], url_button: true }, headline: undefined });
      expect(parseManualCampaign(partial).ok).toBe(false);
      const v = okValue(parseManualCampaign(partial, { preview: true }));
      expect(v.name).toBe('');
      expect(v.template.name).toBe('');
    });

    it('tolerates a missing headline while typing', () => {
      expect(parseManualCampaign(body({ headline: undefined }), { preview: true }).ok).toBe(true);
    });

    it('is still strict about everything else', () => {
      expect(parseManualCampaign(body({ offer: { type: 'percent', percent: 99, validity_days: 5 } }), { preview: true }).ok).toBe(false);
      expect(parseManualCampaign(body({ name: 'x'.repeat(81) }), { preview: true }).ok).toBe(false);
      expect(parseManualCampaign(body({ template: { name: 'Bad Name', lang: 'en', vars: ['first_name'], url_button: true } }), { preview: true }).ok).toBe(false);
    });
  });
});

describe('parseCostsPut', () => {
  it('accepts costs and nulls', () => {
    expect(okValue(parseCostsPut({ costs: [{ variant_id: UUID_A, cost_inr: 45.5 }, { variant_id: UUID_B, cost_inr: null }] }))).toEqual({
      costs: [{ variant_id: UUID_A, cost_inr: 45.5 }, { variant_id: UUID_B, cost_inr: null }],
    });
  });

  it('an empty list is a valid no-op; a missing or non-array list is not', () => {
    expect(okValue(parseCostsPut({ costs: [] }))).toEqual({ costs: [] });
    expect(parseCostsPut({}).ok).toBe(false);
    expect(parseCostsPut({ costs: 'x' }).ok).toBe(false);
    expect(parseCostsPut(null).ok).toBe(false);
  });

  it('cost_inr: null or 0–100000, kept to 2 decimals', () => {
    const one = (cost_inr: unknown) => parseCostsPut({ costs: [{ variant_id: UUID_A, cost_inr }] });
    expect(one(0).ok).toBe(true);
    expect(one(100000).ok).toBe(true);
    expect(one(-0.01).ok).toBe(false);
    expect(one(100000.01).ok).toBe(false);
    expect(okValue(one(12.345)).costs[0].cost_inr).toBe(12.35);
    expect(one('45').ok).toBe(false);
    expect(one(undefined).ok).toBe(false);
    expect(one(Number.NaN).ok).toBe(false);
    expect(one(Infinity).ok).toBe(false);
  });

  it('variant_id must be a uuid (case-insensitive, normalised to lower case)', () => {
    expect(parseCostsPut({ costs: [{ variant_id: 'nope', cost_inr: 1 }] }).ok).toBe(false);
    expect(parseCostsPut({ costs: [{ variant_id: 5, cost_inr: 1 }] }).ok).toBe(false);
    expect(parseCostsPut({ costs: [{ cost_inr: 1 }] }).ok).toBe(false);
    expect(okValue(parseCostsPut({ costs: [{ variant_id: UUID_A.toUpperCase(), cost_inr: 1 }] })).costs[0].variant_id).toBe(UUID_A);
  });

  it('rejects a variant listed twice', () => {
    expect(errorOf(parseCostsPut({ costs: [{ variant_id: UUID_A, cost_inr: 1 }, { variant_id: UUID_A.toUpperCase(), cost_inr: 2 }] }))).toContain('more than once');
  });

  it('at most 500 rows', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ variant_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, cost_inr: 1 }));
    expect(parseCostsPut({ costs: rows(COSTS_PUT_MAX_ROWS) }).ok).toBe(true);
    expect(parseCostsPut({ costs: rows(COSTS_PUT_MAX_ROWS + 1) }).ok).toBe(false);
  });

  it('each row must be an object', () => {
    expect(parseCostsPut({ costs: [5] }).ok).toBe(false);
    expect(parseCostsPut({ costs: [null] }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parity with supabase/2026-10-marketing-agent.sql. The TypeScript bounds and
// defaults and the migration's CHECKs / seeds are two copies of one decision; if
// either is edited alone this fails rather than letting the owner save a value
// the database then rejects (or the code silently ignores).
// ---------------------------------------------------------------------------
describe('parity with the migration', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/2026-10-marketing-agent.sql'), 'utf8');

  function settingsColumn(name: string): string {
    const m = sql.match(new RegExp(`^\\s*${name}\\s+([^\\n]*)$`, 'm'));
    if (!m) throw new Error(`column ${name} not found in marketing_settings`);
    return m[1];
  }

  it.each(Object.keys(SETTINGS_BOUNDS) as IntSettingKey[])('%s: the CHECK bounds and default match SETTINGS_BOUNDS / DEFAULT_SETTINGS', (key) => {
    const line = settingsColumn(key);
    const check = line.match(new RegExp(`check \\(${key} between (\\d+) and (\\d+)\\)`));
    expect(check, `no "check (${key} between a and b)" on the ${key} column`).toBeTruthy();
    expect(Number(check![1])).toBe(SETTINGS_BOUNDS[key].min);
    expect(Number(check![2])).toBe(SETTINGS_BOUNDS[key].max);
    const def = line.match(/default (\d+)/);
    expect(def).toBeTruthy();
    expect(Number(def![1])).toBe(DEFAULT_SETTINGS[key]);
  });

  it('message_cost_inr: numeric(6,3), default 1.020, CHECK between 0 and 100', () => {
    const line = settingsColumn('message_cost_inr');
    expect(line).toContain('numeric(6,3)');
    expect(Number(line.match(/default ([\d.]+)/)![1])).toBe(DEFAULT_SETTINGS.message_cost_inr);
    const check = line.match(/check \(message_cost_inr between (\d+) and (\d+)\)/)!;
    expect([Number(check[1]), Number(check[2])]).toEqual([MESSAGE_COST_BOUNDS.min, MESSAGE_COST_BOUNDS.max]);
  });

  it('the kill switch defaults off and the window/other defaults are the ones in DEFAULT_SETTINGS', () => {
    expect(settingsColumn('enabled')).toContain('default false');
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
    expect(settingsColumn('whatsapp_business_number')).toContain("default ''");
  });

  it('the table-level rule that the window ends after it starts is in the migration', () => {
    expect(sql).toContain('check (send_window_end_hour > send_window_start_hour)');
  });

  it("seeds each playbook with exactly DEFAULT_PLAYBOOKS' priority, params, offer, template and prior", () => {
    const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
    for (const key of PLAYBOOK_KEYS as readonly PlaybookKey[]) {
      const d = DEFAULT_PLAYBOOKS[key];
      const row = `('${key}', 'off', ${d.priority},\n    ${lit(d.params)},\n    ${lit(d.offer)},\n    ${lit(d.template)},\n    ${d.prior_conversion_pct})`;
      expect(sql, `seed row for ${key} drifted from DEFAULT_PLAYBOOKS`).toContain(row);
    }
  });

  it('seeds nothing but the five playbooks, all off, on conflict do nothing', () => {
    const block = sql.slice(sql.indexOf('insert into public.marketing_playbooks'), sql.indexOf('-- SECTION 5'));
    expect((block.match(/^\s+\('/gm) ?? []).length).toBe(5);
    expect(block).toContain('on conflict (key) do nothing');
    expect(block).not.toMatch(/'(review|auto)'/);
  });

  it('every new table has RLS enabled and the API roles revoked', () => {
    const tables = [
      'menu_item_costs', 'marketing_settings', 'marketing_consent', 'marketing_consent_events',
      'marketing_playbooks', 'marketing_campaigns', 'marketing_recipients',
    ];
    for (const t of tables) {
      expect(sql).toMatch(new RegExp(`create table if not exists public\\.${t}\\b`));
      expect(sql).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
      expect(sql).toMatch(new RegExp(`revoke all on public\\.${t}\\s+from anon, authenticated`));
    }
    expect(sql).not.toMatch(/create policy/i);
  });

  it('the claim RPC is locked to service_role and never reclaims stale sending rows', () => {
    expect(sql).toContain('revoke all on function public.claim_marketing_recipients(int) from public, anon, authenticated');
    expect(sql).toContain('grant execute on function public.claim_marketing_recipients(int) to service_role');
    const fn = sql.slice(sql.indexOf('create or replace function public.claim_marketing_recipients'), sql.indexOf('revoke all on function'));
    expect(fn).toContain("r2.status = 'queued'");
    expect(fn).not.toMatch(/'sending'\s+and\s+.*claimed_at/); // no reclaim branch
    expect(fn).toContain('for update of r2 skip locked');
  });

  // The planner used to read the counters, add its campaign and write the sum back: two overlapping runs lost samples.
  it('marketing_add_observed increments in SQL, returns nothing, and is locked to service_role like the claim RPC', () => {
    expect(sql).toContain('create or replace function public.marketing_add_observed(p_key text, p_treated int, p_conversions int)');
    const start = sql.indexOf('create or replace function public.marketing_add_observed');
    const fn = sql.slice(start, sql.indexOf('revoke all on function public.marketing_add_observed', start));
    expect(fn).toContain('returns void');
    expect(fn).toContain('language sql security definer set search_path = public');
    expect(fn).toContain('update public.marketing_playbooks');
    expect(fn).toContain('observed_treated = observed_treated + p_treated');
    expect(fn).toContain('observed_conversions = observed_conversions + p_conversions');
    expect(fn).toContain('where key = p_key');
    // Not a read-modify-write: nothing is selected first.
    expect(fn).not.toMatch(/\bselect\b/i);
    expect(sql).toContain('revoke all on function public.marketing_add_observed(text, int, int) from public, anon, authenticated');
    expect(sql).toContain('grant execute on function public.marketing_add_observed(text, int, int) to service_role');
  });

  it("schedules the send poll under the documented job name and URL", () => {
    expect(sql).toContain("'marketing-send-poll'");
    expect(sql).toContain("'https://hioc.in/api/cron/marketing-send'");
    expect(sql).toContain("'*/5 * * * *'");
  });

  it('is written to be re-run: no bare create table / create index, no non-guarded seed', () => {
    expect(sql).not.toMatch(/create table (?!if not exists)/i);
    expect(sql).not.toMatch(/create (unique )?index (?!if not exists)/i);
    expect(sql).toMatch(/Idempotent: safe to re-run/);
    expect(sql).toMatch(/Apply BEFORE deploying the code/);
    expect(sql).toMatch(/^-- Verify$/m);
  });
});
