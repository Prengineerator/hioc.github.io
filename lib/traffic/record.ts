// First-party traffic tracking: writing rows to traffic_events.
//
// Server-only. Every write is best-effort and never throws: a page view or an
// order must never fail because analytics did. Until
// supabase/2026-11-traffic-tracking.sql is applied the inserts fail quietly
// (logged once per server instance, not once per page view).

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { flags } from '@/lib/flags';
import { classifySource, deviceFromUserAgent, isBotUserAgent } from '@/lib/traffic/classify';
import {
  TRACKED_ROUTES,
  type PageGroup,
  type TrackedRoute,
  type TrafficAttribution,
  type TrafficDevice,
  type TrafficEvent,
  type TrafficSource,
} from '@/lib/traffic/types';

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;

/** What the request itself says about the visitor. The IP and User-Agent are read here and dropped. */
export interface TrafficRequestContext {
  device: TrafficDevice;
  /** ISO 3166 alpha-2, from Vercel's edge (x-vercel-ip-country). */
  country: string | null;
  /** City name, from Vercel's edge (x-vercel-ip-city). */
  city: string | null;
  bot: boolean;
}

export function trafficContext(request: Request): TrafficRequestContext {
  const ua = request.headers.get('user-agent');
  const country = (request.headers.get('x-vercel-ip-country') ?? '').trim().toUpperCase();
  let city: string | null = null;
  const rawCity = request.headers.get('x-vercel-ip-city');
  if (rawCity) {
    try {
      city = decodeURIComponent(rawCity);
    } catch {
      city = null;
    }
  }
  city = city ? city.replace(/[^\p{L}\p{M}\p{N} .'()-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) || null : null;
  return {
    device: deviceFromUserAgent(ua),
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    city,
    bot: isBotUserAgent(ua),
  };
}

/** One traffic_events row, as inserted. */
export interface TrafficRow {
  event: TrafficEvent;
  session_id: string;
  page_group: PageGroup;
  route: TrackedRoute;
  landing: boolean;
  source: TrafficSource;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  device: TrafficDevice;
  country: string | null;
  city: string | null;
  order_id: string | null;
  shop_order_id: string | null;
  value_inr: number | null;
}

export function buildTrafficRow(input: {
  event: TrafficEvent;
  attribution: TrafficAttribution;
  route: TrackedRoute;
  landing?: boolean;
  context: TrafficRequestContext;
  orderId?: string | null;
  shopOrderId?: string | null;
  valueInr?: number | null;
}): TrafficRow {
  const { attribution: a, context: c } = input;
  return {
    event: input.event,
    session_id: a.sid,
    page_group: TRACKED_ROUTES[input.route].group,
    route: input.route,
    landing: input.landing === true,
    source: classifySource(a.referrer, a.utm),
    referrer_host: a.referrer,
    utm_source: a.utm.utm_source,
    utm_medium: a.utm.utm_medium,
    utm_campaign: a.utm.utm_campaign,
    utm_content: a.utm.utm_content,
    utm_term: a.utm.utm_term,
    device: c.device,
    country: c.country,
    city: c.city,
    order_id: input.orderId ?? null,
    shop_order_id: input.shopOrderId ?? null,
    value_inr:
      typeof input.valueInr === 'number' && Number.isFinite(input.valueInr) ? Math.max(0, Math.round(input.valueInr)) : null,
  };
}

/** 42P01 from Postgres, PGRST205 from PostgREST: the table isn't there yet. */
export function isMissingTrafficTable(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /traffic_events/.test(error.message ?? '') && /does not exist|could not find the table/i.test(error.message ?? '');
}

let missingTableLogged = false;

/** Insert one row. Never throws. */
export async function insertTrafficRow(admin: AdminClient, row: TrafficRow): Promise<void> {
  try {
    const { error } = await admin.from('traffic_events').insert(row);
    if (!error) return;
    if (isMissingTrafficTable(error)) {
      if (!missingTableLogged) {
        missingTableLogged = true;
        console.warn('traffic: traffic_events is missing — apply supabase/2026-11-traffic-tracking.sql');
      }
      return;
    }
    console.error('traffic: insert failed (best-effort)', error);
  } catch (err) {
    console.error('traffic: insert threw (best-effort)', err);
  }
}

/**
 * The order (or shop order) a tracked visit ended in, written by the checkout
 * route after the order is committed. Skipped when the browser sent no visit
 * (tracking off, a private-browsing opt-out, an old page) or tracking is off.
 * Never throws.
 */
export async function recordTrafficConversion(
  admin: AdminClient,
  args: {
    event: Exclude<TrafficEvent, 'view'>;
    attribution: TrafficAttribution | null;
    route: TrackedRoute;
    context: TrafficRequestContext;
    orderId?: string;
    shopOrderId?: string;
    valueInr: number;
  },
): Promise<void> {
  if (!flags.trafficTracking || !args.attribution) return;
  await insertTrafficRow(
    admin,
    buildTrafficRow({
      event: args.event,
      attribution: args.attribution,
      route: args.route,
      context: args.context,
      orderId: args.orderId ?? null,
      shopOrderId: args.shopOrderId ?? null,
      valueInr: args.valueInr,
    }),
  );
}
