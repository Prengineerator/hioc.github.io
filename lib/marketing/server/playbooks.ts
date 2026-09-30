// The owner's view of the five playbooks and the one edit they can make to each
// (spec §6: GET /playbooks, PATCH /playbooks/[key]). Kept out of planner.ts so the
// nightly run does not drag the dashboard's read models in with it.

import 'server-only';
import { blendedRate } from '@/lib/marketing/economics';
import { validatePlaybookParams } from '@/lib/marketing/parse';
import { PLAYBOOK_DESCRIPTIONS, PLAYBOOK_LABELS } from '@/lib/marketing/types';
import type { PlaybookKey, PlaybookParams, PlaybookPatch, PlaybookRow, PlaybookView } from '@/lib/marketing/types';
import { recentCampaigns } from './campaigns';
import { loadPlaybooks, marketingAdmin, savePlaybook, type Admin } from './repo';

async function toView(admin: Admin, row: PlaybookRow, now: Date): Promise<PlaybookView> {
  const runs = await recentCampaigns(admin, 5, now, row.key);
  return {
    ...row,
    label: PLAYBOOK_LABELS[row.key],
    description: PLAYBOOK_DESCRIPTIONS[row.key],
    // The rate projections use right now: the Bayesian blend of the research prior and what this cafe achieved.
    learned_conversion_pct: 100 * blendedRate(row.prior_conversion_pct, row.observed_treated, row.observed_conversions),
    // Last runs show results, not message previews.
    last_runs: runs.map((c) => ({ ...c, samples: [] })),
  } as PlaybookView;
}

/** GET /playbooks — all five, in priority order. */
export async function listPlaybookViews(now: Date = new Date()): Promise<PlaybookView[]> {
  const admin = marketingAdmin();
  const rows = await loadPlaybooks(admin);
  return Promise.all(rows.map((row) => toView(admin, row, now)));
}

export type PatchPlaybookResult = { ok: true; playbook: PlaybookView } | { ok: false; error: string };

/**
 * PATCH /playbooks/[key]. The caller has already validated the patch's own fields
 * (parsePlaybookPatch); what only the MERGED playbook can answer is checked here: the
 * cross-field rules inside params (a patch may carry just one side of min_days ≤ max_days).
 */
export async function patchPlaybook(
  key: PlaybookKey,
  patch: PlaybookPatch,
  userId: string | null,
  now: Date = new Date(),
): Promise<PatchPlaybookResult> {
  const admin = marketingAdmin();
  const rows = await loadPlaybooks(admin);
  const current = rows.find((r) => r.key === key);
  if (!current) return { ok: false, error: 'Unknown playbook.' };

  const mergedParams = { ...current.params, ...(patch.params ?? {}) } as PlaybookParams;
  const paramError = validatePlaybookParams(key, mergedParams);
  if (paramError) return { ok: false, error: paramError };

  const next = {
    ...current,
    mode: patch.mode ?? current.mode,
    params: mergedParams,
    offer: patch.offer ?? current.offer,
    template: patch.template ?? current.template,
    prior_conversion_pct: patch.prior_conversion_pct ?? current.prior_conversion_pct,
  } as PlaybookRow;

  const saved = await savePlaybook(admin, next, userId);
  return { ok: true, playbook: await toView(admin, saved, now) };
}
