// Phase 7 — the Gemini transport (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §1,
// §5.4, §5.6): raw `fetch` against the Gemini REST API, no SDK dependency.
// Used by lib/suggest/llm.ts's `geminiDecider`, lib/suggest/traitsPrompt.ts's
// Gemini batch path, and lib/suggest/digest.ts's Gemini path.
//
// 'server-only' — this is where GEMINI_API_KEY-backed calls happen (playbook
// S-1, extended to S-6: the key is sent ONLY as the `x-goog-api-key` header,
// NEVER in the URL — URLs get logged by proxies, browsers and error trackers
// — and it never appears in a thrown Error's message).
//
// Every failure mode throws a DeciderError with a `kind` lib/suggest/engine.ts
// (or the caller) can map onto a FallbackReason, exactly like the Anthropic
// path in lib/suggest/llm.ts: timeout / refusal / invalid_output / error.

import 'server-only';
import { DeciderError } from './deciderError';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// finishReason values that mean the model declined to answer (Gemini's
// equivalent of Anthropic's `stop_reason: 'refusal'`).
const REFUSAL_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION']);

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiResponseBody {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
  error?: { message?: string };
}

/** Thrown only internally by postGenerateContent — callers convert it to a
 * DeciderError (classifyHttpError), except geminiGenerateJson's one-shot
 * schema retry, which inspects `.message` first (§5.4 "Schema robustness"). */
class GeminiHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GeminiHttpError';
    this.status = status;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function classifyHttpError(err: unknown): DeciderError {
  if (err instanceof DeciderError) return err;
  if (err instanceof GeminiHttpError) return new DeciderError('error', err.message);
  return new DeciderError('error', err instanceof Error ? err.message : String(err));
}

/** Combines the caller's AbortSignal (if any) with an internal timer, so a
 * hung request is always aborted within `timeoutMs` whether or not the caller
 * passed a signal — mirrors lib/suggest/llm.ts's own hard timeout. */
function withTimeout(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort);
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function usageFrom(body: GeminiResponseBody): GeminiUsage {
  const u = body.usageMetadata ?? {};
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    cacheReadTokens: u.cachedContentTokenCount ?? 0,
  };
}

/** Concatenation of every non-thought text part (§5.4 "skip parts where
 * thought === true" — Gemini's "thinking" content is never the answer). */
function extractText(body: GeminiResponseBody): string {
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

function throwIfRefused(body: GeminiResponseBody): void {
  const blockReason = body.promptFeedback?.blockReason;
  if (blockReason) throw new DeciderError('refusal', `gemini blocked: ${blockReason}`);
  const finishReason = body.candidates?.[0]?.finishReason;
  if (finishReason && REFUSAL_FINISH_REASONS.has(finishReason)) {
    throw new DeciderError('refusal', `gemini finishReason=${finishReason}`);
  }
}

/** POSTs one generateContent call. Never puts the key anywhere but the
 * x-goog-api-key header (S-6) and never echoes it into a thrown message. */
async function postGenerateContent(args: {
  model: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<GeminiResponseBody> {
  const apiKey = process.env.GEMINI_API_KEY;
  // Callers already gate on llmProvider() before reaching here, but a direct
  // or test call still gets a clean, key-free error rather than a bad fetch.
  if (!apiKey) throw new DeciderError('error', 'GEMINI_API_KEY is not set');

  const { signal, cancel } = withTimeout(args.timeoutMs, args.signal);
  let response: Response;
  try {
    response = await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(args.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(args.body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DeciderError('timeout', 'gemini request timed out');
    }
    throw new DeciderError('error', err instanceof Error ? err.message : String(err));
  } finally {
    cancel();
  }

  if (!response.ok) {
    let message = `gemini HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as GeminiResponseBody;
      const apiMessage = errBody.error?.message;
      if (typeof apiMessage === 'string') message = `gemini HTTP ${response.status}: ${truncate(apiMessage, 300)}`;
    } catch {
      // Error body wasn't JSON — the bare status is still useful.
    }
    throw new GeminiHttpError(response.status, message);
  }

  return (await response.json()) as GeminiResponseBody;
}

// Speeds up trait tagging and the picks decision (owner-reported: a full
// minute per click, ~40 items tagged). 'low' is used for both — enough to cut
// latency sharply without needing deep reasoning for a JSON-schema-constrained
// classification task. Never sent unless a caller opts in (the digest, which
// wants full reasoning for its prose, never passes this).
export type GeminiThinkingLevel = 'low' | 'medium' | 'high';

// Never more than this many HTTP attempts for one logical call — the two
// retries below (schema, thinking) can each fire independently, or a single
// 400 can trigger both drops at once, but the loop bound is the hard cap
// regardless of which combination occurs.
const MAX_ATTEMPTS = 3;

function buildJsonBody(args: {
  system: string;
  user: string;
  schema?: Record<string, unknown>;
  maxOutputTokens: number;
  thinkingLevel?: GeminiThinkingLevel;
}) {
  return {
    systemInstruction: { parts: [{ text: args.system }] },
    contents: [{ role: 'user', parts: [{ text: args.user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(args.schema ? { responseJsonSchema: args.schema } : {}),
      ...(args.thinkingLevel ? { thinkingConfig: { thinkingLevel: args.thinkingLevel } } : {}),
      maxOutputTokens: args.maxOutputTokens,
    },
  };
}

export interface GeminiGenerateJsonArgs {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Sets `generationConfig.thinkingConfig.thinkingLevel`. Omit for the
   * model's default (used by nothing in this codebase today except the
   * digest, implicitly, by never passing it). */
  thinkingLevel?: GeminiThinkingLevel;
}

function isSchemaRelated400(err: unknown): boolean {
  return err instanceof GeminiHttpError && err.status === 400 && /responseJsonSchema|schema/i.test(err.message);
}

function isThinkingRelated400(err: unknown): boolean {
  return err instanceof GeminiHttpError && err.status === 400 && /thinking/i.test(err.message);
}

/**
 * Structured-JSON generation. Never sends temperature. Up to MAX_ATTEMPTS
 * HTTP attempts total, dropping one feature per retry:
 *  - If the API 400s specifically because of `responseJsonSchema`, retries
 *    without it — schema described in the system text instead — since our
 *    own validators (traitsValidate.ts / validate.ts) check every field
 *    regardless of whether the model was schema-constrained (§5.4 "Schema
 *    robustness").
 *  - If the API 400s specifically because of `thinkingConfig` (an older
 *    model that doesn't support it), retries without it.
 *  - Both drops can apply across the (at most 3) attempts, in whichever
 *    order the API actually rejects them.
 */
export async function geminiGenerateJson(args: GeminiGenerateJsonArgs): Promise<{ json: unknown; usage: GeminiUsage }> {
  let useSchema = true;
  let useThinking = Boolean(args.thinkingLevel);
  let body: GeminiResponseBody | undefined;
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const system = useSchema
      ? args.system
      : `${args.system}\n\nRespond with JSON matching this JSON Schema exactly: ${JSON.stringify(args.schema)}`;
    try {
      body = await postGenerateContent({
        model: args.model,
        body: buildJsonBody({
          system,
          user: args.user,
          schema: useSchema ? args.schema : undefined,
          maxOutputTokens: args.maxOutputTokens,
          thinkingLevel: useThinking ? args.thinkingLevel : undefined,
        }),
        timeoutMs: args.timeoutMs,
        signal: args.signal,
      });
      break;
    } catch (err) {
      lastErr = err;
      const dropSchema = useSchema && isSchemaRelated400(err);
      const dropThinking = useThinking && isThinkingRelated400(err);
      if (!dropSchema && !dropThinking) throw classifyHttpError(err);
      if (dropSchema) useSchema = false;
      if (dropThinking) useThinking = false;
      // loop again with the offending feature(s) dropped, up to MAX_ATTEMPTS
    }
  }
  if (!body) throw classifyHttpError(lastErr);

  throwIfRefused(body);
  const finishReason = body.candidates?.[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') throw new DeciderError('invalid_output', 'gemini finishReason=MAX_TOKENS');

  const text = extractText(body);
  if (!text) throw new DeciderError('invalid_output', 'no text content in gemini response');

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DeciderError('invalid_output', 'gemini response was not valid JSON');
  }

  return { json, usage: usageFrom(body) };
}

export interface GeminiGenerateTextArgs {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  thinkingLevel?: GeminiThinkingLevel;
}

/** Plain-text generation (SUG-12's digest — no JSON schema involved, so only
 * the thinking-config retry applies here; at most 2 HTTP attempts). The
 * digest never passes `thinkingLevel` — it wants full reasoning for prose. */
export async function geminiGenerateText(args: GeminiGenerateTextArgs): Promise<{ text: string; usage: GeminiUsage }> {
  let useThinking = Boolean(args.thinkingLevel);
  let body: GeminiResponseBody | undefined;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      body = await postGenerateContent({
        model: args.model,
        body: {
          systemInstruction: { parts: [{ text: args.system }] },
          contents: [{ role: 'user', parts: [{ text: args.user }] }],
          generationConfig: {
            maxOutputTokens: args.maxOutputTokens,
            ...(useThinking ? { thinkingConfig: { thinkingLevel: args.thinkingLevel } } : {}),
          },
        },
        timeoutMs: args.timeoutMs,
        signal: args.signal,
      });
      break;
    } catch (err) {
      lastErr = err;
      if (!(useThinking && isThinkingRelated400(err))) throw classifyHttpError(err);
      useThinking = false;
    }
  }
  if (!body) throw classifyHttpError(lastErr);

  throwIfRefused(body);
  const finishReason = body.candidates?.[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') throw new DeciderError('invalid_output', 'gemini finishReason=MAX_TOKENS');

  const text = extractText(body);
  if (!text) throw new DeciderError('invalid_output', 'no text content in gemini response');

  return { text, usage: usageFrom(body) };
}
