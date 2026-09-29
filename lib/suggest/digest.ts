// Phase 7 · SUG-12 — weekly owner digest. The engine runs on Jev alone
// (lib/suggest/models.ts), and Jev is decision-only — it cannot write prose —
// so the digest is the plain template built from the week's aggregates
// (SuggestionStats). Only AGGREGATES are ever used; there is no per-customer
// field on that type to leak (playbook S-3). Pure: no model call, so the
// digest row is never missing and never blocks the cron.

import type { SuggestionStats } from './types';

export interface DigestResult {
  summary: string;
  /** Always 'template' today. 'llm' stays in the type because older
   * suggestion_digests rows were written by a text model. */
  source: 'llm' | 'template';
  model: string | null;
  costUsdMicros: number;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

/** The digest — plain numbers from the week's aggregates, no model. */
function buildTemplateSummary(stats: SuggestionStats): string {
  const orderedPct = pct(stats.sessionsOrdered, stats.sessions);
  const addedPct = pct(stats.sessionsWithAdd, stats.sessions);
  const topPick = stats.topItems[0];
  const neverAdded = stats.topItems.filter((i) => i.suggested > 0 && i.added === 0);

  const lines = [
    `This week: ${stats.sessions} suggestion session(s), ${addedPct}% added something to cart, ${orderedPct}% went on to order. Attributed revenue was ₹${stats.attributedRevenueInr}.`,
    `- Engine health: ${Math.round(stats.llmShare * 100)}% answered by Jev, the rest by the fallback ranker — check the Engine health card if that share looks low.`,
    topPick
      ? `- "${topPick.name}" was the most-suggested pick (${topPick.suggested}x shown, ${topPick.added} added) — a good one to feature.`
      : '- No item was suggested enough times yet to call out a top pick.',
    neverAdded.length > 0
      ? `- ${neverAdded.length} suggested item(s) were never added to a cart — review their traits on the Traits tab.`
      : '- No suggested item went completely unadded this week.',
  ];
  return lines.join('\n');
}

/** Produces the weekly digest text for `stats`. Always resolves. */
export async function generateWeeklyDigest(stats: SuggestionStats): Promise<DigestResult> {
  return { summary: buildTemplateSummary(stats), source: 'template', model: null, costUsdMicros: 0 };
}
