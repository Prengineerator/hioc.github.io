// Reading and writing the Instant Coffee shop tables (service role only).

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { shopOfferFromSettings } from './pricing';
import type { ShopLine, ShopOffer, ShopOrderRow, ShopProduct } from './types';

export const SHOP_MIGRATION_HINT = 'apply supabase/2026-11-instant-coffee-shop.sql first';

/** True when the error is a database without the shop tables yet. */
export function isMissingShopSchema(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const m = (error.message ?? '').toLowerCase();
  return (m.includes('shop_orders') || m.includes('shop_products')) && (m.includes('does not exist') || m.includes('schema cache'));
}

export type ProductsResult = { ok: true; products: ShopProduct[] } | { ok: false; missingSchema: boolean };

/** Every flavour, in stock or not, in the shop's order. */
export async function loadShopProducts(admin: SupabaseClient): Promise<ProductsResult> {
  const { data, error } = await admin
    .from('shop_products')
    .select('id, name, sku, price_inr, net_qty, in_stock, sort_order')
    .order('sort_order', { ascending: true });
  if (error) {
    const missingSchema = isMissingShopSchema(error);
    if (!missingSchema) console.error('shop: could not load products', error);
    return { ok: false, missingSchema };
  }
  return { ok: true, products: (data ?? []) as ShopProduct[] };
}

export interface ShopSettingsRow {
  offer_active: boolean;
  offer_name: string;
  offer_tier_prices: number[];
}

/** The offer settings row, or null (no row, or the shop tables aren't there yet). */
export async function loadShopSettings(admin: SupabaseClient): Promise<ShopSettingsRow | null> {
  const { data, error } = await admin
    .from('shop_settings')
    .select('offer_active, offer_name, offer_tier_prices')
    .eq('is_singleton', true)
    .maybeSingle();
  if (error) {
    if (!isMissingShopSchema(error) && !(error.message ?? '').includes('shop_settings')) {
      console.error('shop: could not load settings', error);
    }
    return null;
  }
  return (data as ShopSettingsRow | null) ?? null;
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
    cancel_reason: typeof raw.cancel_reason === 'string' ? raw.cancel_reason : '',
    address_line2: typeof raw.address_line2 === 'string' ? raw.address_line2 : '',
  };
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
    console.error('shop: order update failed', id, error);
    return null;
  }
  return data ? toShopOrderRow(data as Record<string, unknown>) : null;
}
