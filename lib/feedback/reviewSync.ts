// Bridges the web feedback page (/feedback/[token]) into the EXISTING reviews
// model (supabase/phase2-migration.sql §7) rather than building a parallel
// rating store. One row per (order_id, menu_item_id) — null menu_item_id is
// the overall-order rating, exactly like POST /api/reviews.
//
// Manual check-then-write instead of `.upsert(..., { onConflict: … })`: a
// standard multi-column UNIQUE constraint treats every NULL as distinct from
// every other NULL, so `unique (order_id, menu_item_id)` does not actually
// stop two overall (menu_item_id IS NULL) rows for the same order — Postgres'
// own semantics, not a bug introduced here. The web page has to support
// EDITING within 7 days (the spec's own requirement), so it cannot rely on a
// conflict target that may not fire for exactly the row shape it uses.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export async function upsertOrderReview(
  admin: Admin,
  params: { orderId: string; menuItemId: string | null; rating: number; comment: string },
): Promise<void> {
  let query = admin.from('reviews').select('id').eq('order_id', params.orderId);
  query = params.menuItemId === null ? query.is('menu_item_id', null) : query.eq('menu_item_id', params.menuItemId);
  const { data: existing } = await query.maybeSingle();

  if (existing) {
    const { error } = await admin
      .from('reviews')
      .update({ rating: params.rating, comment: params.comment })
      .eq('id', existing.id);
    if (error) console.error('upsertOrderReview: update failed', error);
    return;
  }

  const { error } = await admin.from('reviews').insert({
    order_id: params.orderId,
    menu_item_id: params.menuItemId,
    user_id: null, // guest via the feedback-page token link, same as a guest order review
    rating: params.rating,
    comment: params.comment,
  });
  if (error) console.error('upsertOrderReview: insert failed', error);
}
