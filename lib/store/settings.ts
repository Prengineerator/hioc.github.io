// Server-side store_settings access (O5). The customer site, staff busy-mode
// controls, and the owner settings UI all read/write the single settings row
// through here. Pure hours/slot/bill math lives in lib/store/hours.ts.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';

/**
 * Reads the singleton store_settings row. Never throws — on any error it
 * returns FALLBACK_STORE_SETTINGS so pricing/open-checks degrade safely
 * instead of hard-failing checkout.
 */
export async function getStoreSettings(): Promise<StoreSettings> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('store_settings')
    .select('*')
    .eq('is_singleton', true)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error('getStoreSettings: falling back to defaults', error);
    return FALLBACK_STORE_SETTINGS;
  }
  return data as StoreSettings;
}

// Columns the settings API is allowed to write (never id/is_singleton).
const WRITABLE_KEYS = [
  'opening_hours',
  'holidays',
  'last_order_cutoff_min',
  'pickup_slot_len_min',
  'pickup_slot_capacity',
  'default_prep_min',
  'busy_buffer_min',
  'accepting_orders',
  'store_open_override',
  'gst_percent',
  'gst_inclusive',
  'packaging_charge_inr',
] as const;

export type StoreSettingsPatch = Partial<Pick<StoreSettings, (typeof WRITABLE_KEYS)[number]>>;

/**
 * Picks only the writable settings keys from an arbitrary object (so a client
 * can't set id/is_singleton/updated_at). Returns the sanitized patch.
 */
export function sanitizeSettingsPatch(body: Record<string, unknown>): StoreSettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of WRITABLE_KEYS) {
    if (key in body) patch[key] = body[key];
  }
  return patch as StoreSettingsPatch;
}

export async function updateStoreSettings(patch: StoreSettingsPatch): Promise<StoreSettings | null> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('store_settings')
    .update(patch)
    .eq('is_singleton', true)
    .select()
    .maybeSingle();

  if (error) {
    console.error('updateStoreSettings failed', error);
    return null;
  }
  return (data as StoreSettings) ?? null;
}
