// Fetches the rows behind an OrderDataset (lib/reports/exports/orderData.ts) for
// a range of IST days: the orders placed in it with their lines, split payments,
// coupons and refunds, plus the staff names and the GST settings. Paged past
// PostgREST's 1,000-row cap and chunked for `.in()` lists, like reconcileServer.
// Tables and columns that arrived with a later migration are optional: a database
// without them reads what it has (the sheets just show zeros there).

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import { rangeBounds } from '@/lib/reports/reconcile';
import { fetchAll, IN_CHUNK, withColumnTiers, type PageResult } from '@/lib/reports/reconcileServer';
import {
  buildOrderDataset,
  type ItemRow,
  type MenuItemRow,
  type OrderPartRow,
  type OrderRow,
  type RedemptionRow,
  type RefundOrderRow,
  type RefundRow,
} from '@/lib/reports/exports/orderData';
import type { OrderDataset } from '@/lib/reports/exports/types';

const ORDER_COLUMNS =
  'id, order_number, created_at, status, payment_status, payment_method, channel, order_type, table_label, reject_reason, created_by, subtotal_inr, tax_inr, packaging_inr, discount_inr, total_inr';
// Settle discount + tip (2026-09-settle-adjustments.sql), the HIOC Ritual
// columns (2026-10-coffee-pass.sql), then the offer part of the discount
// (2026-10-item-offers.sql): newest first, falling back a migration at a time.
const ORDER_TIERS = [
  `${ORDER_COLUMNS}, settle_discount_inr, tip_inr, order_kind, pass_discount_inr, offer_discount_inr`,
  `${ORDER_COLUMNS}, settle_discount_inr, tip_inr, order_kind, pass_discount_inr`,
  `${ORDER_COLUMNS}, settle_discount_inr, tip_inr`,
  ORDER_COLUMNS,
];

const ITEM_COLUMNS = 'id, order_id, menu_item_id, name_snapshot, variant_label_snapshot, quantity, line_total_inr';
const ITEM_TIERS = [
  `${ITEM_COLUMNS}, gst_exempt, voided, void_reason, pass_drinks, pass_covered_inr, coffee_pass_plan_id, weight_grams, offer_unit_inr`,
  `${ITEM_COLUMNS}, gst_exempt, voided, void_reason, pass_drinks, pass_covered_inr, coffee_pass_plan_id, weight_grams`,
  `${ITEM_COLUMNS}, gst_exempt, voided, void_reason, pass_drinks, pass_covered_inr, coffee_pass_plan_id`,
  `${ITEM_COLUMNS}, gst_exempt, voided, void_reason`,
  `${ITEM_COLUMNS}, voided, void_reason`,
  ITEM_COLUMNS,
];

const REFUND_COLUMNS = 'id, order_id, amount_inr, reason, status, processed_at, created_by, created_at';
const REFUND_TIERS = [`${REFUND_COLUMNS}, method`, REFUND_COLUMNS];

function isMissingRelation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '42P01' || e?.code === 'PGRST205' || /does not exist|could not find the table/i.test(e?.message ?? '');
}

/** An optional table that is not there reads as empty; any other error is real. */
async function orEmptyIfMissing<T>(run: Promise<T[]>): Promise<T[]> {
  try {
    return await run;
  } catch (err) {
    if (isMissingRelation(err)) return [];
    throw err;
  }
}

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) out.push(list.slice(i, i + IN_CHUNK));
  return out;
}

/** Runs `load` over each IN_CHUNK slice of `ids` and joins the results. */
async function inChunks<T>(ids: readonly string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  return (await Promise.all(chunks(ids).map(load))).flat();
}

export async function loadOrderDataset(admin: SupabaseClient, from: string, to: string): Promise<OrderDataset> {
  const { startIso, endIso } = rangeBounds(from, to);

  const [orders, menuItems, rangeRefunds, settings] = await Promise.all([
    withColumnTiers<OrderRow>(ORDER_TIERS, (cols) =>
      fetchAll<OrderRow>((a, b) =>
        admin
          .from('orders')
          .select(cols)
          .gte('created_at', startIso)
          .lt('created_at', endIso)
          .order('order_number')
          .range(a, b) as unknown as PromiseLike<PageResult<OrderRow>>,
      ),
    ),
    withColumnTiers<MenuItemRow>(['id, category, sold_by_weight', 'id, category'], (cols) =>
      fetchAll<MenuItemRow>((a, b) =>
        admin.from('menu_items').select(cols).order('id').range(a, b) as unknown as PromiseLike<PageResult<MenuItemRow>>,
      ),
    ),
    // Refunds dated in the range: processed in it, or (not processed yet) raised in it.
    orEmptyIfMissing(
      withColumnTiers<RefundRow>(REFUND_TIERS, (cols) =>
        fetchAll<RefundRow>((a, b) =>
          admin
            .from('refunds')
            .select(cols)
            .or(
              `and(processed_at.gte.${startIso},processed_at.lt.${endIso}),and(processed_at.is.null,created_at.gte.${startIso},created_at.lt.${endIso})`,
            )
            .order('id')
            .range(a, b) as unknown as PromiseLike<PageResult<RefundRow>>,
        ),
      ),
    ),
    loadGstSettings(admin),
  ]);

  const orderIds = orders.map((o) => o.id);
  const [items, parts, redemptionRows, orderRefunds] = await Promise.all([
    inChunks(orderIds, (chunk) =>
      withColumnTiers<ItemRow>(ITEM_TIERS, (cols) =>
        fetchAll<ItemRow>((a, b) =>
          admin.from('order_items').select(cols).in('order_id', chunk).order('id').range(a, b) as unknown as PromiseLike<PageResult<ItemRow>>,
        ),
      ),
    ),
    orEmptyIfMissing(
      inChunks(orderIds, (chunk) =>
        fetchAll<OrderPartRow>((a, b) =>
          admin
            .from('order_payments')
            .select('order_id, method, created_at')
            .in('order_id', chunk)
            .order('created_at')
            .order('id')
            .range(a, b) as unknown as PromiseLike<PageResult<OrderPartRow>>,
        ),
      ),
    ),
    orEmptyIfMissing(
      inChunks(orderIds, (chunk) =>
        fetchAll<{ order_id: string; coupon_id: string; discount_inr: number }>((a, b) =>
          admin
            .from('coupon_redemptions')
            .select('order_id, coupon_id, discount_inr')
            .in('order_id', chunk)
            .order('id')
            .range(a, b) as unknown as PromiseLike<PageResult<{ order_id: string; coupon_id: string; discount_inr: number }>>,
        ),
      ),
    ),
    orEmptyIfMissing(
      inChunks(orderIds, (chunk) =>
        withColumnTiers<RefundRow>(REFUND_TIERS, (cols) =>
          fetchAll<RefundRow>((a, b) =>
            admin.from('refunds').select(cols).in('order_id', chunk).order('id').range(a, b) as unknown as PromiseLike<PageResult<RefundRow>>,
          ),
        ),
      ),
    ),
  ]);

  // Coupon codes (a second small read rather than an embed, so it never depends on the relationship being exposed).
  const couponIds = [...new Set(redemptionRows.map((r) => r.coupon_id))];
  const codeById = new Map<string, string>();
  const coupons = await orEmptyIfMissing(
    inChunks(couponIds, (chunk) =>
      fetchAll<{ id: string; code: string | null }>((a, b) =>
        admin.from('coupons').select('id, code').in('id', chunk).order('id').range(a, b) as unknown as PromiseLike<
          PageResult<{ id: string; code: string | null }>
        >,
      ),
    ),
  );
  for (const c of coupons) if (c.code) codeById.set(c.id, c.code);
  const redemptions: RedemptionRow[] = redemptionRows.map((r) => ({
    order_id: r.order_id,
    discount_inr: r.discount_inr,
    code: codeById.get(r.coupon_id) ?? null,
  }));

  // A refund in the range can be on a bill from an earlier month: fetch those bills for their invoice number and date.
  const known = new Set(orderIds);
  const refundOrderIds = [...new Set(rangeRefunds.map((r) => r.order_id).filter((id) => !known.has(id)))];
  const refundOrders = await inChunks(refundOrderIds, (chunk) =>
    fetchAll<RefundOrderRow>((a, b) =>
      admin.from('orders').select('id, order_number, created_at').in('id', chunk).order('id').range(a, b) as unknown as PromiseLike<
        PageResult<RefundOrderRow>
      >,
    ),
  );

  const staffIds = [
    ...orders.map((o) => o.created_by),
    ...orderRefunds.map((r) => r.created_by),
    ...rangeRefunds.map((r) => r.created_by),
  ].filter((id): id is string => !!id);
  const staffNames = await getStaffDisplayNames(admin, staffIds);

  return buildOrderDataset({
    from,
    to,
    gstRatePercent: settings.gstRatePercent,
    gstInclusive: settings.gstInclusive,
    orders,
    items,
    menuItems,
    parts,
    redemptions,
    orderRefunds,
    rangeRefunds,
    refundOrders,
    staffNames,
  });
}

/**
 * The store's current GST rate and pricing mode (store_settings, one row). Read
 * here rather than through getStoreSettings(), which swallows errors and falls
 * back to defaults: a filing sheet must fail loudly, not quietly use 5% exclusive.
 */
async function loadGstSettings(admin: SupabaseClient): Promise<{ gstRatePercent: number; gstInclusive: boolean }> {
  const { data, error } = await admin
    .from('store_settings')
    .select('gst_percent, gst_inclusive')
    .eq('is_singleton', true)
    .maybeSingle();
  if (error) throw new Error(`loadOrderDataset: store_settings read failed: ${error.message}`);
  const row = data as { gst_percent: number | null; gst_inclusive: boolean | null } | null;
  return {
    gstRatePercent: row?.gst_percent ?? FALLBACK_STORE_SETTINGS.gst_percent,
    gstInclusive: row?.gst_inclusive ?? FALLBACK_STORE_SETTINGS.gst_inclusive,
  };
}
