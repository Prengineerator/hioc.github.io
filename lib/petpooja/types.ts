// Shared types for the Petpooja history import (lib/petpooja/*). Pure data
// shapes only — no I/O, no Supabase client, so the same file works from the
// CLI importer (scripts/import-petpooja.ts), the POS read-side routes, and
// this module's own tests. See supabase/2026-09-petpooja-history.sql for the
// tables these map onto.

/** A menu item as fetched from menu_items + menu_item_variants (or a
 * `--menu` dry-run JSON file, which omits ids). */
export interface MenuSnapshotItem {
  id?: string; // absent in dry-run snapshots
  name: string;
  variants: { id?: string; label: string }[];
}

/** One line of a legacy bill's `Items` cell, after splitting + menu
 * matching. `menu_item_id`/`variant_id` are null when the ids aren't known
 * (dry run) or the item didn't match; `matched_menu_name` alone tells you
 * whether matching itself succeeded. */
export interface ParsedLegacyItem {
  position: number;
  raw_name: string;
  item_name: string;
  variant_label: string;
  menu_item_id: string | null;
  variant_id: string | null;
  matched_menu_name: string | null; // null = unmatched (works without ids)
}

export interface LegacyPayment {
  method: string;
  amount_inr: number;
}

export interface ParsedLegacyOrder {
  source: 'petpooja';
  bill_no: string;
  fiscal_year: string;
  ordered_at: string; // ISO with offset, e.g. '2026-09-25T23:00:56+05:30'
  client_order_id: string | null;
  order_type: string;
  sub_order_type: string | null;
  channel: 'counter' | 'delivery' | 'zomato' | 'swiggy' | 'qr' | 'dine_in';
  table_label: string;
  customer_name: string;
  customer_phone: string | null;
  customer_phone_raw: string;
  customer_address: string;
  customer_gstin: string;
  items_text: string;
  subtotal_inr: number;
  discount_inr: number;
  delivery_charge_inr: number;
  container_charge_inr: number;
  tax_inr: number;
  round_off_inr: number;
  total_inr: number;
  payment_type: string;
  payments: LegacyPayment[];
  status: 'completed' | 'cancelled';
  raw: Record<string, unknown>;
  items: ParsedLegacyItem[];
}

export interface ParsedLegacyCustomer {
  phone: string;
  name: string;
  email: string;
  date_of_birth: string | null; // 'YYYY-MM-DD'
  date_of_anniversary: string | null; // 'YYYY-MM-DD'
  address: string;
  locality: string;
  gstin: string;
  is_favourite: boolean;
  petpooja_created_on: string | null;
  raw: Record<string, unknown>;
}

/** A count of rows/entries dropped for a given reason, surfaced in the dry
 * run report (never names/phones — `reason` is always a fixed code, not row
 * data). */
export interface SkipCount {
  reason: string;
  count: number;
}
