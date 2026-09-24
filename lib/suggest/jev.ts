// The ONE place the TypeSafe AI ("Jev") client is constructed (playbook S-1,
// extended to Jev: TYPESAFE_API_KEY is read only in a 'server-only' module
// and never reaches a client bundle — docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §9 S-7). Mirrors lib/suggest/anthropic.ts's shape exactly.
//
// retry: { maxRetries: 0 } is the CLIENT default on purpose: the decider path
// (lib/suggest/jevDecider.ts) owns its own deterministic fallback and a hard
// timeout, and an SDK retry would silently blow that latency budget. Trait
// tagging (lib/suggest/traitsPrompt.ts) is not latency-sensitive the same
// way, so it opts INTO one retry per call via a per-call `retry` override —
// the client-level default never changes.
//
// dangerouslyAllowBrowser is left at its SDK default (false) and never set —
// this client is never constructed anywhere a browser could load it.

import 'server-only';
import { TypeSafeClient } from '@typesafe-ai/sdk';

let client: TypeSafeClient | null = null;

/** The shared client, or null when TYPESAFE_API_KEY is unset (→ callers fall back). */
export function getJevClient(): TypeSafeClient | null {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  if (!client) {
    client = new TypeSafeClient({ apiKey, logLevel: 'warn', retry: { maxRetries: 0 } });
  }
  return client;
}
