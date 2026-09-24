// Phase 7 — which LLM provider/model does which job (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §1). The owner's rule: DECISIONS go to the decider model, EXECUTION goes to
// the worker model (or to plain code). Every LLM call in lib/suggest picks
// its model from here, so a model upgrade — or a switch of PROVIDER — is an
// env change, not a hunt through the codebase.
//
//   decider (TypeSafe AI "Jev" when configured — a decision-only model, no
//     prose — else Opus, else Gemini Flash) — menu trait tagging (SUG-2),
//     choosing the final picks (SUG-4)
//   worker  (Sonnet, or Gemini Flash when configured; NEVER Jev, which cannot
//     write prose) — the weekly owner digest (SUG-12)
//
// Three providers are supported: TypeSafe AI Jev (decisions only, paid,
// `TYPESAFE_API_KEY`), Anthropic (paid, `ANTHROPIC_API_KEY`) and Google
// Gemini (free tier, `GEMINI_API_KEY` — see .env.local.example). All three
// speak the same prompts/questions, schemas and validation; only
// lib/suggest/llm.ts's/jevDecider.ts's Decider implementations and
// lib/suggest/gemini.ts's transport differ.
//
// Two provider "roles" matter because Jev can't generate text:
//   deciderProvider() — for DECISION jobs (choosing picks, tagging traits).
//     Prefers Jev, then Anthropic, then Gemini.
//   textProvider()    — for jobs that need PROSE (the weekly digest). Jev is
//     never selected here, even when pinned — falls through to Anthropic,
//     then Gemini.
//
// Pure: no SDK import, no 'server-only', so provider selection and cost maths
// are unit-testable without a network or an API key.

export type LlmProvider = 'anthropic' | 'gemini' | 'jev';
/** The subset of providers that can write prose (used by the weekly digest). */
export type TextProvider = 'anthropic' | 'gemini';

function isKillSwitchOff(): boolean {
  const v = (process.env.SUGGEST_LLM ?? '').trim().toLowerCase();
  return v === 'off' || v === 'false' || v === '0';
}

/**
 * Which provider (if any) answers Phase-7 DECISION jobs right now (choosing
 * picks — SUG-4, tagging menu traits — SUG-2).
 *  - SUGGEST_LLM=off/false/0 is the master kill switch: always null, whatever
 *    else is configured.
 *  - SUGGEST_LLM_PROVIDER pins one provider explicitly ('jev', 'gemini' or
 *    'anthropic'). It is used ONLY when that provider's key is actually set —
 *    a pin with no key is null, never a silent fall-through to another
 *    provider.
 *  - Otherwise (auto): Jev first if TYPESAFE_API_KEY is set (Jev is a
 *    decision-only "System One" model — the best fit for this job), else
 *    Anthropic if ANTHROPIC_API_KEY is set (today's default for deployments
 *    without a Jev key), else Gemini if GEMINI_API_KEY is set, else null.
 */
export function deciderProvider(): LlmProvider | null {
  if (isKillSwitchOff()) return null;

  const pinned = (process.env.SUGGEST_LLM_PROVIDER ?? '').trim().toLowerCase();
  if (pinned === 'jev') return process.env.TYPESAFE_API_KEY ? 'jev' : null;
  if (pinned === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;
  if (pinned === 'anthropic') return process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;

  if (process.env.TYPESAFE_API_KEY) return 'jev';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

/**
 * Which provider (if any) answers Phase-7 TEXT jobs right now (the weekly
 * digest — SUG-12, which needs prose). Jev is never returned here, even when
 * `SUGGEST_LLM_PROVIDER=jev` is pinned — Jev cannot generate text (§1), so a
 * Jev pin falls through to auto selection between Anthropic and Gemini for
 * this job specifically.
 */
export function textProvider(): TextProvider | null {
  if (isKillSwitchOff()) return null;

  const pinned = (process.env.SUGGEST_LLM_PROVIDER ?? '').trim().toLowerCase();
  if (pinned === 'anthropic') return process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  if (pinned === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;

  // 'jev', 'auto', unset or unrecognised — plain auto selection between the
  // two text-capable providers.
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

/** @deprecated kept for existing callers — identical to `deciderProvider()`.
 * Every current caller of this function wants the DECIDER provider (picks,
 * trait tagging); the digest module uses `textProvider()` instead. */
export function llmProvider(): LlmProvider | null {
  return deciderProvider();
}

/** SUGGEST_LLM=off (or simply no usable decider provider key) forces the
 * deterministic path everywhere (kill switch). Same name/signature every
 * existing caller already uses — only what decides it changed. */
export function llmEnabled(): boolean {
  return deciderProvider() !== null;
}

/** Why `deciderProvider()` is null, for the `fallback_reason` recorded on a
 * suggestion session (§5.4 "Fallback triggers"): 'disabled' when the
 * SUGGEST_LLM kill switch is off, 'no_key' when no usable provider key is
 * configured (including a SUGGEST_LLM_PROVIDER pin whose key is missing).
 * null when a provider IS active. */
export function llmDisabledReason(): 'disabled' | 'no_key' | null {
  if (deciderProvider() !== null) return null;
  return isKillSwitchOff() ? 'disabled' : 'no_key';
}

export const DEFAULT_DECIDER_MODEL = 'claude-opus-5';
export const DEFAULT_WORKER_MODEL = 'claude-sonnet-5';

export function deciderModel(): string {
  return process.env.SUGGEST_DECIDER_MODEL?.trim() || DEFAULT_DECIDER_MODEL;
}

export function workerModel(): string {
  return process.env.SUGGEST_WORKER_MODEL?.trim() || DEFAULT_WORKER_MODEL;
}

// Google's FREE-TIER model ids change more often than Anthropic's paid ones —
// when the default below stops working, copy the exact id shown for your key
// in Google AI Studio (https://aistudio.google.com/apikey) into GEMINI_MODEL.
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/** Falls back to geminiModel() when GEMINI_WORKER_MODEL is unset — most
 * owners run a single free-tier model for everything. */
export function geminiWorkerModel(): string {
  return process.env.GEMINI_WORKER_MODEL?.trim() || geminiModel();
}

// TypeSafe AI's own SDK default — kept in sync with @typesafe-ai/sdk's
// `defaultModel` fallback so an unset JEV_MODEL behaves identically whether
// read here or inside the SDK itself.
export const DEFAULT_JEV_MODEL = 'jev-latest';

export function jevModel(): string {
  return process.env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
}

/** What gets recorded as `model` on a suggestion_session row (§5.4): the
 * Anthropic model id, unprefixed, exactly as before — or "gemini:<model>" /
 * "jev:<model>" so the owner dashboard can tell the providers apart at a
 * glance. */
export function deciderModelLabel(): string {
  const provider = deciderProvider();
  if (provider === 'jev') return `jev:${jevModel()}`;
  if (provider === 'gemini') return `gemini:${geminiModel()}`;
  return deciderModel();
}

/** Same idea for the weekly digest's `model` column (SUG-12). Jev is never a
 * text provider, so this only ever varies between Anthropic and Gemini. */
export function workerModelLabel(): string {
  return textProvider() === 'gemini' ? `gemini:${geminiWorkerModel()}` : workerModel();
}

// USD per million tokens. Used for the DB-backed daily spend cap (SUG-6) and
// the owner dashboard's cost line — an estimate, not an invoice. Unknown
// Anthropic models price as Opus so an override can only ever make the cap
// trip EARLIER. Gemini has no entry here on purpose: its free tier costs $0,
// handled as an early return in costUsdMicros() below rather than a price of
// zero, so it can never be nudged non-zero by an unrelated PRICES edit. If the
// owner later enables Gemini billing, add real per-model prices here AND
// delete the 'gemini' early return. Jev is likewise handled as its own early
// return (input $0.042/MTok, output free — Jev never generates output tokens
// worth billing since it can't write text) rather than a PRICES entry.
const JEV_INPUT_USD_PER_MTOK = 0.042;
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

/** Estimated cost in integer micro-dollars (1 USD = 1,000,000). Any model id
 * starting with "gemini" — the raw id ("gemini-3-flash-preview") or the
 * "gemini:<model>" label — is $0: Gemini's free tier. Any model id starting
 * with "jev" — "jev-latest" or the "jev:<model>" label — prices at Jev's
 * input-only rate: output is free, and $0.042/MTok input is exactly 0.042
 * micro-dollars per input token, so this is `round(inputTokens × 0.042)`. */
export function costUsdMicros(model: string, u: TokenUsage): number {
  if (model.startsWith('gemini')) return 0;
  if (model.startsWith('jev')) return Math.round(u.inputTokens * JEV_INPUT_USD_PER_MTOK);
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
