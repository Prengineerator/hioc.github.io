// Phase 7 · SUG-12 — weekly owner digest, written by the WORKER model
// (Sonnet, or Gemini Flash on the free tier, per §1's routing rule: this is
// execution — summarising numbers already computed — not a decision). Only
// AGGREGATES (SuggestionStats) are ever sent; there is no per-customer field
// on that type to leak (playbook S-3). On any failure this falls back to a
// plain template built from the same stats, so the digest row is never
// missing and never blocks the cron.
//
// 'server-only' — reads ANTHROPIC_API_KEY / GEMINI_API_KEY via
// getAnthropicClient() / geminiGenerateText() (S-1).

import 'server-only';
import { getAnthropicClient } from './anthropic';
import { geminiGenerateText } from './gemini';
import { costUsdMicros, geminiWorkerModel, llmProvider, workerModel, workerModelLabel } from './models';
import type { SuggestionStats } from './types';

export interface DigestResult {
  summary: string;
  source: 'llm' | 'template';
  model: string | null;
  costUsdMicros: number;
}

const MAX_TOKENS = 2000;
const TIMEOUT_MS = 30000;
const MAX_WORDS = 120;
const MIN_BULLETS = 3;

const SYSTEM_PROMPT = [
  'You are writing a short weekly note for the owner of a small coffee shop, from aggregate stats about a "help me choose" suggestion feature — no customer data.',
  `Write at most ${MAX_WORDS} words total: one or two sentences on how the feature did this week, then exactly ${MIN_BULLETS} bullet lines, each starting with "-", each one concrete action the owner could take.`,
  'Only use the numbers given — never invent a figure. Plain, calm, factual tone: no hype, no emoji, no urgency.',
].join('\n');

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countBullets(text: string): number {
  return text
    .split('\n')
    .filter((line) => /^[-•]/.test(line.trim())).length;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

/** The always-available fallback digest — plain numbers, no model. */
function buildTemplateSummary(stats: SuggestionStats): string {
  const orderedPct = pct(stats.sessionsOrdered, stats.sessions);
  const addedPct = pct(stats.sessionsWithAdd, stats.sessions);
  const topPick = stats.topItems[0];
  const neverAdded = stats.topItems.filter((i) => i.suggested > 0 && i.added === 0);

  const lines = [
    `This week: ${stats.sessions} suggestion session(s), ${addedPct}% added something to cart, ${orderedPct}% went on to order. Attributed revenue was ₹${stats.attributedRevenueInr}.`,
    `- Engine health: ${Math.round(stats.llmShare * 100)}% answered by Opus, the rest by the fallback ranker — check the Engine health card if that share looks low.`,
    topPick
      ? `- "${topPick.name}" was the most-suggested pick (${topPick.suggested}x shown, ${topPick.added} added) — a good one to feature.`
      : '- No item was suggested enough times yet to call out a top pick.',
    neverAdded.length > 0
      ? `- ${neverAdded.length} suggested item(s) were never added to a cart — review their traits on the Traits tab.`
      : '- No suggested item went completely unadded this week.',
  ];
  return lines.join('\n');
}

function buildPrompt(stats: SuggestionStats): string {
  return `This week's suggestion-engine aggregates (JSON, no customer data):\n${JSON.stringify(stats)}`;
}

async function generateWithAnthropic(stats: SuggestionStats, templateSummary: string): Promise<DigestResult> {
  const client = getAnthropicClient();
  if (!client) {
    return { summary: templateSummary, source: 'template', model: null, costUsdMicros: 0 };
  }

  const model = workerModel();
  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: buildPrompt(stats) }],
      },
      { timeout: TIMEOUT_MS },
    );

    const usage = {
      inputTokens: response.usage.input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
    };
    const costMicros = costUsdMicros(model, usage);

    if (response.stop_reason !== 'end_turn') {
      return { summary: templateSummary, source: 'template', model: null, costUsdMicros: costMicros };
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    const text = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
    if (!text || wordCount(text) > MAX_WORDS || countBullets(text) < MIN_BULLETS) {
      return { summary: templateSummary, source: 'template', model: null, costUsdMicros: costMicros };
    }
    return { summary: text, source: 'llm', model, costUsdMicros: costMicros };
  } catch (err) {
    console.error('generateWeeklyDigest: Sonnet call failed', err);
    return { summary: templateSummary, source: 'template', model: null, costUsdMicros: 0 };
  }
}

/** Gemini's free-tier sibling of generateWithAnthropic — plain text, no JSON
 * schema (geminiGenerateJson is JSON-only, hence lib/suggest/gemini.ts's
 * separate geminiGenerateText). Same word/bullet-count guard, same template
 * fallback on any failure. */
async function generateWithGemini(stats: SuggestionStats, templateSummary: string): Promise<DigestResult> {
  try {
    const { text: raw, usage } = await geminiGenerateText({
      model: geminiWorkerModel(),
      system: SYSTEM_PROMPT,
      user: buildPrompt(stats),
      maxOutputTokens: MAX_TOKENS,
      timeoutMs: TIMEOUT_MS,
    });
    const label = workerModelLabel();
    const costMicros = costUsdMicros(label, {
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: 0,
      outputTokens: usage.outputTokens,
    });

    const text = raw.trim();
    if (!text || wordCount(text) > MAX_WORDS || countBullets(text) < MIN_BULLETS) {
      return { summary: templateSummary, source: 'template', model: null, costUsdMicros: costMicros };
    }
    return { summary: text, source: 'llm', model: label, costUsdMicros: costMicros };
  } catch (err) {
    console.error('generateWeeklyDigest: Gemini call failed', err);
    return { summary: templateSummary, source: 'template', model: null, costUsdMicros: 0 };
  }
}

/**
 * Produces the weekly digest text for `stats`. Always resolves — no
 * configured provider, a timeout, a refusal/non-completion, or a summary that
 * breaks the word/bullet rules all fall back to the template rather than
 * throwing, so the cron route (SUG-12 AC: "given the LLM fails, a digest row
 * with the plain numbers and source='template'") always has something to
 * store.
 */
export async function generateWeeklyDigest(stats: SuggestionStats): Promise<DigestResult> {
  const templateSummary = buildTemplateSummary(stats);
  const provider = llmProvider();
  if (provider === 'gemini') return generateWithGemini(stats, templateSummary);
  if (provider === 'anthropic') return generateWithAnthropic(stats, templateSummary);
  return { summary: templateSummary, source: 'template', model: null, costUsdMicros: 0 };
}
