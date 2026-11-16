// First-party traffic tracking: the arithmetic behind Owner → Traffic.
//
// Pure, so tests/trafficSummary.test.ts can pin it. lib/traffic/load.ts reads
// the rows; this file turns them into visits, sources, campaigns and orders.
//
// A "visit" is one session_id. Its source, device and place are those of its
// first row, because the browser sends the same visit details with every page
// of a visit. Orders are counted only when the order really went through: a
// cafe order that is not waiting for payment and not rejected or cancelled, a
// Shop order that is paid (lib/traffic/load.ts decides which).

import {
  TRACKED_ROUTES,
  TRAFFIC_SOURCE_LABEL,
  isTrackedRoute,
  type PageGroup,
  type TrafficEvent,
  type TrafficSource,
} from '@/lib/traffic/types';

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60 * 1000;

export const TRAFFIC_RANGES = [7, 30, 90] as const;
export type TrafficRangeDays = (typeof TRAFFIC_RANGES)[number];

export function parseTrafficRange(raw: unknown): TrafficRangeDays {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return (TRAFFIC_RANGES as readonly number[]).includes(n) ? (n as TrafficRangeDays) : 30;
}

/** The calendar day in India for an instant. */
export function istDay(iso: string | number | Date): string {
  const ms = typeof iso === 'number' ? iso : new Date(iso).getTime();
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The last `days` days in India, today included, and the instant the first one began. */
export function trafficRange(days: number, now: Date = new Date()): { sinceDay: string; untilDay: string; sinceIso: string; days: number } {
  const untilDay = istDay(now);
  const untilMidnightUtc = Date.parse(`${untilDay}T00:00:00Z`);
  const sinceDay = new Date(untilMidnightUtc - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const sinceIso = new Date(Date.parse(`${sinceDay}T00:00:00Z`) - IST_OFFSET_MS).toISOString();
  return { sinceDay, untilDay, sinceIso, days };
}

/** A traffic_events row as the loader selects it. */
export interface TrafficEventRow {
  created_at: string;
  event: TrafficEvent;
  session_id: string;
  page_group: PageGroup;
  route: string;
  landing: boolean;
  source: TrafficSource;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  device: string | null;
  country: string | null;
  city: string | null;
  order_id: string | null;
  shop_order_id: string | null;
  value_inr: number | null;
}

export interface CountedOrders {
  /** Cafe orders that went through (not waiting for payment, rejected or cancelled). */
  orderIds: Set<string>;
  /** Shop orders that are paid and not cancelled. */
  shopOrderIds: Set<string>;
}

export interface OrderTally {
  orders: number;
  orderValue: number;
  shopOrders: number;
  shopValue: number;
}

export interface SourceRow extends OrderTally {
  source: TrafficSource;
  label: string;
  visits: number;
  orderingVisits: number;
  shopVisits: number;
}

export interface CampaignRow extends OrderTally {
  key: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  source: TrafficSource;
  visits: number;
}

export interface TrafficSummary extends OrderTally {
  range: { sinceDay: string; untilDay: string; days: number };
  /** The oldest row in the range, so the page can say when tracking began. */
  firstAt: string | null;
  truncated: boolean;
  visits: number;
  orderingVisits: number;
  shopVisits: number;
  pageViews: number;
  sources: SourceRow[];
  campaigns: CampaignRow[];
  referrers: { host: string; source: TrafficSource; visits: number }[];
  pages: { route: string; label: string; group: PageGroup; views: number; visits: number; landings: number }[];
  daily: { day: string; orderingVisits: number; shopVisits: number }[];
  devices: { device: string; visits: number }[];
  places: { country: string | null; city: string | null; visits: number }[];
}

interface Visit {
  first: TrafficEventRow;
  groups: Set<PageGroup>;
  tally: OrderTally;
}

const emptyTally = (): OrderTally => ({ orders: 0, orderValue: 0, shopOrders: 0, shopValue: 0 });

function addTally(into: OrderTally, from: OrderTally): void {
  into.orders += from.orders;
  into.orderValue += from.orderValue;
  into.shopOrders += from.shopOrders;
  into.shopValue += from.shopValue;
}

const byVisitsDesc = <T extends { visits: number }>(a: T, b: T) => b.visits - a.visits;

export function summarizeTraffic(input: {
  rows: TrafficEventRow[];
  counted: CountedOrders;
  range: { sinceDay: string; untilDay: string; days: number };
  truncated?: boolean;
}): TrafficSummary {
  const rows = [...input.rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const visits = new Map<string, Visit>();
  const seenOrders = new Set<string>();
  const seenShopOrders = new Set<string>();
  const pages = new Map<string, { views: number; sessions: Set<string>; landings: number; group: PageGroup }>();
  let pageViews = 0;

  for (const r of rows) {
    let v = visits.get(r.session_id);
    if (!v) {
      v = { first: r, groups: new Set(), tally: emptyTally() };
      visits.set(r.session_id, v);
    }
    v.groups.add(r.page_group);

    if (r.event === 'view') {
      pageViews += 1;
      const p = pages.get(r.route) ?? { views: 0, sessions: new Set<string>(), landings: 0, group: r.page_group };
      p.views += 1;
      p.sessions.add(r.session_id);
      if (r.landing) p.landings += 1;
      pages.set(r.route, p);
    } else if (r.event === 'order' && r.order_id && input.counted.orderIds.has(r.order_id) && !seenOrders.has(r.order_id)) {
      seenOrders.add(r.order_id);
      v.tally.orders += 1;
      v.tally.orderValue += r.value_inr ?? 0;
    } else if (
      r.event === 'shop_order' &&
      r.shop_order_id &&
      input.counted.shopOrderIds.has(r.shop_order_id) &&
      !seenShopOrders.has(r.shop_order_id)
    ) {
      seenShopOrders.add(r.shop_order_id);
      v.tally.shopOrders += 1;
      v.tally.shopValue += r.value_inr ?? 0;
    }
  }

  const totals = emptyTally();
  const sources = new Map<TrafficSource, SourceRow>();
  const campaigns = new Map<string, CampaignRow>();
  const referrers = new Map<string, { host: string; source: TrafficSource; visits: number }>();
  const devices = new Map<string, number>();
  const places = new Map<string, { country: string | null; city: string | null; visits: number }>();
  const daily = new Map<string, { day: string; orderingVisits: number; shopVisits: number }>();
  let orderingVisits = 0;
  let shopVisits = 0;

  // Every day of the range, so a quiet day shows as zero rather than vanishing.
  for (let t = Date.parse(`${input.range.sinceDay}T00:00:00Z`); t <= Date.parse(`${input.range.untilDay}T00:00:00Z`); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    daily.set(day, { day, orderingVisits: 0, shopVisits: 0 });
  }

  for (const v of visits.values()) {
    const f = v.first;
    const ordering = v.groups.has('orders');
    const shop = v.groups.has('shop');
    if (ordering) orderingVisits += 1;
    if (shop) shopVisits += 1;
    addTally(totals, v.tally);

    const s = sources.get(f.source) ?? {
      source: f.source,
      label: TRAFFIC_SOURCE_LABEL[f.source] ?? f.source,
      visits: 0,
      orderingVisits: 0,
      shopVisits: 0,
      ...emptyTally(),
    };
    s.visits += 1;
    if (ordering) s.orderingVisits += 1;
    if (shop) s.shopVisits += 1;
    addTally(s, v.tally);
    sources.set(f.source, s);

    if (f.utm_source || f.utm_medium || f.utm_campaign) {
      const key = [f.utm_source ?? '', f.utm_medium ?? '', f.utm_campaign ?? ''].join('|');
      const c = campaigns.get(key) ?? {
        key,
        utmSource: f.utm_source,
        utmMedium: f.utm_medium,
        utmCampaign: f.utm_campaign,
        source: f.source,
        visits: 0,
        ...emptyTally(),
      };
      c.visits += 1;
      addTally(c, v.tally);
      campaigns.set(key, c);
    }

    if (f.referrer_host) {
      const r = referrers.get(f.referrer_host) ?? { host: f.referrer_host, source: f.source, visits: 0 };
      r.visits += 1;
      referrers.set(f.referrer_host, r);
    }

    const device = f.device ?? 'unknown';
    devices.set(device, (devices.get(device) ?? 0) + 1);

    const placeKey = `${f.country ?? ''}|${f.city ?? ''}`;
    const pl = places.get(placeKey) ?? { country: f.country, city: f.city, visits: 0 };
    pl.visits += 1;
    places.set(placeKey, pl);

    const d = daily.get(istDay(f.created_at));
    if (d) {
      if (ordering) d.orderingVisits += 1;
      if (shop) d.shopVisits += 1;
    }
  }

  const routeOrder = Object.keys(TRACKED_ROUTES);
  return {
    range: input.range,
    firstAt: rows[0]?.created_at ?? null,
    truncated: input.truncated === true,
    visits: visits.size,
    orderingVisits,
    shopVisits,
    pageViews,
    ...totals,
    sources: [...sources.values()].sort((a, b) => b.visits - a.visits || b.orders + b.shopOrders - (a.orders + a.shopOrders)),
    campaigns: [...campaigns.values()].sort((a, b) => b.visits - a.visits || b.orderValue + b.shopValue - (a.orderValue + a.shopValue)),
    referrers: [...referrers.values()].sort(byVisitsDesc),
    pages: [...pages.entries()]
      .map(([route, p]) => ({
        route,
        label: isTrackedRoute(route) ? TRACKED_ROUTES[route].label : route,
        group: p.group,
        views: p.views,
        visits: p.sessions.size,
        landings: p.landings,
      }))
      .sort((a, b) => b.views - a.views || routeOrder.indexOf(a.route) - routeOrder.indexOf(b.route)),
    daily: [...daily.values()],
    devices: [...devices.entries()].map(([device, n]) => ({ device, visits: n })).sort(byVisitsDesc),
    places: [...places.values()].sort(byVisitsDesc),
  };
}

/** Orders per visit (0.04 = 4%), or null when there were no visits. */
export function conversionRate(orders: number, visits: number): number | null {
  return visits > 0 ? orders / visits : null;
}

