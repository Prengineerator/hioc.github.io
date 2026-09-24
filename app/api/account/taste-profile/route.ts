import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { flags } from '@/lib/flags';
import { getOrBuildProfile, plainLanguageSummary } from '@/lib/suggest/profileStore';

export const dynamic = 'force-dynamic';

// GET /api/account/taste-profile — the /account "Your taste profile" card
// (§5.5). Signed-in only; the read-through cache does the rest.
export async function GET() {
  if (!flags.suggest) return errorResponse(404, 'Not found');
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { profile, optedOut } = await getOrBuildProfile(user.id);
  return NextResponse.json({
    profile,
    optedOut,
    summary: plainLanguageSummary(profile),
  });
}

// DELETE /api/account/taste-profile — "Reset": deletes the row so it
// recomputes fresh on next read. If the customer had "Don't personalise" on,
// Reset must never silently re-enable personalisation (§5.5) — so an
// opted-out row is immediately re-inserted, empty, still opted out.
export async function DELETE() {
  if (!flags.suggest) return errorResponse(404, 'Not found');
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const admin = createAdminSupabaseClient();

  const { data: existing, error: readError } = await admin
    .from('customer_taste_profiles')
    .select('opted_out')
    .eq('user_id', user.id)
    .maybeSingle();
  if (readError) {
    console.error('taste-profile DELETE: read failed', readError);
    return errorResponse(500, 'Failed to reset your taste profile');
  }
  const wasOptedOut = Boolean(existing?.opted_out);

  const { error: deleteError } = await admin.from('customer_taste_profiles').delete().eq('user_id', user.id);
  if (deleteError) {
    console.error('taste-profile DELETE: delete failed', deleteError);
    return errorResponse(500, 'Failed to reset your taste profile');
  }

  if (wasOptedOut) {
    const { error: reinsertError } = await admin.from('customer_taste_profiles').insert({
      user_id: user.id,
      profile: {},
      order_count: 0,
      computed_at: new Date().toISOString(),
      source_order_at: null,
      opted_out: true,
    });
    if (reinsertError) {
      console.error('taste-profile DELETE: re-insert of opted-out row failed', reinsertError);
      return errorResponse(500, 'Failed to reset your taste profile');
    }
  }

  return NextResponse.json({ success: true });
}

// PATCH /api/account/taste-profile — { optedOut: boolean }, the "Don't
// personalise" toggle. Upsert touches ONLY opted_out — an existing profile
// (or lack of one) is left exactly as-is either way; the engine is what
// treats an opted-out row as `profile: null` (SUG-5 AC).
export async function PATCH(request: Request) {
  if (!flags.suggest) return errorResponse(404, 'Not found');
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body || typeof body.optedOut !== 'boolean') {
    return errorResponse(400, 'optedOut must be a boolean');
  }

  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from('customer_taste_profiles')
    .upsert({ user_id: user.id, opted_out: body.optedOut }, { onConflict: 'user_id' });
  if (error) {
    console.error('taste-profile PATCH failed', error);
    return errorResponse(500, 'Failed to update your preference');
  }

  return NextResponse.json({ success: true, optedOut: body.optedOut });
}
