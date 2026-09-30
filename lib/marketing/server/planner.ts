// The nightly planner — one pass of the agent's loop (spec §1, §6 "Planner").
//
//   1 MEASURE   attribute returns to recipients whose window is open (attribution.ts)
//   2 LEARN     fold closed campaigns' results into their playbook's conversion rate
//   3 TIDY      expire campaigns nobody approved in two days
//   4 STOP      if the kill switch is off, that is all this run does
//   5 OBSERVE   join orders, points, consent and history into contacts (audience.ts)
//   6 DECIDE    deal each contact to at most one playbook (assignPlaybooks)
//   7 ACT       one campaign per playbook: price it, freeze it, draw the holdout, and
//               either queue it (Auto with every guardrail passing) or park it in
//               Approvals (Review, or any guardrail flag)
//
// Steps 1–3 run even with the kill switch OFF: measuring what already happened and
// closing out old approvals is bookkeeping, never sending.
//
// IDEMPOTENT. A campaign is unique per (playbook, IST day) in the database, so a retried
// or double-fired run hits a unique violation on the campaign insert and skips that
// playbook. The contacts a first run already put in a campaign are `in_flight` for the
// second run in any case, so a re-run cannot double-message anyone.

import 'server-only';
import { randomUUID } from 'node:crypto';
import { assignPlaybooks } from '@/lib/marketing/eligibility';
import { DAY_MS, isWithinSendWindow, istDate } from '@/lib/marketing/ist';
import { DEFAULT_SETTINGS, PLAYBOOK_LABELS } from '@/lib/marketing/types';
import type {
  CampaignStatus,
  MarketingSettings,
  PlanCronResult,
  PlaybookKey,
  PlaybookRow,
  Projection,
} from '@/lib/marketing/types';
import { attributeRecipients } from './attribution';
import { buildContacts, type AudienceSnapshot } from './audience';
import {
  aggregateRecipients,
  expireStale,
  insertCampaign,
  loadAggregates,
  priceCampaign,
  recipientVars,
  remainingBudget,
} from './campaigns';
import {
  assertOk,
  isMigrationMissingError,
  loadSettings,
  marketingAdmin,
  toCampaignRow,
  type Admin,
} from './repo';
import { runSendBatch } from './sender';

const zeroResult = (over: Partial<PlanCronResult> = {}): PlanCronResult => ({
  enabled: false,
  attributed: 0,
  planned: [],
  expired: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

/**
 * Folds every finished playbook campaign into its playbook's observed counters, ONCE
 * (spec §1.6 "Learning"). A campaign is finished when it has started, is completed or
 * cancelled, and its attribution window has fully closed (the last message went out
 * attribution_days + 1 days ago, so the run's own attribution step has already seen
 * every return).
 *
 * "Once" is enforced by claiming the campaign first: the projection's `learned_at` is
 * stamped with a conditional UPDATE (…where projection->>learned_at is null), and only
 * the run whose UPDATE actually moved the row adds the counts. If adding then fails,
 * one learning sample is lost — the safe direction; the alternative is counting it twice.
 */
export async function learnFromClosedCampaigns(
  admin: Admin,
  now: Date,
  settings: Pick<MarketingSettings, 'attribution_days'>,
): Promise<{ campaigns: number }> {
  const { data, error } = await admin
    .from('marketing_campaigns')
    .select('*')
    .eq('kind', 'playbook')
    .not('started_at', 'is', null)
    .in('status', ['completed', 'cancelled'])
    .is('projection->>learned_at', null);
  assertOk('marketing_campaigns read', error);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(toCampaignRow);
  if (rows.length === 0) return { campaigns: 0 };

  const aggregates = await loadAggregates(admin, rows.map((r) => r.id));
  const add = new Map<PlaybookKey, { treated: number; conversions: number }>();
  let learned = 0;

  for (const row of rows) {
    if (!row.playbook_key) continue;
    const agg = aggregates.get(row.id) ?? aggregateRecipients([]);
    if (agg.in_flight > 0) continue;
    const lastMs = agg.last_sent_ms ?? (row.started_at ? Date.parse(row.started_at) : now.getTime());
    if (now.getTime() < lastMs + (settings.attribution_days + 1) * DAY_MS) continue; // window still open

    const stamped: Partial<Projection> = { ...row.projection, learned_at: now.toISOString() };
    const { data: claimed, error: claimError } = await admin
      .from('marketing_campaigns')
      .update({ projection: stamped })
      .eq('id', row.id)
      .is('projection->>learned_at', null)
      .select('id');
    if (claimError) {
      console.error('marketing learning: claim failed', claimError.message);
      continue;
    }
    if (!claimed || claimed.length === 0) continue; // another run got there first

    const cur = add.get(row.playbook_key) ?? { treated: 0, conversions: 0 };
    cur.treated += agg.sent;
    cur.conversions += agg.treated_converted;
    add.set(row.playbook_key, cur);
    learned += 1;
  }

  for (const [key, delta] of add) {
    const { data: current, error: readError } = await admin
      .from('marketing_playbooks')
      .select('observed_treated, observed_conversions')
      .eq('key', key)
      .maybeSingle();
    if (readError || !current) {
      console.error('marketing learning: playbook read failed', readError?.message ?? key);
      continue;
    }
    const c = current as { observed_treated: number; observed_conversions: number };
    const { error: writeError } = await admin
      .from('marketing_playbooks')
      .update({
        observed_treated: (c.observed_treated ?? 0) + delta.treated,
        observed_conversions: (c.observed_conversions ?? 0) + delta.conversions,
      })
      .eq('key', key);
    if (writeError) console.error('marketing learning: playbook write failed', writeError.message);
  }
  return { campaigns: learned };
}

// ---------------------------------------------------------------------------
// One playbook → one campaign
// ---------------------------------------------------------------------------

/** Deterministic, human-readable: "Win-back · stage 1 (we miss you) · 2026-10-01". */
export function campaignName(key: PlaybookKey, now: Date): string {
  return `${PLAYBOOK_LABELS[key]} · ${istDate(now)}`;
}

interface PlanOutcome {
  status: CampaignStatus;
  eligible: number;
  treated: number;
}

async function planPlaybook(
  admin: Admin,
  snapshot: AudienceSnapshot,
  playbook: PlaybookRow,
  eligible: AudienceSnapshot['contacts'][number]['stats'][],
  budgetRemaining: number,
): Promise<PlanOutcome | null> {
  const { settings, now } = snapshot;

  const priced = priceCampaign({
    snapshot,
    eligible,
    offer: playbook.offer,
    template_name: playbook.template.name,
    points_offer: playbook.key === 'points_expiring' ? 'expiring' : playbook.key === 'points_balance' ? 'balance' : undefined,
    prior_conversion_pct: playbook.prior_conversion_pct,
    observed_treated: playbook.observed_treated,
    observed_conversions: playbook.observed_conversions,
    budget_remaining_inr: budgetRemaining,
  });

  // Auto sends without a human, so it may only do so for a campaign that broke no rule.
  const autoApproved = playbook.mode === 'auto' && priced.guardrail_flags.length === 0;

  const result = await insertCampaign(
    admin,
    {
      id: randomUUID(),
      kind: 'playbook',
      playbook_key: playbook.key,
      name: campaignName(playbook.key, now),
      status: autoApproved ? 'approved' : 'pending_approval',
      planned_for: istDate(now),
      send_after: null,
      audience: { params: playbook.params },
      offer: priced.offer,
      template: playbook.template,
      projection: priced.projection,
      guardrail_flags: priced.guardrail_flags,
      priority: playbook.priority,
      created_by: null,
      approved_at: autoApproved ? now.toISOString() : null,
    },
    eligible.map((stats) => ({ stats, vars: recipientVars(stats, priced.offer) })),
    autoApproved ? 'queued' : 'pending',
    settings.holdout_pct,
  );

  if (!result.ok) {
    if (result.duplicate) return null; // already planned today
    throw new Error(`could not plan ${playbook.key}: ${result.error}`);
  }

  await admin.from('marketing_playbooks').update({ last_planned_at: now.toISOString() }).eq('key', playbook.key);
  return { status: result.status === 'approved' ? 'approved' : 'pending_approval', eligible: eligible.length, treated: result.treated };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * One nightly run. Never throws for "the migration isn't applied" — that is a no-op
 * `{enabled:false, migration_missing:true}`. Any other failure propagates (the cron
 * answers 500) rather than planning from a partial picture.
 */
export async function runDailyPlan(now: Date = new Date()): Promise<PlanCronResult> {
  try {
    return await run(now);
  } catch (err) {
    if (isMigrationMissingError(err)) return zeroResult({ migration_missing: true });
    throw err;
  }
}

async function run(now: Date): Promise<PlanCronResult> {
  const admin = marketingAdmin();
  const stored = await loadSettings(admin);
  const settings = stored ?? DEFAULT_SETTINGS;

  // 1–3: bookkeeping, always.
  const attributed = await attributeRecipients(now, settings, admin);
  try {
    await learnFromClosedCampaigns(admin, now, settings);
  } catch (err) {
    if (isMigrationMissingError(err)) throw err;
    console.error('marketing planner: learning failed', err);
  }
  const expired = await expireStale(now, admin);

  // 4: the kill switch.
  if (!stored || !stored.enabled) return zeroResult({ attributed, expired });

  // 5–6
  const snapshot = await buildContacts(now, admin);
  const assignment = assignPlaybooks(snapshot.contacts, snapshot.playbooks, {
    now,
    settings: snapshot.settings,
    receipts_connected: snapshot.receipts_connected,
  });

  // 7
  const planned: PlanCronResult['planned'] = [];
  let budget = await remainingBudget(admin, snapshot.settings, now);
  for (const playbook of snapshot.playbooks) {
    if (playbook.mode === 'off') continue;
    const eligible = assignment.assigned[playbook.key];
    if (eligible.length === 0) continue;
    try {
      const outcome = await planPlaybook(admin, snapshot, playbook, eligible, budget);
      if (!outcome) continue;
      planned.push({ key: playbook.key, status: outcome.status, eligible: outcome.eligible });
      // A campaign that goes out on its own has just claimed part of the month's budget.
      if (outcome.status === 'approved') budget -= outcome.treated * snapshot.settings.message_cost_inr;
    } catch (err) {
      if (isMigrationMissingError(err)) throw err;
      // One playbook failing must not stop the others.
      console.error(`marketing planner: ${playbook.key} failed`, err);
    }
  }

  // Fallback when pg_cron is not set up: nudge the sender once, if the window is open.
  if (isWithinSendWindow(now, snapshot.settings.send_window_start_hour, snapshot.settings.send_window_end_hour)) {
    try {
      await runSendBatch(now);
    } catch (err) {
      console.error('marketing planner: send fallback failed', err);
    }
  }

  return { enabled: true, attributed, planned, expired };
}

