// GEO-2 — tamper signals.
//
// These FLAG, they never block. That is a deliberate product decision, not
// timidity: every signal here has an innocent explanation, and blocking an
// honest staffer from clocking in is a worse failure than letting a suspicious
// punch through for the owner to look at. A geofence that occasionally refuses
// real people gets worked around within a week, and then it protects nothing.
//
// What these can honestly claim: a mock location tends to be *too clean*. Real
// GPS jitters by metres between readings, its accuracy wanders, and a person
// cannot be in two places at once. A pinned coordinate does none of that. One
// flagged punch means little; a pattern of them is worth a conversation.

import { haversineMetres } from '@/lib/attendance/geofence';
import type { AttendanceFlag } from '@/lib/types';

export interface PriorPunch {
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  atMs: number;
}

export interface IntegrityInput {
  lat: number;
  lng: number;
  accuracyM: number;
  atMs: number;
  /** The staffer's most recent prior punch, if any. */
  prior: PriorPunch | null;
}

/**
 * Faster than any ground transport a cafe staffer is plausibly using, with
 * enough headroom that a genuinely fast trip never trips it. If two punches
 * imply more than this, at least one of the positions is wrong.
 */
const IMPOSSIBLE_SPEED_KMH = 900;

/**
 * Real consumer GPS essentially never repeats a coordinate to full precision
 * between separate fixes — the last decimal places wander even sitting still.
 * Byte-identical repeats point at a pinned mock provider.
 *
 * The honest caveat, which the owner-facing UI must carry: two staff sharing
 * one phone produce plausibly-identical coordinates too. This flag is a prompt
 * to look, never an accusation.
 */
const STATIC_COORD_EPSILON = 1e-7;

export function detectIntegrityFlags(input: IntegrityInput): AttendanceFlag[] {
  const flags: AttendanceFlag[] = [];
  const { prior } = input;
  if (!prior || prior.lat === null || prior.lng === null) return flags;

  const identical =
    Math.abs(prior.lat - input.lat) < STATIC_COORD_EPSILON &&
    Math.abs(prior.lng - input.lng) < STATIC_COORD_EPSILON;
  if (identical) flags.push('static_coords');

  const elapsedMs = input.atMs - prior.atMs;
  if (elapsedMs > 0 && !identical) {
    const metres = haversineMetres(prior.lat, prior.lng, input.lat, input.lng);
    const kmh = metres / 1000 / (elapsedMs / 3_600_000);
    if (kmh > IMPOSSIBLE_SPEED_KMH) flags.push('impossible_travel');
  }

  return flags;
}
