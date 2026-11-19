// Reading and writing the Instant Coffee shop tables (service role only).

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError, safeDbError } from '@/lib/api/postgrest';
import { shopOfferFromSettings, shopSettingsFromRow } from './pricing';
import { PAID_STATUSES } from './status';
import type { ShopLine, ShopOffer, ShopOrderRow, ShopProduct, ShopProductLine, ShopSettings } from './types';

export const SHOP_MIGRATION_HINT = 'apply supabase/2026-11-instant-coffee-shop.sql first';
/** For what needs the v2 columns, tables and functions (Home Blend, addresses, Beanies, coupons). */
export const SHOP_V2_MIGRATION_HINT = 'apply supabase/2026-11-shop-v2.sql first';

/** True when the error is a database without the shop tables yet. */
export function isMissingShopSchema(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const m = (error.message ?? '').toLowerCase();
  return (m.includes('shop_orders') || m.includes('shop_products')) && (m.includes('does not exist') || m.includes('schema cache'));
}

/** True when a table (any table) is not there yet. */
function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message ?? '');
}

export type ProductsResult = { ok: true; products: ShopProduct[] } | { ok: false; missingSchema: boolean };

const PRODUCT_V1_COLUMNS = 'id, name, sku, price_inr, net_qty, in_stock, sort_order';
const PRODUCT_V2_COLUMNS = `${PRODUCT_V1_COLUMNS}, line, display_name, pack_grams, ship_weight_kg, listed, requires_grind, description`;

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** A shop_products row, v1 or v2, → the typed product. Missing v2 columns take the v1 meaning (an instant jar). Numeric strings become numbers. */
export function toShopProduct(raw: Record<string, unknown>): ShopProduct {
  const name = String(raw.name ?? '');
  return {
    id: String(raw.id),
    name,
    sku: String(raw.sku ?? ''),
    price_inr: num(raw.price_inr, 0),
    net_qty: String(raw.net_qty ?? ''),
    in_stock: raw.in_stock === true,
    sort_order: num(raw.sort_order, 0),
    line: (raw.line === 'home_blend' ? 'home_blend' : 'instant') as ShopProductLine,
    display_name: typeof raw.display_name === 'string' && raw.display_name ? raw.display_name : name,
    pack_grams: num(raw.pack_grams, 50),
    ship_weight_kg: num(raw.ship_weight_kg, 0.3),
    listed: raw.listed === false ? false : true,
    requires_grind: raw.requires_grind === true,
    description: typeof raw.description === 'string' ? raw.description : '',
  };
}

/** Every flavour, in stock or not, in the shop's order. Falls back to the v1 columns before the v2 migration is applied. */
export async function loadShopProducts(admin: SupabaseClient): Promise<ProductsResult> {
  const read = (cols: string): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> =>
    admin.from('shop_products').select(cols).order('sort_order', { ascending: true });
  let { data, error } = await read(PRODUCT_V2_COLUMNS);
  if (error && isMissingColumnError(error)) ({ data, error } = await read(PRODUCT_V1_COLUMNS));
  if (error) {
    const missingSchema = isMissingShopSchema(error);
    if (!missingSchema) console.error('shop: could not load products', error);
    return { ok: false, missingSchema };
  }
  return { ok: true, products: ((data ?? []) as Record<string, unknown>[]).map(toShopProduct) };
}

export interface ShopSettingsRow {
  offer_active: boolean;
  offer_name: string;
  offer_tier_prices: number[];
  // v2 columns: absent before supabase/2026-11-shop-v2.sql is applied.
  shipping_fee_inr?: number;
  free_shipping_min_inr?: number;
  beanies_max_redeem_pct?: number;
}

const SETTINGS_V1_COLUMNS = 'offer_active, offer_name, offer_tier_prices';
const SETTINGS_V2_COLUMNS = `${SETTINGS_V1_COLUMNS}, shipping_fee_inr, free_shipping_min_inr, beanies_max_redeem_pct`;

/** The offer settings row, or null (no row, or the shop tables aren't there yet). */
export async function loadShopSettings(admin: SupabaseClient): Promise<ShopSettingsRow | null> {
  const read = (cols: string) => admin.from('shop_settings').select(cols).eq('is_singleton', true).maybeSingle();
  let { data, error } = await read(SETTINGS_V2_COLUMNS);
  if (error && isMissingColumnError(error)) ({ data, error } = await read(SETTINGS_V1_COLUMNS));
  if (error) {
    if (!isMissingShopSchema(error) && !(error.message ?? '').includes('shop_settings')) {
      console.error('shop: could not load settings', error);
    }
    return null;
  }
  return (data as unknown as ShopSettingsRow | null) ?? null;
}

/** The pricing settings (offer, shipping, Beanies cap), defaults for whatever the row lacks. */
export async function loadShopPricingSettings(admin: SupabaseClient): Promise<ShopSettings> {
  const row = await loadShopSettings(admin);
  return shopSettingsFromRow(row as unknown as Record<string, unknown> | null);
}

export interface IntroBuyer {
  userId: string | null;
  /** +91XXXXXXXXXX */
  phone: string | null;
  email: string | null;
}

/**
 * May this customer still have the introductory offer (once per customer)? False
 * when shop_intro_claims has a row for their account, phone or email. Before the
 * v2 table exists the shop's own paid orders with the offer stand in. A read
 * failure answers true and logs: it never blocks a sale, and capture flags a
 * reuse (claim_shop_intro_offer) so the owner sees it.
 */
export async function isIntroOfferEligible(admin: SupabaseClient, who: IntroBuyer): Promise<boolean> {
  const email = who.email ? who.email.trim().toLowerCase() : null;
  const keys: { col: string; val: string }[] = [];
  if (who.userId) keys.push({ col: 'user_id', val: who.userId });
  if (who.phone) keys.push({ col: 'phone', val: who.phone });
  if (email) keys.push({ col: 'email', val: email });
  if (keys.length === 0) return true;

  try {
    const claims = await Promise.all(keys.map((k) => admin.from('shop_intro_claims').select('shop_order_id').eq(k.col, k.val).limit(1)));
    const failed = claims.find((r) => r.error);
    if (!failed) return !claims.some((r) => (r.data ?? []).length > 0);
    if (!isMissingTable(failed.error)) {
      console.error('shop: intro claim lookup failed', failed.error);
      return true;
    }
  } catch (err) {
    console.error('shop: intro claim lookup failed', err);
    return true;
  }

  // No shop_intro_claims yet: look at paid orders that took the offer.
  try {
    const orders = await Promise.all(
      keys.map((k) =>
        admin
          .from('shop_orders')
          .select('id')
          .eq(k.col === 'email' ? 'email' : k.col, k.val)
          .eq('intro_offer_applied', true)
          .in('status', [...PAID_STATUSES])
          .limit(1),
      ),
    );
    const failed = orders.find((r) => r.error);
    if (failed) {
      if (!isMissingTable(failed.error) && !isMissingColumnError(failed.error)) console.error('shop: intro order lookup failed', failed.error);
      return true; // v1 behaviour
    }
    return !orders.some((r) => (r.data ?? []).length > 0);
  } catch (err) {
    console.error('shop: intro order lookup failed', err);
    return true;
  }
}

/**
 * Has this account bought before, at the café (a paid order) or in the shop (a
 * paid-onward order)? Beanies can be spent only by repeat customers. Any
 * failure answers false: the discount is withheld, never given by mistake.
 */
export async function isRepeatCustomer(admin: SupabaseClient, userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const cafe = await admin.from('orders').select('id').eq('payment_status', 'paid').eq('user_id', userId).limit(1);
    if (!cafe.error && (cafe.data ?? []).length > 0) return true;
    if (cafe.error) console.error('shop: repeat check (café orders) failed', cafe.error);

    // Counter orders a staffer linked to the account; the column may not exist yet.
    const linked = await admin.from('orders').select('id').eq('payment_status', 'paid').eq('customer_user_id', userId).limit(1);
    if (!linked.error && (linked.data ?? []).length > 0) return true;
    if (linked.error && !isMissingColumnError(linked.error)) console.error('shop: repeat check (linked orders) failed', linked.error);

    const shop = await admin.from('shop_orders').select('id').eq('user_id', userId).in('status', [...PAID_STATUSES]).limit(1);
    if (shop.error) {
      if (!isMissingShopSchema(shop.error)) console.error('shop: repeat check (shop orders) failed', shop.error);
      return false;
    }
    return (shop.data ?? []).length > 0;
  } catch (err) {
    console.error('shop: repeat check failed', err);
    return false;
  }
}

/** The live online offer, or null (switched off, or no settings). */
export async function loadShopOffer(admin: SupabaseClient): Promise<ShopOffer | null> {
  return shopOfferFromSettings(await loadShopSettings(admin));
}

/** A row as stored → the typed shape (lines from jsonb, numbers as numbers). */
export function toShopOrderRow(raw: Record<string, unknown>): ShopOrderRow {
  const lines = Array.isArray(raw.lines) ? (raw.lines as ShopLine[]) : [];
  return {
    ...(raw as unknown as ShopOrderRow),
    order_number: Number(raw.order_number),
    lines,
    jar_count: Number(raw.jar_count),
    subtotal_inr: Number(raw.subtotal_inr),
    discount_inr: Number(raw.discount_inr ?? 0),
    offer_name: typeof raw.offer_name === 'string' && raw.offer_name ? raw.offer_name : null,
    shipping_inr: Number(raw.shipping_inr),
    total_inr: Number(raw.total_inr),
    shiprocket_total_inr:
      raw.shiprocket_total_inr === null || raw.shiprocket_total_inr === undefined || raw.shiprocket_total_inr === ''
        ? null
        : Number.isFinite(Number(raw.shiprocket_total_inr))
          ? Number(raw.shiprocket_total_inr)
          : null,
    cancel_reason: typeof raw.cancel_reason === 'string' ? raw.cancel_reason : '',
    address_line2: typeof raw.address_line2 === 'string' ? raw.address_line2 : '',
    // v2 columns: absent on rows read before the v2 migration is applied.
    landmark: typeof raw.landmark === 'string' ? raw.landmark : '',
    offer_discount_inr: Number(raw.offer_discount_inr ?? 0) || 0,
    coupon_id: typeof raw.coupon_id === 'string' && raw.coupon_id ? raw.coupon_id : null,
    coupon_code: typeof raw.coupon_code === 'string' && raw.coupon_code ? raw.coupon_code : null,
    coupon_discount_inr: Number(raw.coupon_discount_inr ?? 0) || 0,
    beanies_redeemed: Number(raw.beanies_redeemed ?? 0) || 0,
    beanies_discount_inr: Number(raw.beanies_discount_inr ?? 0) || 0,
    intro_offer_applied: raw.intro_offer_applied === true,
    intro_offer_reused: raw.intro_offer_reused === true,
    goods_weight_kg:
      raw.goods_weight_kg === null || raw.goods_weight_kg === undefined || raw.goods_weight_kg === ''
        ? null
        : Number.isFinite(Number(raw.goods_weight_kg))
          ? Number(raw.goods_weight_kg)
          : null,
    idempotency_key: typeof raw.idempotency_key === 'string' && raw.idempotency_key ? raw.idempotency_key : null,
    checkout_fingerprint:
      typeof raw.checkout_fingerprint === 'string' && raw.checkout_fingerprint ? raw.checkout_fingerprint : null,
    save_address_label:
      typeof raw.save_address_label === 'string' && raw.save_address_label ? raw.save_address_label : null,
    customer_address_id:
      typeof raw.customer_address_id === 'string' && raw.customer_address_id ? raw.customer_address_id : null,
    capture_effects_at:
      typeof raw.capture_effects_at === 'string' && raw.capture_effects_at ? raw.capture_effects_at : null,
    // Owner-order columns: absent before supabase/2026-11-shop-owner-orders.sql (read as a website order).
    source: raw.source === 'owner' ? 'owner' : 'web',
    created_by: typeof raw.created_by === 'string' && raw.created_by ? raw.created_by : null,
    payment_channel: raw.payment_channel === 'payment_link' || raw.payment_channel === 'offline' ? raw.payment_channel : 'checkout',
    offline_method:
      raw.offline_method === 'upi_direct' || raw.offline_method === 'cash' || raw.offline_method === 'bank_transfer'
        ? raw.offline_method
        : null,
    payment_reference: typeof raw.payment_reference === 'string' && raw.payment_reference ? raw.payment_reference : null,
    owner_discount_inr: Number(raw.owner_discount_inr ?? 0) || 0,
    owner_discount_reason:
      typeof raw.owner_discount_reason === 'string' && raw.owner_discount_reason ? raw.owner_discount_reason : null,
    razorpay_payment_link_id:
      typeof raw.razorpay_payment_link_id === 'string' && raw.razorpay_payment_link_id ? raw.razorpay_payment_link_id : null,
    payment_link_url: typeof raw.payment_link_url === 'string' && raw.payment_link_url ? raw.payment_link_url : null,
    payment_link_expires_at:
      typeof raw.payment_link_expires_at === 'string' && raw.payment_link_expires_at ? raw.payment_link_expires_at : null,
  };
}

/** The order a checkout's Idempotency-Key opened, if any (null when none, or the column isn't there yet). */
export async function findShopOrderByIdempotencyKey(admin: SupabaseClient, key: string): Promise<ShopOrderRow | null> {
  const { data, error } = await admin.from('shop_orders').select('*').eq('idempotency_key', key).maybeSingle();
  if (error) {
    if (!isMissingColumnError(error) && !isMissingShopSchema(error)) console.error('shop: idempotency lookup failed', error);
    return null;
  }
  return data ? toShopOrderRow(data as Record<string, unknown>) : null;
}

export type OrderLookup = { ok: true; order: ShopOrderRow | null } | { ok: false; missingSchema: boolean };

export async function getShopOrder(admin: SupabaseClient, id: string): Promise<OrderLookup> {
  const { data, error } = await admin.from('shop_orders').select('*').eq('id', id).maybeSingle();
  if (error) {
    const missingSchema = isMissingShopSchema(error);
    if (!missingSchema) console.error('shop: could not load order', id, error);
    return { ok: false, missingSchema };
  }
  return { ok: true, order: data ? toShopOrderRow(data as Record<string, unknown>) : null };
}

/**
 * Updates an order only if it is still in one of `fromStatuses` (so two
 * clicks, or the owner racing a webhook, can't both act). Returns the updated
 * row, or null when nothing matched (it moved on) or the write failed.
 */
export async function updateShopOrderIf(
  admin: SupabaseClient,
  id: string,
  fromStatuses: readonly string[],
  patch: Record<string, unknown>,
): Promise<ShopOrderRow | null> {
  const { data, error } = await admin
    .from('shop_orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', [...fromStatuses])
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('shop: order update failed', id, safeDbError(error));
    return null;
  }
  return data ? toShopOrderRow(data as Record<string, unknown>) : null;
}

/**
 * Saves Shiprocket's order total on the order, on its own so a failure here
 * never undoes a send or a refresh. Returns the order with the total on it,
 * or the order as it was when the write didn't go through (logged, except
 * before supabase/2026-11-shop-shiprocket-total.sql is applied).
 */
export async function saveShiprocketTotal(admin: SupabaseClient, order: ShopOrderRow, total: number): Promise<ShopOrderRow> {
  const { error } = await admin.from('shop_orders').update({ shiprocket_total_inr: total }).eq('id', order.id);
  if (error) {
    const m = (error.message ?? '').toLowerCase();
    const missingColumn = error.code === '42703' || error.code === 'PGRST204' || m.includes('shiprocket_total_inr');
    if (!missingColumn) console.error('shop: could not save the Shiprocket total', order.id, error);
    return order;
  }
  return { ...order, shiprocket_total_inr: total };
}
