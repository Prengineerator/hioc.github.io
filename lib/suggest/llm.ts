// Phase 7 · SUG-4 — which `Decider` answers a suggestion request
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.4). The engine runs on Jev
// alone (lib/suggest/jevDecider.ts); this module is the seam
// app/api/suggest/route.ts calls, so the route never reaches for a concrete
// decider directly and tests can swap it out at one import.
//
// 'server-only' — the decider it returns makes TYPESAFE_API_KEY-backed calls
// (playbook S-1). Every failure mode throws a DeciderError with a `kind` the
// engine maps 1:1 onto a FallbackReason (§5.4 "Fallback triggers");
// lib/suggest/engine.ts owns the fallback itself.

import 'server-only';
import { DeciderError, type DeciderErrorKind } from './deciderError';
import { jevDecider } from './jevDecider';
import { deciderProvider } from './models';
import type { Decider } from './types';

export { DeciderError, type DeciderErrorKind };

/** The Jev `Decider` when it is configured — null when it isn't (§5.4
 * fallback triggers: disabled / no key). */
export function activeDecider(): Decider | null {
  return deciderProvider() === 'jev' ? jevDecider : null;
}

export { jevDecider };
