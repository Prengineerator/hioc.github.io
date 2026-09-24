// The ONE place the Anthropic client is constructed (playbook S-1: the API key
// is read only in 'server-only' modules and never reaches a client bundle).
//
// maxRetries is 0 on purpose: every caller owns a deterministic fallback and a
// hard timeout, and an SDK retry would silently blow that latency budget.

import 'server-only';
import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

/** The shared client, or null when ANTHROPIC_API_KEY is unset (→ callers fall back). */
export function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey, maxRetries: 0 });
  return client;
}

// Refusal handling for the Opus decider: the API re-runs a declined request on
// a fallback model inside the same call (server-side fallbacks, "default"
// routing). Pass both on client.beta.messages.create.
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const SERVER_FALLBACKS = 'default' as const;
