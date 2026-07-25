import 'server-only';

import { createAdminSupabaseClient } from '@/lib/supabase-server';

// The minimal, safe projection of a table handed to the QR client — id + label
// only. The `qr_token` itself NEVER leaves the server (§5.2 / lib/types.ts
// Table note): the scanned token is the proof of table presence and is matched
// here with the service-role client, then discarded from the client payload.
export interface ResolvedQrTable {
  id: string;
  label: string;
}

/**
 * Resolve a scanned `/t/<qr_token>` to its ACTIVE table (QR-1), server-side
 * only. Uses the service-role client because RLS deliberately hides `qr_token`
 * from public reads — the token can only be matched here. Returns `null` for an
 * unknown, inactive, or regenerated token so the caller can show a friendly
 * "ask staff" screen instead of ever rendering a broken cart.
 */
export async function resolveTableByToken(token: string): Promise<ResolvedQrTable | null> {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed) return null;

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('tables')
    .select('id, label, is_active')
    .eq('qr_token', trimmed)
    .maybeSingle();

  if (error || !data || !data.is_active) return null;
  return { id: data.id as string, label: data.label as string };
}
