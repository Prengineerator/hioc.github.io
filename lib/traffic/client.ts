'use client';

// First-party traffic tracking, browser side (docs/TRAFFIC-TRACKING.md).
//
// A "visit" lives in sessionStorage: a random id, the linking site's hostname
// and the utm_* tags of the page it started on. It ends when the tab closes or
// after 30 minutes with no tracked page, and a new tagged link or a new linking
// site starts a fresh one. Nothing is kept in localStorage or a cookie, so a
// visitor is never recognised from one visit to the next.
//
// A browser that sends Global Privacy Control or Do Not Track sends nothing.
// Every function here swallows its own errors: tracking must never touch the
// page.

import { cleanUtm, hasUtm, isOwnHost, normalizeHost } from '@/lib/traffic/classify';
import { EMPTY_UTM, UTM_KEYS, type TrackedRoute, type TrafficAttribution, type Utm } from '@/lib/traffic/types';

const STORAGE_KEY = 'hioc.traffic.v1';
const ENDPOINT = '/api/traffic';
const IDLE_MS = 30 * 60 * 1000;

interface StoredVisit extends TrafficAttribution {
  /** Last activity, ms since epoch. */
  at: number;
  /** Tracked pages sent in this visit; the first one is the landing page. */
  views: number;
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '');
    }
  } catch {
    // fall through
  }
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** Global Privacy Control or Do Not Track: the visitor asked not to be tracked. */
export function trackingDeclined(): boolean {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
    if (nav.globalPrivacyControl === true) return true;
    const dnt = nav.doNotTrack ?? nav.msDoNotTrack ?? (window as Window & { doNotTrack?: string }).doNotTrack;
    return dnt === '1' || dnt === 'yes';
  } catch {
    return false;
  }
}

function readStored(): StoredVisit | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredVisit>;
    if (typeof v.sid !== 'string' || typeof v.at !== 'number') return null;
    return {
      sid: v.sid,
      referrer: normalizeHost(v.referrer),
      utm: cleanUtm(v.utm ?? {}),
      at: v.at,
      views: typeof v.views === 'number' ? v.views : 0,
    };
  } catch {
    return null;
  }
}

function writeStored(v: StoredVisit): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    // storage blocked: the visit lives in memory for this page only
  }
}

let memoryVisit: StoredVisit | null = null;

function sameUtm(a: Utm, b: Utm): boolean {
  return UTM_KEYS.every((k) => a[k] === b[k]);
}

/** What this page load itself says: the linking site (outside sites only) and the URL's tags. */
function currentLanding(): { referrer: string | null; utm: Utm } {
  let referrer: string | null = null;
  let utm: Utm = { ...EMPTY_UTM };
  try {
    const host = normalizeHost(document.referrer);
    referrer = host && !isOwnHost(host, window.location.hostname) ? host : null;
    utm = cleanUtm(new URLSearchParams(window.location.search));
  } catch {
    // keep the empties
  }
  return { referrer, utm };
}

/**
 * Called once per page load. Continues the visit in this tab, or starts a new
 * one when there is none, it has gone idle, or this load came from a new
 * tagged link or a new outside site.
 */
export function beginPageLoad(now = Date.now()): StoredVisit {
  const stored = readStored() ?? memoryVisit;
  const here = currentLanding();
  const fresh =
    !stored ||
    now - stored.at > IDLE_MS ||
    (hasUtm(here.utm) && !sameUtm(here.utm, stored.utm)) ||
    (!hasUtm(here.utm) && here.referrer !== null && here.referrer !== stored.referrer);
  const visit: StoredVisit = fresh
    ? { sid: randomId(), referrer: here.referrer, utm: here.utm, at: now, views: 0 }
    : { ...stored, at: now };
  memoryVisit = visit;
  writeStored(visit);
  return visit;
}

function currentVisit(): StoredVisit {
  const v = readStored() ?? memoryVisit;
  if (v && Date.now() - v.at <= IDLE_MS) return v;
  return beginPageLoad();
}

/**
 * The visit, for an order to carry in its `traffic` field (POST /api/orders,
 * POST /api/shop/checkout). Undefined when tracking is off or declined, so the
 * field is left out of the request entirely.
 */
export function getTrafficAttribution(enabled: boolean): Record<string, string | null> | undefined {
  if (!enabled) return undefined;
  try {
    if (trackingDeclined()) return undefined;
    const v = currentVisit();
    return { sid: v.sid, referrer: v.referrer, ...v.utm };
  } catch {
    return undefined;
  }
}

/** Send one page view. Fire-and-forget. */
export function sendTrafficView(route: TrackedRoute): void {
  try {
    if (trackingDeclined()) return;
    const v = currentVisit();
    const landing = v.views === 0;
    const next = { ...v, views: v.views + 1, at: Date.now() };
    memoryVisit = next;
    writeStored(next);
    const body = JSON.stringify({ sid: v.sid, route, landing, referrer: v.referrer, ...v.utm });
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
    }
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // fire-and-forget
    });
  } catch {
    // never let tracking touch the page
  }
}
