// Phase 7 · SUG-4 — the Decider failure vocabulary (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5.4 "Fallback triggers"). Split out from lib/suggest/llm.ts so
// lib/suggest/engine.ts can catch and classify a decider's failure WITHOUT
// importing the Anthropic SDK or 'server-only' — engine.ts stays pure and
// network-free, which is what makes it unit-testable with an injected fake
// Decider and no network/DB (SUG-4).
//
// Pure: no Supabase, no 'server-only', no SDK.

export type DeciderErrorKind = 'timeout' | 'refusal' | 'invalid_output' | 'error';

/** Thrown by any `Decider` implementation on every failure path. `kind` maps
 * 1:1 onto the session's `fallback_reason` (lib/suggest/types.ts `FallbackReason`). */
export class DeciderError extends Error {
  readonly kind: DeciderErrorKind;
  constructor(kind: DeciderErrorKind, message: string) {
    super(message);
    this.name = 'DeciderError';
    this.kind = kind;
  }
}
