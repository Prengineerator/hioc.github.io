import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AWAITING_APPROVAL_STATUSES,
  CAMPAIGN_STATE_MEANING,
  CAMPAIGN_TRANSITIONS,
  CANCELLABLE_CAMPAIGN_STATUSES,
  CANCELLABLE_RECIPIENT_STATUSES,
  COMMITTED_RECIPIENT_STATUSES,
  IN_FLIGHT_CAMPAIGN_STATUSES,
  IN_FLIGHT_RECIPIENT_STATUSES,
  LIVE_CAMPAIGN_STATUSES,
  RECIPIENT_STATE_MEANING,
  RECIPIENT_TRANSITIONS,
  TERMINAL_CAMPAIGN_STATUSES,
  TERMINAL_RECIPIENT_STATUSES,
  campaignFrom,
  canApproveCampaign,
  canCancelCampaign,
  canTransitionCampaign,
  canTransitionRecipient,
  holdsRecipientsInFlight,
  isLiveCampaign,
  isTerminalCampaign,
  recipientFrom,
} from '@/lib/marketing/lifecycle';
import * as T from '@/lib/marketing/types';
import type { CampaignStatus, RecipientStatus } from '@/lib/marketing/types';

// The marketing campaign and recipient state machines (lib/marketing/lifecycle.ts): the
// transition matrices, the groupings every writer and UI now derives from them, and that the
// database's own CHECK constraints and claim function agree with them.

const C = T.CAMPAIGN_STATUSES;
const R = T.RECIPIENT_STATUSES;
const SQL = fs.readFileSync(path.resolve(__dirname, '..', 'supabase/2026-10-marketing-agent.sql'), 'utf8');

describe('campaign transitions', () => {
  // from → the statuses it may become (any actor, no guard facts).
  const LEGAL: Record<CampaignStatus, CampaignStatus[]> = {
    draft: ['approved', 'cancelled', 'expired'],
    pending_approval: ['approved', 'cancelled', 'expired'],
    approved: ['draft', 'pending_approval', 'cancelled', 'sending', 'completed'],
    sending: ['cancelled', 'completed'],
    completed: [],
    cancelled: [],
    expired: [],
  };

  it.each(C.flatMap((from) => C.map((to) => [from, to] as const)))('%s → %s matches the table', (from, to) => {
    expect(canTransitionCampaign(from, to).ok).toBe(LEGAL[from].includes(to));
  });

  it('a campaign is created as a draft (owner) or pending_approval (planner) only', () => {
    expect(C.filter((to) => canTransitionCampaign(null, to).ok).sort()).toEqual(['draft', 'pending_approval']);
    expect(canTransitionCampaign(null, 'draft', { actor: 'owner' }).ok).toBe(true);
    expect(canTransitionCampaign(null, 'pending_approval', { actor: 'planner' }).ok).toBe(true);
    // An Auto campaign is never inserted approved: it is flipped after its recipients exist.
    expect(canTransitionCampaign(null, 'approved').ok).toBe(false);
  });

  it('names the actor that may make each move', () => {
    expect(canTransitionCampaign('pending_approval', 'approved', { actor: 'owner' }).ok).toBe(true);
    expect(canTransitionCampaign('pending_approval', 'approved', { actor: 'planner' }).ok).toBe(true); // Auto
    expect(canTransitionCampaign('draft', 'approved', { actor: 'planner' })).toMatchObject({ ok: false, code: 'forbidden_actor' });
    expect(canTransitionCampaign('approved', 'pending_approval', { actor: 'owner' })).toMatchObject({ ok: false, code: 'forbidden_actor' });
    expect(canTransitionCampaign('approved', 'sending', { actor: 'owner' })).toMatchObject({ ok: false, code: 'forbidden_actor' });
    expect(canTransitionCampaign('approved', 'cancelled', { actor: 'owner' }).ok).toBe(true);
    expect(canTransitionCampaign('sending', 'cancelled', { actor: 'system' }).ok).toBe(true);
    expect(canTransitionCampaign('completed', 'cancelled', { actor: 'system' })).toMatchObject({ ok: false, code: 'not_allowed' });
  });

  it('completes only with nothing left in flight', () => {
    for (const from of ['approved', 'sending'] as const) {
      expect(canTransitionCampaign(from, 'completed', { actor: 'sender', inFlight: 0 }).ok).toBe(true);
      expect(canTransitionCampaign(from, 'completed', { actor: 'sender', inFlight: 1 })).toMatchObject({ ok: false, code: 'recipients_in_flight' });
    }
  });

  it('every action names a from-list (the guarded UPDATE’s .in(status, …))', () => {
    expect(campaignFrom('approve').sort()).toEqual(['draft', 'pending_approval']);
    expect(campaignFrom('auto_approve')).toEqual(['pending_approval']);
    expect(campaignFrom('unapprove')).toEqual(['approved']);
    expect(campaignFrom('cancel').sort()).toEqual(['approved', 'draft', 'pending_approval', 'sending']);
    expect(campaignFrom('expire').sort()).toEqual(['draft', 'pending_approval']);
    expect(campaignFrom('start')).toEqual(['approved']);
    expect(campaignFrom('complete').sort()).toEqual(['approved', 'sending']);
    expect(campaignFrom('create')).toEqual([]);
  });

  it('describes every status, and every rule names known statuses', () => {
    expect(Object.keys(CAMPAIGN_STATE_MEANING).sort()).toEqual([...C].sort());
    for (const t of CAMPAIGN_TRANSITIONS) {
      if (t.from !== null) expect(C).toContain(t.from);
      expect(C).toContain(t.to);
      expect(t.actors.length).toBeGreaterThan(0);
    }
  });
});

describe('campaign groupings', () => {
  it('terminal = no transition leaves it', () => {
    expect([...TERMINAL_CAMPAIGN_STATUSES].sort()).toEqual(['cancelled', 'completed', 'expired']);
    for (const s of C) expect(isTerminalCampaign(s)).toBe(TERMINAL_CAMPAIGN_STATUSES.includes(s));
  });

  it('cancellable = every status that has not ended', () => {
    expect([...CANCELLABLE_CAMPAIGN_STATUSES].sort()).toEqual(C.filter((s) => !isTerminalCampaign(s)).sort());
    for (const s of C) expect(canCancelCampaign(s)).toBe(!isTerminalCampaign(s));
  });

  it('approvable = draft and pending_approval; live = approved and sending', () => {
    expect(C.filter(canApproveCampaign).sort()).toEqual(['draft', 'pending_approval']);
    expect(C.filter(isLiveCampaign).sort()).toEqual(['approved', 'sending']);
    expect([...AWAITING_APPROVAL_STATUSES].sort()).toEqual(['draft', 'pending_approval']);
    expect([...LIVE_CAMPAIGN_STATUSES].sort()).toEqual(['approved', 'sending']);
  });

  it('holds recipients in flight: open and not a draft (spec §1.5 rule 7) — never an ended campaign', () => {
    expect([...IN_FLIGHT_CAMPAIGN_STATUSES].sort()).toEqual(['approved', 'pending_approval', 'sending']);
    for (const s of TERMINAL_CAMPAIGN_STATUSES) expect(holdsRecipientsInFlight(s)).toBe(false);
    expect(holdsRecipientsInFlight('draft')).toBe(false);
    // Unknown (the loader did not see the campaign) is the careful answer: in flight.
    expect(holdsRecipientsInFlight(null)).toBe(true);
    expect(holdsRecipientsInFlight(undefined)).toBe(true);
  });

  it('lib/marketing/types.ts derives its groupings from the machine (no second copy to drift)', () => {
    expect(T.TERMINAL_CAMPAIGN_STATUSES).toEqual(TERMINAL_CAMPAIGN_STATUSES);
    expect(T.CAMPAIGN_LIST_STATUSES.pending_approval).toEqual(AWAITING_APPROVAL_STATUSES);
    expect(T.CAMPAIGN_LIST_STATUSES.active).toEqual(LIVE_CAMPAIGN_STATUSES);
    expect(T.CAMPAIGN_LIST_STATUSES.history).toEqual(TERMINAL_CAMPAIGN_STATUSES);
    expect(T.IN_FLIGHT_STATUSES).toEqual(IN_FLIGHT_RECIPIENT_STATUSES);
  });
});

describe('recipient transitions', () => {
  const LEGAL: Record<RecipientStatus, RecipientStatus[]> = {
    pending: ['queued', 'cancelled'],
    queued: ['sending', 'cancelled'],
    sending: ['sent', 'failed', 'skipped', 'cancelled', 'queued'],
    sent: ['delivered', 'read', 'failed'],
    delivered: ['read'],
    read: [],
    failed: [],
    skipped: [],
    holdout: [],
    cancelled: [],
  };

  it.each(R.flatMap((from) => R.map((to) => [from, to] as const)))('%s → %s matches the table', (from, to) => {
    expect(canTransitionRecipient(from, to).ok).toBe(LEGAL[from].includes(to));
  });

  it('is born pending, queued (an Auto campaign) or holdout', () => {
    expect(R.filter((to) => canTransitionRecipient(null, to).ok).sort()).toEqual(['holdout', 'pending', 'queued']);
  });

  it('a claimed row is never put back as pending, and nothing ever returns to sending except by a claim', () => {
    expect(canTransitionRecipient('sending', 'pending').ok).toBe(false);
    expect(RECIPIENT_TRANSITIONS.filter((t) => t.to === 'sending').map((t) => [t.from, t.action])).toEqual([['queued', 'claim']]);
  });

  it('describes every status', () => {
    expect(Object.keys(RECIPIENT_STATE_MEANING).sort()).toEqual([...R].sort());
  });
});

describe('recipient groupings', () => {
  it('in flight = every status from which a send is still reachable', () => {
    const reachesSent = (s: RecipientStatus, seen = new Set<RecipientStatus>()): boolean => {
      if (s === 'sent') return true;
      if (seen.has(s)) return false;
      seen.add(s);
      return RECIPIENT_TRANSITIONS.some((t) => t.from === s && t.action !== 'receipt' && reachesSent(t.to, seen));
    };
    expect([...IN_FLIGHT_RECIPIENT_STATUSES].sort()).toEqual(R.filter((s) => s !== 'sent' && reachesSent(s)).sort());
  });

  it('cancellable = pending and queued (a claimed row is past recall); committed spend = queued and sending', () => {
    expect([...CANCELLABLE_RECIPIENT_STATUSES].sort()).toEqual(['pending', 'queued']);
    expect([...COMMITTED_RECIPIENT_STATUSES].sort()).toEqual(['queued', 'sending']);
    expect(recipientFrom('queue')).toEqual(['pending']);
    expect(recipientFrom('claim')).toEqual(['queued']);
  });

  it('terminal = read, failed, skipped, holdout, cancelled', () => {
    expect([...TERMINAL_RECIPIENT_STATUSES].sort()).toEqual(['cancelled', 'failed', 'holdout', 'read', 'skipped']);
  });
});

describe('the database agrees', () => {
  const checkList = (table: string): string[] => {
    const block = SQL.slice(SQL.indexOf(`create table if not exists public.${table}`));
    const m = /status\s+text not null default '\w+' check \(status in\s*\(([^)]*)\)\)/.exec(block);
    if (!m) throw new Error(`no status CHECK found for ${table}`);
    return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  };

  it('the status CHECK constraints list exactly the machine’s states', () => {
    expect(checkList('marketing_campaigns').sort()).toEqual([...C].sort());
    expect(checkList('marketing_recipients').sort()).toEqual([...R].sort());
  });

  it('claim_marketing_recipients claims queued rows of exactly the live campaigns', () => {
    const fn = SQL.slice(SQL.indexOf('create or replace function public.claim_marketing_recipients'));
    const live = /c\.status in \(([^)]*)\)/.exec(fn);
    expect(live?.[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual([...LIVE_CAMPAIGN_STATUSES].sort());
    expect(fn).toMatch(/r2\.status = 'queued'/);
    expect(fn).toMatch(/set status = 'sending'/);
  });
});
