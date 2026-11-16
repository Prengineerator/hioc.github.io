// First-party traffic tracking (docs/TRAFFIC-TRACKING.md): the vocabulary.
//
// Pure and client-safe: the tracker in the browser, POST /api/traffic and the
// owner Traffic page all read these lists. supabase/2026-11-traffic-tracking.sql
// pins TRAFFIC_EVENTS, PAGE_GROUPS, TRAFFIC_SOURCES and TRAFFIC_DEVICES in CHECK
// constraints, and tests/trafficMigration.test.ts keeps the two in step. Change
// both together or neither.

/**
 * How long traffic rows are kept: 13 months, so a month can be compared with
 * the same month last year. The privacy policy (app/privacy) states it and
 * /api/cron/purge-traffic enforces it.
 */
export const TRAFFIC_RETENTION_DAYS = 400;

/** One row per page view, or per order placed from a tracked visit. */
export const TRAFFIC_EVENTS = ['view', 'order', 'shop_order'] as const;
export type TrafficEvent = (typeof TRAFFIC_EVENTS)[number];

/** The two groups of pages the owner watches. */
export const PAGE_GROUPS = ['orders', 'shop'] as const;
export type PageGroup = (typeof PAGE_GROUPS)[number];

export const PAGE_GROUP_LABEL: Record<PageGroup, string> = {
  orders: 'Online ordering',
  shop: 'Shop',
};

/**
 * Where a visit came from. Decided once per visit (lib/traffic/classify.ts),
 * from its utm_source tag when the link carried one, else from the linking site.
 */
export const TRAFFIC_SOURCES = [
  'direct',
  'google',
  'instagram',
  'facebook',
  'whatsapp',
  'email',
  'print',
  'other_search',
  'other_social',
  'other_site',
  'other_campaign',
] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

export const TRAFFIC_SOURCE_LABEL: Record<TrafficSource, string> = {
  direct: 'Direct',
  google: 'Google',
  instagram: 'Instagram',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  email: 'Email',
  print: 'QR codes & print',
  other_search: 'Other search',
  other_social: 'Other social',
  other_site: 'Other websites',
  other_campaign: 'Other tagged links',
};

export const TRAFFIC_DEVICES = ['mobile', 'tablet', 'desktop'] as const;
export type TrafficDevice = (typeof TRAFFIC_DEVICES)[number];

export const TRAFFIC_DEVICE_LABEL: Record<TrafficDevice, string> = {
  mobile: 'Phone',
  tablet: 'Tablet',
  desktop: 'Computer',
};

/** The five campaign tags read from a landing URL (?utm_source=…). */
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Record<UtmKey, string | null>;

/**
 * The pages tracked, by route pattern. A route is what gets stored, never the
 * address itself: '/order/[id]' rather than the order's id, '/t/[token]' rather
 * than the table's QR token (which is a secret).
 */
export const TRACKED_ROUTES = {
  '/menu': { group: 'orders', label: 'Menu' },
  '/t/[token]': { group: 'orders', label: 'Table QR order' },
  '/checkout': { group: 'orders', label: 'Checkout' },
  '/order/[id]': { group: 'orders', label: 'Order tracking' },
  '/order/[id]/receipt': { group: 'orders', label: 'Digital bill' },
  '/order/[id]/review': { group: 'orders', label: 'Order review' },
  '/order-confirmation/[orderId]': { group: 'orders', label: 'Order confirmation' },
  '/account/orders': { group: 'orders', label: 'Order history' },
  '/shop': { group: 'shop', label: 'Shop' },
  '/shop/order/[id]': { group: 'shop', label: 'Shop order tracking' },
} as const satisfies Record<string, { group: PageGroup; label: string }>;

export type TrackedRoute = keyof typeof TRACKED_ROUTES;

export function isTrackedRoute(value: unknown): value is TrackedRoute {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRACKED_ROUTES, value);
}

/** Who a visit belongs to, as the browser keeps it for the length of the visit. */
export interface TrafficAttribution {
  /** Random per-visit id. Not stored past the browser tab, never tied to an account. */
  sid: string;
  /** The linking site's hostname only ('l.instagram.com'), or null for none. */
  referrer: string | null;
  utm: Utm;
}

export const EMPTY_UTM: Utm = {
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
};
