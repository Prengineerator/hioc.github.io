// Loads the rows behind a period's GST working and builds it. The page, the CA's
// Excel workbook and the GST CSVs all call this, so every view shows the same
// figures (lib/reports/exports/gstComputation.ts holds the rules).

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BUSINESS } from '@/lib/legal';
import { loadOrderDataset } from '@/lib/reports/exports/orderDataServer';
import { buildGstComputation, businessFromLegal } from '@/lib/reports/exports/gstComputation';
import type { GstComputation } from '@/lib/reports/exports/gstTypes';

/** The GST working for IST days from..to (inclusive, YYYY-MM-DD). */
export async function loadGstComputation(admin: SupabaseClient, from: string, to: string): Promise<GstComputation> {
  const ds = await loadOrderDataset(admin, from, to);
  return buildGstComputation(ds, { business: businessFromLegal(BUSINESS), now: new Date() });
}
