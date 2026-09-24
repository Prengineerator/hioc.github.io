// Phase 7 · SUG-3 — IST daypart classification (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5.1 `dayparts`, §5.3 the `daypart` scoring term, §5.5 `daypartHistogram`).
//
// Boundaries (spec §5.1, this ticket's assignment): IST (Asia/Kolkata)
//   morning   06:00–11:59
//   afternoon 12:00–16:59
//   evening   17:00–20:59
//   late      otherwise (21:00–05:59)
//
// We read the hour via Intl with an explicit IANA zone rather than doing our
// own +05:30 offset arithmetic: India has no DST, but this way the function
// is correct regardless of the server's own timezone (Vercel runs UTC) with
// no manual offset math to get wrong. Pure, dependency-free.

import type { Daypart } from './types';

export function daypartFor(date: Date): Daypart {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  }).format(date);
  // Some ICU builds render midnight as "24" with hour12: false; normalise to 0-23.
  const hour = Number(formatted) % 24;

  if (hour >= 6 && hour <= 11) return 'morning';
  if (hour >= 12 && hour <= 16) return 'afternoon';
  if (hour >= 17 && hour <= 20) return 'evening';
  return 'late';
}
