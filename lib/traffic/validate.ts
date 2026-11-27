// First-party traffic tracking: reading what the browser sends.
//
// Pure. POST /api/traffic validates a page view strictly (a bad id or route is
// a 400), while the checkout routes read the `traffic` field of an order
// leniently: anything malformed there is dropped, because an order must never
// fail over an analytics field.

import { cleanUtm, normalizeHost } from '@/lib/traffic/classify';
import { isTrackedRoute, type TrackedRoute, type TrafficAttribution } from '@/lib/traffic/types';

/** The browser's per-visit id: random, URL-safe, 8–64 characters. */
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export interface TrafficViewInput extends TrafficAttribution {
  route: TrackedRoute;
  /** The first tracked page of the visit. */
  landing: boolean;
}

/**
 * Body of POST /api/traffic: { sid, route, landing?, referrer?, utm_source?,
 * utm_medium?, utm_campaign?, utm_content?, utm_term? }. Returns the cleaned
 * view, or an error message for the 400.
 */
export function validateTrafficView(body: Record<string, unknown>): TrafficViewInput | string {
  if (!isSessionId(body.sid)) return 'sid must be 8-64 letters, digits, _ or -';
  if (!isTrackedRoute(body.route)) return 'route is not a tracked page';
  if (body.landing !== undefined && typeof body.landing !== 'boolean') return 'landing must be true or false';
  return {
    sid: body.sid,
    route: body.route,
    landing: body.landing === true,
    referrer: normalizeHost(body.referrer),
    utm: cleanUtm(body),
  };
}

/**
 * The `traffic` field of an order: { sid, referrer?, utm_source?, … }. Null
 * when it is missing or unusable, never an error.
 */
export function parseTrafficAttribution(raw: unknown): TrafficAttribution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isSessionId(r.sid)) return null;
  return { sid: r.sid, referrer: normalizeHost(r.referrer), utm: cleanUtm(r) };
}
