import { describe, expect, it } from 'vitest';
import { switchOfferType } from '@/components/owner/marketing/drafts';
import {
  audienceToInput,
  describeAudience,
  emptyWizard,
  firstInvalidStep,
  istLocalToIso,
  nowAsIstLocal,
  offerTemplateMismatch,
  toManualInput,
  validateStep,
  wizardWarnings,
  type WizardState,
} from '@/components/owner/marketing/wizard';
import { CAMPAIGN_NAME_MAX, DEFAULT_TEMPLATES, HEADLINE_MAX } from '@/lib/marketing/types';

const NOW = Date.UTC(2026, 9, 1, 6, 0, 0); // 1 Oct 2026, 11:30 IST

function ready(over: Partial<WizardState> = {}): WizardState {
  return { ...emptyWizard(), name: 'Monsoon latte push', headline: 'New hazelnut latte', ...over };
}

describe('a fresh wizard', () => {
  it('starts on the manual template and a 10% offer, so the code and offer have somewhere to come from', () => {
    const w = emptyWizard();
    expect(w.template.name).toBe(DEFAULT_TEMPLATES.manual.name);
    expect(w.template.vars).toEqual([...DEFAULT_TEMPLATES.manual.vars]);
    expect(w.offer.type).toBe('percent');
    expect(w.offer.percent).toBe('10');
    expect(w.send).toBe('now');
    // the template must be a copy: editing the wizard can't change the shared default
    w.template.vars.push('points');
    expect(DEFAULT_TEMPLATES.manual.vars).toHaveLength(5);
  });
});

describe('step 1 · name', () => {
  it('needs a name within 80 characters and a headline within 60', () => {
    expect(validateStep(1, emptyWizard())).toMatch(/name/i);
    expect(validateStep(1, ready())).toBeNull();
    expect(validateStep(1, ready({ name: 'x'.repeat(CAMPAIGN_NAME_MAX) }))).toBeNull();
    expect(validateStep(1, ready({ name: 'x'.repeat(CAMPAIGN_NAME_MAX + 1) }))).toContain('80');
    expect(validateStep(1, ready({ headline: 'h'.repeat(HEADLINE_MAX + 1) }))).toContain('60');
    expect(validateStep(1, ready({ name: '   ' }))).toMatch(/name/i);
  });
});

describe('step 2 · audience (the shared parser decides)', () => {
  it('accepts everyone (no rules) and leaves blanks out of the request', () => {
    const w = ready();
    expect(validateStep(2, w)).toBeNull();
    expect(audienceToInput(w.audience)).toEqual({});
  });

  it('builds the filter from ticks and numbers', () => {
    const w = ready();
    w.audience = { ...w.audience, stages: ['lapsed_1', 'lapsed_2'], vip_only: true, min_orders: '3', last_order_from_days: '30', last_order_to_days: '60' };
    expect(audienceToInput(w.audience)).toEqual({
      stages: ['lapsed_1', 'lapsed_2'],
      vip_only: true,
      min_orders: 3,
      last_order_from_days: 30,
      last_order_to_days: 60,
    });
    expect(validateStep(2, w)).toBeNull();
  });

  it('names the box that is wrong', () => {
    const w = ready();
    w.audience = { ...w.audience, min_orders: 'abc' };
    expect(validateStep(2, w)).toContain('Minimum orders');
    w.audience = { ...w.audience, min_orders: '', last_order_from_days: '30', last_order_to_days: '10' };
    expect(validateStep(2, w)).toContain('cannot be later');
  });
});

describe('step 3 · offer', () => {
  it('validates with the offer parser', () => {
    expect(validateStep(3, ready())).toBeNull();
    expect(validateStep(3, ready({ offer: { ...emptyWizard().offer, percent: '0' } }))).toContain('Discount %');
    expect(validateStep(3, ready({ offer: { ...emptyWizard().offer, validity_days: '' } }))).toContain('validity');
    expect(validateStep(3, ready({ offer: switchOfferType('none') }))).toBeNull();
    expect(validateStep(3, ready({ offer: switchOfferType('free_item') }))).toBeNull(); // Auto (best value)
  });
});

describe('step 4 · message', () => {
  it('asks for the template name in words, not a regex', () => {
    const w = ready();
    w.template = { ...w.template, name: '  ' };
    expect(validateStep(4, w)).toContain('exactly as it appears in WhatsApp Manager');
    w.template = { ...w.template, name: 'Has Spaces' };
    expect(validateStep(4, w)).toContain('lowercase');
  });

  it('needs a headline when the template uses one', () => {
    expect(validateStep(4, ready({ headline: '' }))).toContain('headline');
    expect(validateStep(4, ready())).toBeNull();
  });

  it('refuses to send "-" where the offer and code should be', () => {
    const w = ready({ offer: switchOfferType('none') });
    const msg = offerTemplateMismatch(w);
    expect(msg).toContain('no offer');
    expect(validateStep(4, w)).toBe(msg);
    // a template that shows no offer variables is fine without an offer
    w.template = { ...w.template, vars: ['first_name', 'headline'], body_preview: 'Hi {{1}}, {{2}} at HIOC! See you soon.' };
    expect(offerTemplateMismatch(w)).toBeNull();
    expect(validateStep(4, w)).toBeNull();
  });
});

describe('step 5 · when', () => {
  it('sends as soon as approved by default', () => {
    expect(validateStep(5, ready(), NOW)).toBeNull();
  });

  it('needs a real future time when scheduled', () => {
    expect(validateStep(5, ready({ send: 'later', send_after_local: '' }), NOW)).toContain('date and time');
    expect(validateStep(5, ready({ send: 'later', send_after_local: 'tomorrow' }), NOW)).toContain('date and time');
    expect(validateStep(5, ready({ send: 'later', send_after_local: '2026-10-01T10:00' }), NOW)).toContain('future');
    expect(validateStep(5, ready({ send: 'later', send_after_local: '2026-10-02T11:00' }), NOW)).toBeNull();
  });

  it('reads the date box as India time', () => {
    expect(istLocalToIso('2026-10-02T11:00')).toBe('2026-10-02T05:30:00.000Z');
    expect(istLocalToIso('2026-10-02T11:00:30')).toBe('2026-10-02T05:30:30.000Z');
    expect(istLocalToIso('')).toBeNull();
    expect(istLocalToIso('2026-13-40T99:00')).toBeNull();
    // the minimum the box allows is "now" on the IST clock
    expect(nowAsIstLocal(Date.UTC(2026, 8, 30, 20, 0))).toBe('2026-10-01T01:30');
  });
});

describe('the finished request', () => {
  it('builds the exact ManualCampaignInput the API takes', () => {
    const r = toManualInput(ready({ name: '  Monsoon latte push  ' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe('Monsoon latte push');
    expect(r.value.headline).toBe('New hazelnut latte');
    expect(r.value.audience).toEqual({});
    expect(r.value.offer).toEqual({ type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 });
    expect(r.value.template.name).toBe('hioc_offer_1');
    expect(r.value.send_after).toBeNull();
  });

  it('carries a scheduled time as an ISO instant', () => {
    const r = toManualInput(ready({ send: 'later', send_after_local: '2026-10-02T11:00' }));
    expect(r.ok && r.value.send_after).toBe('2026-10-02T05:30:00.000Z');
    const bad = toManualInput(ready({ send: 'later', send_after_local: '' }));
    expect(bad.ok).toBe(false);
  });

  it('is strict for Create draft but lets the live forecast price an unfinished campaign', () => {
    const unfinished = emptyWizard(); // no name, no headline
    expect(toManualInput(unfinished).ok).toBe(false);
    expect(toManualInput(unfinished, { preview: true }).ok).toBe(true);
    const noTemplate = ready();
    noTemplate.template = { ...noTemplate.template, name: '' };
    expect(toManualInput(noTemplate).ok).toBe(false);
    expect(toManualInput(noTemplate, { preview: true }).ok).toBe(true);
  });

  it('points at the first step that blocks creating the draft', () => {
    expect(firstInvalidStep(emptyWizard(), NOW)?.step).toBe(1);
    expect(firstInvalidStep(ready(), NOW)).toBeNull();
    const badAudience = ready();
    badAudience.audience = { ...badAudience.audience, min_points: 'x' };
    expect(firstInvalidStep(badAudience, NOW)?.step).toBe(2);
    expect(firstInvalidStep(ready({ headline: '' }), NOW)?.step).toBe(4);
    expect(firstInvalidStep(ready({ send: 'later', send_after_local: '' }), NOW)?.step).toBe(5);
  });
});

describe('review wording', () => {
  it('warns when an offer would reach customers without its code or text', () => {
    expect(wizardWarnings(ready())).toEqual([]);
    const w = ready();
    w.template = { ...w.template, vars: ['first_name', 'headline'] };
    expect(wizardWarnings(w)).toHaveLength(2);
    expect(wizardWarnings(ready({ offer: switchOfferType('none') }))).toEqual([]);
  });

  it('describes the audience in plain words', () => {
    expect(describeAudience({})).toBe('Everyone who opted in');
    const text = describeAudience({ stages: ['lapsed_1'], vip_only: true, min_orders: 3, last_order_from_days: 30, last_order_to_days: 60 });
    expect(text).toContain('Lapsed · stage 1');
    expect(text).toContain('VIPs only');
    expect(text).toContain('3+ orders');
    expect(text).toContain('last order 30–60 days ago');
    expect(describeAudience({ last_order_from_days: 45 })).toContain('45+ days ago');
    expect(describeAudience({ min_spend_inr: 5000 })).toContain('₹5,000+');
  });
});
