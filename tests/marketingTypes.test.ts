import { describe, expect, it } from 'vitest';
import { parseSettingsPatch } from '@/lib/marketing/parse';
import {
  CAMPAIGN_LIST_STATUSES,
  CAMPAIGN_STATUSES,
  CONSENT_SOURCES,
  DEFAULT_MARKETING_TAB,
  DEFAULT_PLAYBOOKS,
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATES,
  ELIGIBILITY_REASONS,
  GUARDRAIL_EXPLANATIONS,
  GUARDRAIL_FLAGS,
  IN_FLIGHT_STATUSES,
  LIFECYCLE_STAGES,
  LIFECYCLE_STAGE_LABELS,
  MARKETING_TABS,
  PLAYBOOK_DESCRIPTIONS,
  PLAYBOOK_KEYS,
  PLAYBOOK_LABELS,
  RECIPIENT_STATUSES,
  SENT_STATUSES,
  SKIP_REASON_LABELS,
  TEMPLATE_TOKENS,
  TEMPLATE_TOKEN_LABELS,
  TEMPLATE_TOKEN_SAMPLES,
  TERMINAL_CAMPAIGN_STATUSES,
  defaultPlaybook,
  isMarketingTab,
} from '@/lib/marketing/types';

// The constants S2 (engine/APIs) and S3 (dashboard) build against. These pin the
// invariants they will silently rely on.

describe('playbook constants', () => {
  it('PLAYBOOK_KEYS lists every playbook once, highest priority first', () => {
    expect(new Set(PLAYBOOK_KEYS).size).toBe(5);
    const priorities = PLAYBOOK_KEYS.map((k) => DEFAULT_PLAYBOOKS[k].priority);
    expect(priorities).toEqual([1, 2, 3, 4, 5]);
  });

  it('every key has an owner-facing label and description', () => {
    for (const k of PLAYBOOK_KEYS) {
      expect(PLAYBOOK_LABELS[k]).toBeTruthy();
      expect(PLAYBOOK_DESCRIPTIONS[k]).toBeTruthy();
    }
    expect(PLAYBOOK_LABELS.points_expiring).toBe('Points expiring');
    expect(PLAYBOOK_LABELS.winback_1).toBe('Win-back · stage 1 (we miss you)');
  });

  it('DEFAULT_PLAYBOOKS carry their own key, and the default mapping of spec §5', () => {
    for (const k of PLAYBOOK_KEYS) expect(DEFAULT_PLAYBOOKS[k].key).toBe(k);
    expect(DEFAULT_PLAYBOOKS.points_expiring.template.name).toBe('hioc_points_expiring_1');
    expect(DEFAULT_PLAYBOOKS.points_balance.template.name).toBe('hioc_points_balance_1');
    for (const k of ['winback_1', 'winback_2', 'winback_3'] as const) {
      expect(DEFAULT_PLAYBOOKS[k].template.name).toBe('hioc_winback_1');
    }
    expect(DEFAULT_TEMPLATES.manual.name).toBe('hioc_offer_1');
  });

  it('the defaults are the spec §1.4 table', () => {
    expect(DEFAULT_PLAYBOOKS.points_expiring.params).toEqual({ min_points: 20, days_ahead: 5, recent_order_days: 2, cooldown_days: 14 });
    expect(DEFAULT_PLAYBOOKS.points_balance.params).toEqual({ min_points: 50, min_days_since_order: 10, cooldown_days: 21 });
    expect(DEFAULT_PLAYBOOKS.winback_1.params).toEqual({ gap_multiplier: 2.5, min_days: 14, max_days: 45, default_days: 30 });
    expect(DEFAULT_PLAYBOOKS.winback_2.params).toEqual({ offset_days: 30 });
    expect(DEFAULT_PLAYBOOKS.winback_3.params).toEqual({ offset_days: 60, max_days: 180 });
    expect(DEFAULT_PLAYBOOKS.winback_1.offer).toMatchObject({ type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 });
    expect(DEFAULT_PLAYBOOKS.winback_2.offer).toMatchObject({ type: 'free_item', variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 });
    expect(DEFAULT_PLAYBOOKS.winback_3.offer).toMatchObject({ type: 'percent', percent: 20, cap_inr: 120, min_order_inr: 200, validity_days: 7 });
    expect(PLAYBOOK_KEYS.map((k) => DEFAULT_PLAYBOOKS[k].prior_conversion_pct)).toEqual([15, 5, 8, 12, 8]);
  });

  it('a playbook’s stored offer never carries the frozen free-item fields', () => {
    const o = DEFAULT_PLAYBOOKS.winback_2.offer;
    expect(o).not.toHaveProperty('cost_inr');
    expect(o).not.toHaveProperty('price_inr');
  });

  it('defaultPlaybook returns an independent deep copy', () => {
    const a = defaultPlaybook('winback_1');
    a.params.min_days = 99;
    a.template.vars.push('code');
    if (a.offer.type === 'percent') a.offer.percent = 50;
    const b = defaultPlaybook('winback_1');
    expect(b.params.min_days).toBe(14);
    expect(b.template.vars).toEqual(['first_name', 'offer_text', 'code', 'valid_till']);
    expect(DEFAULT_PLAYBOOKS.winback_1.params.min_days).toBe(14);
    expect(DEFAULT_PLAYBOOKS.winback_1.template.vars).toHaveLength(4);
  });

  it('the shared default win-back template is not aliased across the three stages', () => {
    expect(DEFAULT_PLAYBOOKS.winback_1.template.vars).not.toBe(DEFAULT_PLAYBOOKS.winback_2.template.vars);
    expect(DEFAULT_PLAYBOOKS.winback_1.template).not.toBe(DEFAULT_PLAYBOOKS.winback_3.template);
  });
});

describe('templates', () => {
  it('every default template uses only known tokens', () => {
    for (const t of Object.values(DEFAULT_TEMPLATES)) {
      for (const tok of t.vars) expect(TEMPLATE_TOKENS).toContain(tok);
    }
  });

  it('only the manual template uses the headline token', () => {
    expect(DEFAULT_TEMPLATES.manual.vars).toContain('headline');
    for (const k of PLAYBOOK_KEYS) expect(DEFAULT_PLAYBOOKS[k].template.vars).not.toContain('headline');
  });

  it('every token has a label and a sample', () => {
    for (const t of TEMPLATE_TOKENS) {
      expect(TEMPLATE_TOKEN_LABELS[t]).toBeTruthy();
      expect(TEMPLATE_TOKEN_SAMPLES[t]).toBeTruthy();
    }
  });
});

describe('settings', () => {
  it('DEFAULT_SETTINGS is itself a valid settings patch (every default is inside its bounds)', () => {
    const { updated_at: _u, ...editable } = DEFAULT_SETTINGS;
    void _u;
    const r = parseSettingsPatch(editable);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });

  it('sending starts OFF', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
  });
});

describe('label maps cover every enum member', () => {
  it('lifecycle stages', () => {
    for (const s of LIFECYCLE_STAGES) expect(LIFECYCLE_STAGE_LABELS[s]).toBeTruthy();
    expect(LIFECYCLE_STAGES).toHaveLength(8);
  });

  it('guardrail flags', () => {
    for (const f of GUARDRAIL_FLAGS) expect(GUARDRAIL_EXPLANATIONS[f]).toBeTruthy();
    expect(GUARDRAIL_FLAGS).toHaveLength(6);
  });

  it('skip reasons: the nine spec §1.5 rules, in order, plus the ones the sender adds', () => {
    expect([...ELIGIBILITY_REASONS]).toEqual([
      'not_opted_in', 'staff', 'invalid_phone', 'too_soon', 'monthly_cap', 'unread_pause', 'in_flight', 'in_holdout', 'claimed_by_higher_priority',
    ]);
    for (const r of ELIGIBILITY_REASONS) expect(SKIP_REASON_LABELS[r]).toBeTruthy();
    expect(SKIP_REASON_LABELS.opted_out).toBeTruthy();
    expect(SKIP_REASON_LABELS.not_configured).toBeTruthy();
  });
});

describe('statuses', () => {
  it('sent and in-flight statuses are disjoint subsets of RECIPIENT_STATUSES', () => {
    for (const s of [...SENT_STATUSES, ...IN_FLIGHT_STATUSES]) expect(RECIPIENT_STATUSES).toContain(s);
    expect(SENT_STATUSES.filter((s) => IN_FLIGHT_STATUSES.includes(s))).toEqual([]);
  });

  it('the three campaign list views partition the statuses', () => {
    const all = [...CAMPAIGN_LIST_STATUSES.pending_approval, ...CAMPAIGN_LIST_STATUSES.active, ...CAMPAIGN_LIST_STATUSES.history];
    expect([...all].sort()).toEqual([...CAMPAIGN_STATUSES].sort());
    expect(new Set(all).size).toBe(all.length);
    expect([...TERMINAL_CAMPAIGN_STATUSES].sort()).toEqual(['cancelled', 'completed', 'expired']);
  });
});

describe('consent sources', () => {
  it('are the spec §2 sources plus the two backfill ones, all distinct', () => {
    expect(new Set(CONSENT_SOURCES).size).toBe(CONSENT_SOURCES.length);
    for (const s of ['profile', 'whatsapp_keyword', 'stop_keyword', 'stop_promotions', 'meta_131050', 'meta_stop', 'meta_resume', 'owner', 'backfill_profile', 'backfill_opt_out']) {
      expect(CONSENT_SOURCES).toContain(s);
    }
  });
});

describe('dashboard tabs', () => {
  it('are the seven tabs of spec §7, in order, with unique ids', () => {
    expect(MARKETING_TABS.map((t) => t.id)).toEqual(['overview', 'approvals', 'playbooks', 'campaigns', 'audience', 'costs', 'settings']);
    expect(MARKETING_TABS.find((t) => t.id === 'costs')?.label).toBe('Product costs');
  });

  it('isMarketingTab narrows the ?tab= value', () => {
    expect(isMarketingTab('playbooks')).toBe(true);
    expect(isMarketingTab('nope')).toBe(false);
    expect(isMarketingTab(undefined)).toBe(false);
    expect(isMarketingTab(null)).toBe(false);
    expect(isMarketingTab(['costs'])).toBe(false);
    expect(isMarketingTab(DEFAULT_MARKETING_TAB)).toBe(true);
  });
});
