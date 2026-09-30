import { describe, expect, it } from 'vitest';
import {
  assignPlaybooks,
  evaluateContact,
  isMarketablePhone,
  qualifiesForPlaybook,
  receiptsConnected,
  type EligibilityContext,
  type PlanContact,
} from '@/lib/marketing/eligibility';
import { DEFAULT_PLAYBOOKS } from '@/lib/marketing/types';
import type {
  ContactStats,
  PlaybookKey,
  PlaybookMode,
  PlaybookRule,
  RecipientStatus,
  SendHistoryEntry,
} from '@/lib/marketing/types';

const NOW = new Date('2026-09-30T06:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

const ctx = (over: Partial<EligibilityContext> = {}): EligibilityContext => ({
  now: NOW,
  settings: { min_days_between: 7, max_per_30_days: 4, pause_after_unread: 3 },
  receipts_connected: true,
  ...over,
});

function contact(over: Partial<ContactStats> = {}): ContactStats {
  return {
    phone: '+919876543210',
    user_id: 'u1',
    first_name: 'Asha',
    role: 'customer',
    consent_opted_in: true,
    opt_out_listed: false,
    order_count: 6,
    total_spend_inr: 1800,
    aov_inr: 300,
    first_order_at: daysAgo(120),
    last_order_at: daysAgo(40),
    days_since_last_order: 40,
    typical_gap_days: 12,
    stage1_days: 30,
    stage: 'lapsed_1',
    points_balance: 0,
    points_value_inr: 0,
    expiring_points: 0,
    expiring_value_inr: 0,
    expiry_date: null,
    expiring_points_7d: 0,
    expiring_value_7d_inr: 0,
    vip: false,
    ...over,
  };
}

let seq = 0;
function entry(over: Partial<SendHistoryEntry> & { ago?: number } = {}): SendHistoryEntry {
  const { ago, ...rest } = over;
  const status: RecipientStatus = rest.status ?? 'delivered';
  const sentAt = ago !== undefined ? daysAgo(ago) : null;
  seq += 1;
  return {
    campaign_id: `c${seq}`,
    playbook_key: 'winback_1',
    arm: 'treatment',
    status,
    created_at: sentAt ?? daysAgo(0),
    sent_at: ['sent', 'delivered', 'read'].includes(status) ? sentAt : null,
    read_at: null,
    reference_at: sentAt,
    ...rest,
  };
}

const sentTo = (...ago: number[]) => ago.map((a) => entry({ ago: a, status: 'delivered' }));

describe('evaluateContact — rules 1–7 (spec §1.5)', () => {
  it('an opted-in customer with a clean history is eligible', () => {
    expect(evaluateContact(contact(), [], ctx())).toEqual({ eligible: true });
  });

  it('1 not_opted_in: no opted_in consent', () => {
    expect(evaluateContact(contact({ consent_opted_in: false }), [], ctx())).toEqual({ eligible: false, reason: 'not_opted_in' });
  });

  it('1 not_opted_in: a whatsapp_opt_outs row beats an opted_in consent', () => {
    expect(evaluateContact(contact({ opt_out_listed: true }), [], ctx())).toEqual({ eligible: false, reason: 'not_opted_in' });
  });

  it('2 staff: any role other than customer', () => {
    for (const role of ['staff', 'manager', 'owner']) {
      expect(evaluateContact(contact({ role }), [], ctx())).toEqual({ eligible: false, reason: 'staff' });
    }
  });

  it('2 staff: a phone with no profile (role null) is a plain customer', () => {
    expect(evaluateContact(contact({ role: null }), [], ctx())).toEqual({ eligible: true });
  });

  it('3 invalid_phone: not a valid Indian mobile', () => {
    for (const phone of ['', '9876543210', '+91987654321', '+9198765432100', '+915876543210', '+14155550100', '+91 9876543210']) {
      expect(evaluateContact(contact({ phone }), [], ctx())).toEqual({ eligible: false, reason: 'invalid_phone' });
    }
  });

  it('isMarketablePhone accepts +91 then 6–9 then nine digits only', () => {
    expect(isMarketablePhone('+919876543210')).toBe(true);
    expect(isMarketablePhone('+916000000000')).toBe(true);
    expect(isMarketablePhone('+915999999999')).toBe(false);
  });

  it('4 too_soon: any marketing message in the last min_days_between days', () => {
    expect(evaluateContact(contact(), sentTo(3), ctx())).toEqual({ eligible: false, reason: 'too_soon' });
  });

  it('4 too_soon: counts a message from ANY campaign or playbook, including manual', () => {
    const manual = entry({ ago: 2, playbook_key: null, status: 'sent' });
    expect(evaluateContact(contact(), [manual], ctx())).toEqual({ eligible: false, reason: 'too_soon' });
  });

  it('4 too_soon boundary: exactly min_days_between days ago no longer counts; just inside does', () => {
    expect(evaluateContact(contact(), sentTo(7), ctx())).toEqual({ eligible: true });
    const justInside = entry({ status: 'delivered' });
    justInside.sent_at = new Date(NOW.getTime() - 7 * DAY + 1000).toISOString();
    expect(evaluateContact(contact(), [justInside], ctx())).toEqual({ eligible: false, reason: 'too_soon' });
  });

  it('4 too_soon follows the configured window', () => {
    expect(evaluateContact(contact(), sentTo(3), ctx({ settings: { min_days_between: 2, max_per_30_days: 4, pause_after_unread: 3 } }))).toEqual({ eligible: true });
  });

  it('only messages that actually left count: failed, skipped, holdout and cancelled do not', () => {
    const hist = (['failed', 'skipped', 'holdout', 'cancelled'] as const).map((status) => entry({ ago: 1, status }));
    expect(evaluateContact(contact(), hist, ctx())).toEqual({ eligible: true });
  });

  it('5 monthly_cap: max_per_30_days or more in 30 days', () => {
    // 4 sent at 8, 12, 18, 25 days ago: each one clear of the 7-day rule.
    expect(evaluateContact(contact(), sentTo(8, 12, 18, 25), ctx())).toEqual({ eligible: false, reason: 'monthly_cap' });
    // 3 is under the cap of 4.
    expect(evaluateContact(contact(), sentTo(8, 12, 18), ctx({ receipts_connected: false }))).toEqual({ eligible: true });
  });

  it('5 monthly_cap: a message 30+ days ago is out of the window', () => {
    expect(evaluateContact(contact(), sentTo(8, 12, 18, 31), ctx({ receipts_connected: false }))).toEqual({ eligible: true });
  });

  it('5 monthly_cap follows the configured cap', () => {
    const settings = { min_days_between: 1, max_per_30_days: 2, pause_after_unread: 0 };
    expect(evaluateContact(contact(), sentTo(3, 10), ctx({ settings }))).toEqual({ eligible: false, reason: 'monthly_cap' });
    expect(evaluateContact(contact(), sentTo(3), ctx({ settings }))).toEqual({ eligible: true });
  });

  describe('6 unread_pause', () => {
    // Three messages, all sent/delivered and never read, oldest 26 days ago.
    const unread = () => sentTo(9, 17, 26);

    it('pauses after N unread in a row when receipts are flowing', () => {
      expect(evaluateContact(contact(), unread(), ctx())).toEqual({ eligible: false, reason: 'unread_pause' });
    });

    it('is DISABLED automatically when receipts are not flowing (every message would look unread)', () => {
      expect(evaluateContact(contact(), unread(), ctx({ receipts_connected: false }))).toEqual({ eligible: true });
    });

    it('one read message among the last N breaks the streak', () => {
      const hist = unread();
      hist[1] = { ...hist[1], status: 'read', read_at: daysAgo(17) };
      expect(evaluateContact(contact(), hist, ctx())).toEqual({ eligible: true });
    });

    it('a read_at with a stale status still counts as read', () => {
      const hist = unread();
      hist[0] = { ...hist[0], read_at: daysAgo(9) };
      expect(evaluateContact(contact(), hist, ctx())).toEqual({ eligible: true });
    });

    it('needs at least N messages of history', () => {
      expect(evaluateContact(contact(), sentTo(9, 17), ctx())).toEqual({ eligible: true });
    });

    it('only the LAST N matter: an older read message does not save you', () => {
      const hist = [...unread(), entry({ ago: 40, status: 'read', read_at: daysAgo(40) })];
      expect(evaluateContact(contact(), hist, ctx())).toEqual({ eligible: false, reason: 'unread_pause' });
    });

    it('lapses when the latest unread message is 60+ days old', () => {
      expect(evaluateContact(contact(), sentTo(60, 70, 80), ctx())).toEqual({ eligible: true });
      expect(evaluateContact(contact(), sentTo(59, 70, 80), ctx())).toEqual({ eligible: false, reason: 'unread_pause' });
    });

    it('pause_after_unread = 0 turns the rule off', () => {
      const settings = { min_days_between: 7, max_per_30_days: 4, pause_after_unread: 0 };
      expect(evaluateContact(contact(), unread(), ctx({ settings }))).toEqual({ eligible: true });
    });

    it('a smaller N pauses sooner', () => {
      const settings = { min_days_between: 7, max_per_30_days: 4, pause_after_unread: 1 };
      expect(evaluateContact(contact(), sentTo(9), ctx({ settings }))).toEqual({ eligible: false, reason: 'unread_pause' });
    });

    it('failed and cancelled sends are not "unread messages"', () => {
      const hist = [...sentTo(9, 17), entry({ ago: 10, status: 'failed' }), entry({ ago: 12, status: 'cancelled' })];
      expect(evaluateContact(contact(), hist, ctx())).toEqual({ eligible: true });
    });
  });

  it('7 in_flight: pending, queued or sending in another open campaign', () => {
    for (const status of ['pending', 'queued', 'sending'] as const) {
      expect(evaluateContact(contact(), [entry({ status })], ctx())).toEqual({ eligible: false, reason: 'in_flight' });
    }
  });

  it('7 in_flight: the recipient’s OWN campaign does not block itself', () => {
    const own = entry({ status: 'sending', campaign_id: 'mine' });
    expect(evaluateContact(contact(), [own], ctx({ ignore_campaign_id: 'mine' }))).toEqual({ eligible: true });
    expect(evaluateContact(contact(), [own], ctx({ ignore_campaign_id: 'other' }))).toEqual({ eligible: false, reason: 'in_flight' });
  });

  it('reports the FIRST failing rule, in spec order', () => {
    const c = contact({ consent_opted_in: false, role: 'staff', phone: 'bad' });
    expect(evaluateContact(c, sentTo(1), ctx())).toEqual({ eligible: false, reason: 'not_opted_in' });
    expect(evaluateContact({ ...c, consent_opted_in: true }, sentTo(1), ctx())).toEqual({ eligible: false, reason: 'staff' });
    expect(evaluateContact({ ...c, consent_opted_in: true, role: 'customer' }, sentTo(1), ctx())).toEqual({ eligible: false, reason: 'invalid_phone' });
    expect(evaluateContact(contact(), [...sentTo(1), entry({ status: 'queued' })], ctx())).toEqual({ eligible: false, reason: 'too_soon' });
  });

  describe("phase 'send' re-checks only rules 1, 3, 4, 5", () => {
    const send = { phase: 'send' as const };

    it('consent withdrawn between approval and send wins', () => {
      expect(evaluateContact(contact({ consent_opted_in: false }), [], ctx(), send)).toEqual({ eligible: false, reason: 'not_opted_in' });
      expect(evaluateContact(contact({ opt_out_listed: true }), [], ctx(), send)).toEqual({ eligible: false, reason: 'not_opted_in' });
    });

    it('still checks the number and the frequency caps', () => {
      expect(evaluateContact(contact({ phone: 'bad' }), [], ctx(), send)).toEqual({ eligible: false, reason: 'invalid_phone' });
      expect(evaluateContact(contact(), sentTo(2), ctx(), send)).toEqual({ eligible: false, reason: 'too_soon' });
      expect(evaluateContact(contact(), sentTo(8, 12, 18, 25), ctx(), send)).toEqual({ eligible: false, reason: 'monthly_cap' });
    });

    it('does not apply staff, unread_pause or in_flight (the recipient’s own row is in flight)', () => {
      expect(evaluateContact(contact({ role: 'staff' }), [], ctx(), send)).toEqual({ eligible: true });
      expect(evaluateContact(contact(), sentTo(9, 17, 26), ctx(), send)).toEqual({ eligible: true });
      expect(evaluateContact(contact(), [entry({ status: 'sending' })], ctx(), send)).toEqual({ eligible: true });
    });

    it('accepts a bare send-time contact (no stats needed)', () => {
      expect(
        evaluateContact({ phone: '+919876543210', role: null, consent_opted_in: true, opt_out_listed: false }, [], ctx(), send),
      ).toEqual({ eligible: true });
    });
  });
});

describe('receiptsConnected', () => {
  it('is true once any recipient reached delivered or read', () => {
    expect(receiptsConnected([])).toBe(false);
    expect(receiptsConnected([{ status: 'sent', read_at: null }, { status: 'failed', read_at: null }])).toBe(false);
    expect(receiptsConnected([{ status: 'sent', read_at: null }, { status: 'delivered', read_at: null }])).toBe(true);
    expect(receiptsConnected([{ status: 'read', read_at: daysAgo(1) }])).toBe(true);
    expect(receiptsConnected([{ status: 'sent', read_at: daysAgo(1) }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Playbook qualification and assignment (spec §1.4)
// ---------------------------------------------------------------------------

function rule<K extends PlaybookKey>(key: K, mode: PlaybookMode = 'review', params?: Partial<PlaybookRule['params']>): PlaybookRule {
  const d = DEFAULT_PLAYBOOKS[key];
  return { key, mode, priority: d.priority, params: { ...d.params, ...params } } as PlaybookRule;
}

const ALL_RULES = (mode: PlaybookMode = 'review'): PlaybookRule[] =>
  (['points_expiring', 'points_balance', 'winback_1', 'winback_2', 'winback_3'] as const).map((k) => rule(k, mode));

describe('qualifiesForPlaybook — points_expiring', () => {
  const c = (over: Partial<ContactStats> = {}) => contact({ stage: 'active', expiring_points: 30, days_since_last_order: 10, last_order_at: daysAgo(10), ...over });
  const r = rule('points_expiring');

  it('qualifies with enough expiring points', () => {
    expect(qualifiesForPlaybook(c(), [], r, NOW)).toBe(true);
    expect(qualifiesForPlaybook(c({ expiring_points: 20 }), [], r, NOW)).toBe(true); // = min_points
    expect(qualifiesForPlaybook(c({ expiring_points: 19 }), [], r, NOW)).toBe(false);
  });

  it('skips a customer who ordered in the last recent_order_days (they are already engaged)', () => {
    expect(qualifiesForPlaybook(c({ days_since_last_order: 1 }), [], r, NOW)).toBe(false);
    expect(qualifiesForPlaybook(c({ days_since_last_order: 2 }), [], r, NOW)).toBe(true);
    expect(qualifiesForPlaybook(c({ days_since_last_order: 0 }), [], rule('points_expiring', 'review', { recent_order_days: 0 }), NOW)).toBe(true);
  });

  it('respects the cooldown: no points_expiring message within cooldown_days', () => {
    expect(qualifiesForPlaybook(c(), [entry({ ago: 10, playbook_key: 'points_expiring' })], r, NOW)).toBe(false);
    expect(qualifiesForPlaybook(c(), [entry({ ago: 14, playbook_key: 'points_expiring' })], r, NOW)).toBe(true); // exactly at the line
    expect(qualifiesForPlaybook(c(), [entry({ ago: 20, playbook_key: 'points_expiring' })], r, NOW)).toBe(true);
  });

  it('the cooldown is per playbook: a win-back message does not start it', () => {
    expect(qualifiesForPlaybook(c(), [entry({ ago: 3, playbook_key: 'winback_1' })], r, NOW)).toBe(true);
  });

  it('a holdout pick counts against the cooldown (they must stay a holdout)', () => {
    const held = entry({ status: 'holdout', playbook_key: 'points_expiring', reference_at: daysAgo(5), created_at: daysAgo(5) });
    expect(qualifiesForPlaybook(c(), [held], r, NOW)).toBe(false);
  });

  it('a failed or skipped attempt does not start the cooldown', () => {
    expect(qualifiesForPlaybook(c(), [entry({ ago: 1, status: 'failed', playbook_key: 'points_expiring' })], r, NOW)).toBe(true);
    expect(qualifiesForPlaybook(c(), [entry({ ago: 1, status: 'skipped', playbook_key: 'points_expiring' })], r, NOW)).toBe(true);
  });
});

describe('qualifiesForPlaybook — points_balance', () => {
  const c = (over: Partial<ContactStats> = {}) => contact({ stage: 'active', points_balance: 60, days_since_last_order: 15, last_order_at: daysAgo(15), ...over });
  const r = rule('points_balance');

  it('needs the balance and enough time away', () => {
    expect(qualifiesForPlaybook(c(), [], r, NOW)).toBe(true);
    expect(qualifiesForPlaybook(c({ points_balance: 50 }), [], r, NOW)).toBe(true);
    expect(qualifiesForPlaybook(c({ points_balance: 49 }), [], r, NOW)).toBe(false);
    expect(qualifiesForPlaybook(c({ days_since_last_order: 10 }), [], r, NOW)).toBe(true);
    expect(qualifiesForPlaybook(c({ days_since_last_order: 9 }), [], r, NOW)).toBe(false);
  });

  it('respects a 21-day cooldown', () => {
    expect(qualifiesForPlaybook(c(), [entry({ ago: 20, playbook_key: 'points_balance' })], r, NOW)).toBe(false);
    expect(qualifiesForPlaybook(c(), [entry({ ago: 21, playbook_key: 'points_balance' })], r, NOW)).toBe(true);
  });
});

describe('qualifiesForPlaybook — win-back stages: one message per lapse episode', () => {
  it('each stage matches only its own lifecycle stage', () => {
    for (const [key, stage] of [['winback_1', 'lapsed_1'], ['winback_2', 'lapsed_2'], ['winback_3', 'lapsed_3']] as const) {
      expect(qualifiesForPlaybook(contact({ stage }), [], rule(key), NOW)).toBe(true);
      for (const other of ['active', 'at_risk', 'lapsed_1', 'lapsed_2', 'lapsed_3'] as const) {
        if (other !== stage) expect(qualifiesForPlaybook(contact({ stage: other }), [], rule(key), NOW)).toBe(false);
      }
    }
  });

  it('a stage-1 message sent AFTER the last order blocks a repeat', () => {
    const last = daysAgo(40);
    expect(qualifiesForPlaybook(contact({ last_order_at: last }), [entry({ ago: 5, playbook_key: 'winback_1' })], rule('winback_1'), NOW)).toBe(false);
  });

  it('a message sent BEFORE the last order is an earlier episode and does not block', () => {
    const c = contact({ last_order_at: daysAgo(40), days_since_last_order: 40 });
    expect(qualifiesForPlaybook(c, [entry({ ago: 90, playbook_key: 'winback_1' })], rule('winback_1'), NOW)).toBe(true);
  });

  it('once the customer orders again the stage resets: a later lapse can be messaged again', () => {
    // Messaged 100 days ago, came back 60 days ago, lapsed again now.
    const c = contact({ last_order_at: daysAgo(60), days_since_last_order: 60 });
    expect(qualifiesForPlaybook(c, [entry({ ago: 100, playbook_key: 'winback_1' })], rule('winback_1'), NOW)).toBe(true);
  });

  it('the block is per stage: stage 1 sent does not block stage 2', () => {
    const c = contact({ stage: 'lapsed_2', last_order_at: daysAgo(70), days_since_last_order: 70 });
    expect(qualifiesForPlaybook(c, [entry({ ago: 35, playbook_key: 'winback_1' })], rule('winback_2'), NOW)).toBe(true);
    expect(qualifiesForPlaybook(c, [entry({ ago: 5, playbook_key: 'winback_2' })], rule('winback_2'), NOW)).toBe(false);
  });

  it('a holdout pick counts as handled for the episode', () => {
    const held = entry({ status: 'holdout', playbook_key: 'winback_1', reference_at: daysAgo(3), created_at: daysAgo(3) });
    expect(qualifiesForPlaybook(contact(), [held], rule('winback_1'), NOW)).toBe(false);
  });

  it('a failed or cancelled attempt does not use up the episode', () => {
    expect(qualifiesForPlaybook(contact(), [entry({ ago: 2, status: 'failed', playbook_key: 'winback_1' })], rule('winback_1'), NOW)).toBe(true);
    expect(qualifiesForPlaybook(contact(), [entry({ ago: 2, status: 'cancelled', playbook_key: 'winback_1' })], rule('winback_1'), NOW)).toBe(true);
  });

  it('a manual campaign message does not use up a win-back episode', () => {
    expect(qualifiesForPlaybook(contact(), [entry({ ago: 2, playbook_key: null })], rule('winback_1'), NOW)).toBe(true);
  });

  it('needs a last order to measure "since"', () => {
    expect(qualifiesForPlaybook(contact({ last_order_at: null }), [], rule('winback_1'), NOW)).toBe(false);
  });
});

describe('the agent never messages lost customers or contacts with no orders', () => {
  it.each(['lost', 'no_orders'] as const)('%s qualifies for no playbook', (stage) => {
    const c = contact({ stage, points_balance: 500, expiring_points: 500, days_since_last_order: 300 });
    for (const r of ALL_RULES()) expect(qualifiesForPlaybook(c, [], r, NOW)).toBe(false);
  });
});

describe('assignPlaybooks', () => {
  const pc = (stats: ContactStats, history: SendHistoryEntry[] = []): PlanContact => ({ stats, history });

  it('assigns a contact to the playbook they qualify for', () => {
    const c = contact();
    const r = assignPlaybooks([pc(c)], ALL_RULES(), ctx());
    expect(r.assigned.winback_1).toEqual([c]);
    expect(r.assigned.winback_2).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('every playbook key is present in the result, even with no contacts', () => {
    const r = assignPlaybooks([], ALL_RULES(), ctx());
    expect(Object.keys(r.assigned).sort()).toEqual(['points_balance', 'points_expiring', 'winback_1', 'winback_2', 'winback_3']);
    expect(Object.values(r.assigned).every((a) => a.length === 0)).toBe(true);
  });

  it('a contact qualifying for several playbooks goes to the highest priority (lowest number) and the rest are claimed', () => {
    // Expiring points (pri 1) AND a points balance (pri 5), while active.
    const c = contact({ stage: 'active', expiring_points: 40, points_balance: 80, days_since_last_order: 15, last_order_at: daysAgo(15) });
    const r = assignPlaybooks([pc(c)], ALL_RULES(), ctx());
    expect(r.assigned.points_expiring).toEqual([c]);
    expect(r.assigned.points_balance).toEqual([]);
    expect(r.skipped).toEqual([{ phone: c.phone, playbook_key: 'points_balance', reason: 'claimed_by_higher_priority' }]);
  });

  it('priority follows the numbers, not the order the rules are listed in', () => {
    const c = contact({ stage: 'active', expiring_points: 40, points_balance: 80, days_since_last_order: 15, last_order_at: daysAgo(15) });
    const reversed = [...ALL_RULES()].reverse();
    expect(assignPlaybooks([pc(c)], reversed, ctx()).assigned.points_expiring).toEqual([c]);
    // Give points_balance the better priority and it wins instead.
    const custom = ALL_RULES().map((r) => (r.key === 'points_balance' ? { ...r, priority: 0 } : r)) as PlaybookRule[];
    const res = assignPlaybooks([pc(c)], custom, ctx());
    expect(res.assigned.points_balance).toEqual([c]);
    expect(res.assigned.points_expiring).toEqual([]);
  });

  it('win-back stage 3 (priority 2) beats points_balance (priority 5)', () => {
    const c = contact({ stage: 'lapsed_3', points_balance: 90, days_since_last_order: 100, last_order_at: daysAgo(100) });
    const r = assignPlaybooks([pc(c)], ALL_RULES(), ctx());
    expect(r.assigned.winback_3).toEqual([c]);
    expect(r.assigned.points_balance).toEqual([]);
    expect(r.skipped).toEqual([{ phone: c.phone, playbook_key: 'points_balance', reason: 'claimed_by_higher_priority' }]);
  });

  it('one message per contact per day: a contact appears in at most one playbook', () => {
    const c = contact({ stage: 'lapsed_1', expiring_points: 60, points_balance: 90 });
    const r = assignPlaybooks([pc(c)], ALL_RULES(), ctx());
    const total = Object.values(r.assigned).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(1);
    expect(r.assigned.points_expiring).toEqual([c]);
  });

  it('deduplicates ACROSS contacts independently and keeps input order within a playbook', () => {
    const a = contact({ phone: '+919876543211' });
    const b = contact({ phone: '+919876543212' });
    const c = contact({ phone: '+919876543213', stage: 'lapsed_2' });
    const r = assignPlaybooks([pc(a), pc(c), pc(b)], ALL_RULES(), ctx());
    expect(r.assigned.winback_1.map((x) => x.phone)).toEqual([a.phone, b.phone]);
    expect(r.assigned.winback_2.map((x) => x.phone)).toEqual([c.phone]);
  });

  it('playbooks in mode off take no part — a disabled high-priority playbook does not shadow an enabled one', () => {
    const c = contact({ stage: 'active', expiring_points: 40, points_balance: 80, days_since_last_order: 15, last_order_at: daysAgo(15) });
    const rules = ALL_RULES().map((r) => (r.key === 'points_expiring' ? { ...r, mode: 'off' as const } : r)) as PlaybookRule[];
    const res = assignPlaybooks([pc(c)], rules, ctx());
    expect(res.assigned.points_expiring).toEqual([]);
    expect(res.assigned.points_balance).toEqual([c]);
    expect(res.skipped).toEqual([]);
  });

  it('with every playbook off nothing is assigned and nothing is skipped', () => {
    const r = assignPlaybooks([pc(contact())], ALL_RULES('off'), ctx());
    expect(Object.values(r.assigned).flat()).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('review and auto both participate', () => {
    expect(assignPlaybooks([pc(contact())], [rule('winback_1', 'auto')], ctx()).assigned.winback_1).toHaveLength(1);
    expect(assignPlaybooks([pc(contact())], [rule('winback_1', 'review')], ctx()).assigned.winback_1).toHaveLength(1);
  });

  it('an ineligible contact is skipped with the rule, against every playbook they would have joined', () => {
    const c = contact({ stage: 'lapsed_1', expiring_points: 60 });
    const manualLastWeek = [entry({ ago: 2, playbook_key: null })]; // a manual push 2 days ago
    const r = assignPlaybooks([pc(c, manualLastWeek)], ALL_RULES(), ctx());
    expect(Object.values(r.assigned).flat()).toEqual([]);
    expect(r.skipped).toEqual([
      { phone: c.phone, playbook_key: 'points_expiring', reason: 'too_soon' },
      { phone: c.phone, playbook_key: 'winback_1', reason: 'too_soon' },
    ]);
  });

  it('a contact that qualifies for nothing leaves no trace (no skip record)', () => {
    const r = assignPlaybooks([pc(contact({ stage: 'active' }), [entry({ ago: 2, playbook_key: null })])], ALL_RULES(), ctx());
    expect(r.skipped).toEqual([]);
  });

  it('applies each eligibility rule (not opted in, staff, in flight)', () => {
    const notIn = contact({ phone: '+919876543211', consent_opted_in: false });
    const staff = contact({ phone: '+919876543212', role: 'staff' });
    const busy = contact({ phone: '+919876543213' });
    const r = assignPlaybooks(
      [pc(notIn), pc(staff), pc(busy, [entry({ status: 'queued', playbook_key: 'points_balance' })])],
      [rule('winback_1')],
      ctx(),
    );
    expect(r.assigned.winback_1).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['not_opted_in', 'staff', 'in_flight']);
  });

  it('win-back one-per-episode carries through assignment: already messaged this lapse → not assigned, and no skip noise', () => {
    const c = contact();
    const r = assignPlaybooks([pc(c, [entry({ ago: 10, playbook_key: 'winback_1' })])], ALL_RULES(), ctx({ receipts_connected: false, settings: { min_days_between: 7, max_per_30_days: 4, pause_after_unread: 3 } }));
    expect(r.assigned.winback_1).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('a message sent before the last order does not block win-back (and the 7-day rule is clear)', () => {
    const c = contact({ last_order_at: daysAgo(40), days_since_last_order: 40 });
    const r = assignPlaybooks([pc(c, [entry({ ago: 90, playbook_key: 'winback_1' })])], ALL_RULES(), ctx());
    expect(r.assigned.winback_1).toEqual([c]);
  });

  it('never assigns lost or no-order contacts', () => {
    const lost = contact({ phone: '+919876543211', stage: 'lost', points_balance: 300 });
    const none = contact({ phone: '+919876543212', stage: 'no_orders', order_count: 0, days_since_last_order: null, last_order_at: null });
    const r = assignPlaybooks([pc(lost), pc(none)], ALL_RULES(), ctx());
    expect(Object.values(r.assigned).flat()).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const rules = ALL_RULES();
    const order = rules.map((r) => r.key);
    assignPlaybooks([pc(contact())], rules, ctx());
    expect(rules.map((r) => r.key)).toEqual(order);
  });

  it('takes `now` as a parameter: the same contact qualifies or not depending on it', () => {
    const h = [entry({ ago: 10, playbook_key: 'points_expiring', status: 'delivered' })];
    const pts = contact({ stage: 'active', expiring_points: 40, days_since_last_order: 10, last_order_at: daysAgo(10) });
    // 10 days after the message: still inside the 14-day cooldown at NOW…
    expect(assignPlaybooks([pc(pts, h)], [rule('points_expiring')], ctx({ receipts_connected: false })).assigned.points_expiring).toEqual([]);
    // …but 5 days later it is not.
    const later = new Date(NOW.getTime() + 5 * DAY);
    expect(assignPlaybooks([pc(pts, h)], [rule('points_expiring')], ctx({ now: later, receipts_connected: false })).assigned.points_expiring).toEqual([pts]);
  });
});
