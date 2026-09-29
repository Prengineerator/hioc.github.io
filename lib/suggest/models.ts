// Phase 7 — which model does which job (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §1). The engine runs on ONE model: TypeSafe AI's "Jev", a decision-only
// "System One" model. It answers every DECISION job — menu trait tagging
// (SUG-2) and choosing the final picks (SUG-4). It cannot write prose, so
// every customer-facing sentence (pick reasons, headers) and the weekly owner
// digest (SUG-12) come from the deterministic templates instead.
//
// With no TYPESAFE_API_KEY (or the SUGGEST_LLM kill switch off) the whole
// engine runs on its deterministic ranker — source: 'fallback'.
//
// Pure: no SDK import, no 'server-only', so provider selection and cost maths
// are unit-testable without a network or an API key.

export type LlmProvider = 'jev';

function isKillSwitchOff(): boolean {
  const v = (process.env.SUGGEST_LLM ?? '').trim().toLowerCase();
  return v === 'off' || v === 'false' || v === '0';
}

/**
 * Which provider (if any) answers Phase-7 DECISION jobs right now (choosing
 * picks — SUG-4, tagging menu traits — SUG-2).
 *  - SUGGEST_LLM=off/false/0 is the master kill switch: always null.
 *  - Otherwise Jev when TYPESAFE_API_KEY is set, else null.
 */
export function deciderProvider(): LlmProvider | null {
  if (isKillSwitchOff()) return null;
  return process.env.TYPESAFE_API_KEY ? 'jev' : null;
}

/** @deprecated kept for existing callers — identical to `deciderProvider()`. */
export function llmProvider(): LlmProvider | null {
  return deciderProvider();
}

/** SUGGEST_LLM=off (or simply no TYPESAFE_API_KEY) forces the deterministic
 * path everywhere (kill switch). */
export function llmEnabled(): boolean {
  return deciderProvider() !== null;
}

/** Why `deciderProvider()` is null, for the `fallback_reason` recorded on a
 * suggestion session (§5.4 "Fallback triggers"): 'disabled' when the
 * SUGGEST_LLM kill switch is off, 'no_key' when TYPESAFE_API_KEY is unset.
 * null when Jev IS active. */
export function llmDisabledReason(): 'disabled' | 'no_key' | null {
  if (deciderProvider() !== null) return null;
  return isKillSwitchOff() ? 'disabled' : 'no_key';
}

// TypeSafe AI's own SDK default — kept in sync with @typesafe-ai/sdk's
// `defaultModel` fallback so an unset JEV_MODEL behaves identically whether
// read here or inside the SDK itself.
export const DEFAULT_JEV_MODEL = 'jev-latest';

export function jevModel(): string {
  return process.env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
}

/** What gets recorded as `model` on a suggestion_session row (§5.4):
 * "jev:<model>", so the owner dashboard can tell it apart from rows written
 * before the switch (raw "claude-…" ids, "gemini:…" labels). */
export function deciderModelLabel(): string {
  return `jev:${jevModel()}`;
}

// Jev bills input tokens only: $0.042 per million, output free (it never
// generates text). $0.042/MTok is exactly 0.042 micro-dollars per token.
const JEV_INPUT_USD_PER_MTOK = 0.042;

export interface TokenUsage {
  inputTokens: number; // uncached input
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Estimated cost in integer micro-dollars (1 USD = 1,000,000) — an estimate
 * for the DB-backed daily spend cap (SUG-6) and the owner dashboard's cost
 * line, not an invoice: `round(inputTokens × 0.042)`. */
export function costUsdMicros(_model: string, u: TokenUsage): number {
  return Math.round(u.inputTokens * JEV_INPUT_USD_PER_MTOK);
}

/** SUGGEST_DAILY_BUDGET_USD (default 3) in micro-dollars. */
export function dailyBudgetUsdMicros(): number {
  const raw = Number(process.env.SUGGEST_DAILY_BUDGET_USD);
  const usd = Number.isFinite(raw) && raw >= 0 ? raw : 3;
  return Math.round(usd * 1_000_000);
}
