// First-party traffic tracking: turning what a browser tells us into a source.
//
// Pure and client-safe. The browser uses routeForPath() and the host/UTM
// cleaners before sending anything; POST /api/traffic runs the same cleaners
// again (never trusting the browser) and decides the source with
// classifySource().

import {
  EMPTY_UTM,
  TRACKED_ROUTES,
  UTM_KEYS,
  type PageGroup,
  type TrackedRoute,
  type TrafficDevice,
  type TrafficSource,
  type Utm,
} from '@/lib/traffic/types';

const MAX_HOST = 253;
const MAX_UTM = 100;

/** The cafe's own domains. A visit "from" one of these is a visit with no outside source. */
const OWN_HOST = /(^|\.)hioc\.in$/;

/**
 * Map a browser path to the route pattern stored for it, or null for a page
 * that isn't tracked. Ids and tokens never leave the browser: '/t/<token>'
 * becomes '/t/[token]'.
 */
export function routeForPath(pathname: string): { route: TrackedRoute; group: PageGroup } | null {
  const path = (pathname.split(/[?#]/, 1)[0] || '/').replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  let route: TrackedRoute | null = null;

  if (parts.length === 1 && parts[0] === 'menu') route = '/menu';
  else if (parts.length === 1 && parts[0] === 'suggest') route = '/suggest';
  else if (parts.length === 1 && parts[0] === 'coffey') route = '/coffey';
  else if (parts.length === 1 && parts[0] === 'checkout') route = '/checkout';
  else if (parts.length === 1 && parts[0] === 'shop') route = '/shop';
  else if (parts.length === 2 && parts[0] === 't') route = '/t/[token]';
  else if (parts.length === 2 && parts[0] === 'order') route = '/order/[id]';
  else if (parts.length === 3 && parts[0] === 'order' && parts[2] === 'receipt') route = '/order/[id]/receipt';
  else if (parts.length === 3 && parts[0] === 'order' && parts[2] === 'review') route = '/order/[id]/review';
  else if (parts.length === 2 && parts[0] === 'order-confirmation') route = '/order-confirmation/[orderId]';
  else if (parts.length === 2 && parts[0] === 'account' && parts[1] === 'orders') route = '/account/orders';
  else if (parts.length === 3 && parts[0] === 'shop' && parts[1] === 'order') route = '/shop/order/[id]';

  return route ? { route, group: TRACKED_ROUTES[route].group } : null;
}

/**
 * A linking site's hostname, cleaned: lower case, no 'www.', no port. Accepts
 * a full URL ('https://l.instagram.com/?u=…') or a bare host. Android apps
 * report themselves as a package name ('com.google.android.gm'), which passes
 * as a host. Anything else is null.
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  // android-app://com.google.android.gm/ → com.google.android.gm
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(s);
  if (scheme) s = s.slice(scheme[0].length);
  s = s.split(/[/?#]/, 1)[0];
  s = s.replace(/^[^@]*@/, ''); // user:pass@host
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^www\./, '');
  if (s.length === 0 || s.length > MAX_HOST) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s)) return null;
  return s;
}

/** True for the cafe's own sites, which never count as a source. */
export function isOwnHost(host: string | null, currentHost?: string | null): boolean {
  if (!host) return false;
  if (OWN_HOST.test(host)) return true;
  const current = normalizeHost(currentHost ?? '');
  return current !== null && host === current;
}

/**
 * One campaign tag, cleaned: trimmed, lower case, spaces collapsed, at most 100
 * characters, letters (any script)/digits and a few separators only. Empty is null.
 */
export function cleanUtmValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .normalize('NFKC')
    .toLowerCase()
    // \p{M} keeps vowel signs: 'दिवाली' without it would become 'दवल'.
    .replace(/[^\p{L}\p{M}\p{N} _.\-+/:|~]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_UTM)
    .trim();
  return s.length > 0 ? s : null;
}

/** All five tags from an object or URLSearchParams, cleaned. */
export function cleanUtm(raw: unknown): Utm {
  const out: Utm = { ...EMPTY_UTM };
  if (!raw || typeof raw !== 'object') return out;
  const get = (k: string): unknown =>
    raw instanceof URLSearchParams ? raw.get(k) : (raw as Record<string, unknown>)[k];
  for (const key of UTM_KEYS) out[key] = cleanUtmValue(get(key));
  return out;
}

export function hasUtm(utm: Utm): boolean {
  return UTM_KEYS.some((k) => utm[k] !== null);
}

// utm_source values people actually type, mapped to a source.
const UTM_SOURCE_MAP: [RegExp, TrafficSource][] = [
  [/^(instagram|insta|ig)$/, 'instagram'],
  [/^(facebook|fb|meta|messenger)$/, 'facebook'],
  [/^(whatsapp|wa|whatsapp_business|wa_business)$/, 'whatsapp'],
  [/^(google|gmb|gbp|google_maps|googlemaps|maps|google_business|google_ads|adwords)$/, 'google'],
  [/^(email|e-mail|mail|newsletter|gmail)$/, 'email'],
  [/^(qr|qrcode|qr_code|flyer|poster|print|leaflet|pamphlet|menu_card|table|table_card|jar|packaging|sticker|standee|card)$/, 'print'],
  [/^(bing|duckduckgo|yahoo|ecosia|yandex|brave|baidu)$/, 'other_search'],
  [/^(youtube|yt|twitter|x|linkedin|reddit|pinterest|threads|snapchat|telegram|tiktok)$/, 'other_social'],
];

function sourceFromHost(host: string): TrafficSource {
  if (host.includes('whatsapp') || host === 'wa.me') return 'whatsapp';
  if (host.includes('instagram')) return 'instagram';
  if (
    host.includes('facebook') ||
    host === 'fb.com' ||
    host === 'fb.me' ||
    host === 'messenger.com' ||
    host === 'm.me'
  ) {
    return 'facebook';
  }
  if (
    host === 'com.google.android.gm' ||
    host === 'mail.google.com' ||
    /^(mail|webmail|email)\./.test(host) ||
    /(^|\.)outlook\.(com|live\.com|office\.com|office365\.com)$/.test(host) ||
    host === 'outlook.live.com'
  ) {
    return 'email';
  }
  if (/(^|\.)google\.[a-z.]+$/.test(host) || host.startsWith('com.google.')) return 'google';
  if (
    /(^|\.)(bing\.com|duckduckgo\.com|ecosia\.org|baidu\.com|search\.brave\.com)$/.test(host) ||
    /(^|\.)yahoo\.[a-z.]+$/.test(host) ||
    /(^|\.)yandex\.[a-z.]+$/.test(host)
  ) {
    return 'other_search';
  }
  if (
    /(^|\.)(youtube\.com|youtu\.be|t\.co|x\.com|twitter\.com|linkedin\.com|lnkd\.in|reddit\.com|threads\.net|snapchat\.com|t\.me|telegram\.org|tiktok\.com)$/.test(host) ||
    /(^|\.)pinterest\.[a-z.]+$/.test(host)
  ) {
    return 'other_social';
  }
  return 'other_site';
}

/**
 * Where a visit came from. A tagged link (utm_source) wins over the linking
 * site, because the cafe chose that tag on purpose. No linking site, or the
 * cafe's own site, is Direct: WhatsApp messages, QR scans, bookmarks and typed
 * addresses all pass no linking site.
 */
export function classifySource(referrer: string | null, utm: Utm): TrafficSource {
  if (utm.utm_source) {
    for (const [pattern, source] of UTM_SOURCE_MAP) if (pattern.test(utm.utm_source)) return source;
    return 'other_campaign';
  }
  if (!referrer || isOwnHost(referrer)) return 'direct';
  return sourceFromHost(referrer);
}

/** Phone, tablet or computer, from the User-Agent header. Nothing else of it is kept. */
export function deviceFromUserAgent(ua: string | null | undefined): TrafficDevice {
  const s = ua ?? '';
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone|Opera Mini/i.test(s)) return 'mobile';
  return 'desktop';
}

/** Crawlers and link previews that run scripts. Their views are dropped. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  const s = ua ?? '';
  if (!s) return true;
  // 'bot/' and a bare word 'bot', not any 'bot': the CUBOT phone brand is a person.
  return /bot\/|bot;|\bbot\b|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp\/|python-requests|curl\/|wget|httpclient|axios\//i.test(s);
}
