// Phase 7 — which Claude model does which job (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §1).
//
// The owner's rule: DECISIONS go to Opus, EXECUTION goes to Sonnet (or to
// plain code). Every LLM call in lib/suggest picks its model from here, so a
// model upgrade is an env change, not a hunt through the codebase.
//
//   decider  (Opus)   — menu trait tagging (SUG-2), choosing the final picks (SUG-4)
//   worker   (Sonnet) — the weekly owner digest (SUG-12)
//
// Pure: no SDK import, no 'server-only', so cost maths is unit-testable.

export const DEFAULT_DECIDER_MODEL = 'claude-opus-5';
export const DEFAULT_WORKER_MODEL = 'claude-sonnet-5';

export function deciderModel(): string {
  return process.env.SUGGEST_DECIDER_MODEL?.trim() || DEFAULT_DECIDER_MODEL;
}

export function workerModel(): string {
  return process.env.SUGGEST_WORKER_MODEL?.trim() || DEFAULT_WORKER_MODEL;
}

// USD per million tokens. Used for the DB-backed daily spend cap (SUG-6) and the
// owner dashboard's cost line — an estimate, not an invoice. Unknown models
// price as Opus so an override can only ever make the cap trip EARLIER.
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

export function priceFor(model: string): Price {
  return PRICES[model] ?? PRICES[DEFAULT_DECIDER_MODEL];
}

export interface TokenUsage {
  inputTokens: number; // uncached input
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Estimated cost in integer micro-dollars (1 USD = 1,000,000). */
export function costUsdMicros(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  const usd =
    (u.inputTokens * p.input +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWriteTokens * p.cacheWrite +
      u.outputTokens * p.output) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}

/** SUGGEST_DAILY_BUDGET_USD (default 3) in micro-dollars. */
export function dailyBudgetUsdMicros(): number {
  const raw = Number(process.env.SUGGEST_DAILY_BUDGET_USD);
  const usd = Number.isFinite(raw) && raw >= 0 ? raw : 3;
  return Math.round(usd * 1_000_000);
}

/** SUGGEST_LLM=off forces the deterministic path everywhere (kill switch). */
export function llmEnabled(): boolean {
  const v = (process.env.SUGGEST_LLM ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
