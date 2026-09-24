import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { getAnthropicClient } from '@/lib/suggest/anthropic';
import { tagMenuItemTraits, type MenuItemForTagging } from '@/lib/suggest/traitsPrompt';

export const dynamic = 'force-dynamic';
// Opus tagging of ~3 concurrent batches; the tagger's own timeout sits under this.
export const maxDuration = 60;

// POST /api/owner/suggest/traits/generate — owner-only Opus trait tagging
// (SUG-2). Tags only items whose traits row is MISSING or `confirmed=false`
// — a confirmed row is never sent to Opus, so it can never be overwritten,
// which is what the SUG-2 AC ("given 3 confirmed rows, those rows are
// byte-identical afterwards") requires.
//
// Rate-limited to 5/hour per owner (this is a paid LLM call over the whole
// menu) and returns 503 — not a generic 500 — when the API key isn't
// configured, so the owner sees a clear "not set up" message.

const GENERATE_PER_HOUR = 5;
const RATE_WINDOW_SECS = 3600;

export async function POST() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const allowed = await rateLimitOk(`suggest-traits:${owner.id}`, GENERATE_PER_HOUR, RATE_WINDOW_SECS);
  if (!allowed) return errorResponse(429, `Only ${GENERATE_PER_HOUR} trait generations per hour — try again shortly.`);

  if (!getAnthropicClient()) {
    return errorResponse(503, 'The trait tagger is not configured (ANTHROPIC_API_KEY is unset). Ask an admin to set it up.');
  }

  const admin = createAdminSupabaseClient();

  const [itemsResult, traitsResult] = await Promise.all([
    admin.from('menu_items').select('id, name, description, category, parent_category'),
    admin.from('menu_item_traits').select('menu_item_id, confirmed'),
  ]);
  if (itemsResult.error) return errorResponse(500, itemsResult.error.message);
  if (traitsResult.error) return errorResponse(500, traitsResult.error.message);

  const confirmedIds = new Set(
    (traitsResult.data ?? []).filter((t) => t.confirmed === true).map((t) => t.menu_item_id as string),
  );
  const targets: MenuItemForTagging[] = (itemsResult.data ?? [])
    .filter((i) => !confirmedIds.has(i.id as string))
    .map((i) => ({
      id: i.id as string,
      name: i.name as string,
      description: (i.description as string) ?? '',
      category: i.category as string,
      parent_category: i.parent_category as string,
    }));

  if (targets.length === 0) {
    return NextResponse.json({ tagged: 0, requested: 0, batches: 0, failedBatches: 0, costUsd: 0 });
  }

  const result = await tagMenuItemTraits(targets);

  // Re-read confirmations: the owner may have confirmed or edited a row while
  // Opus was thinking (tens of seconds). A confirmed row must never be
  // overwritten, so anything confirmed since the first read is dropped here.
  const { data: nowConfirmed, error: recheckErr } = await admin
    .from('menu_item_traits')
    .select('menu_item_id')
    .eq('confirmed', true);
  if (recheckErr) return errorResponse(500, recheckErr.message);
  const confirmedNow = new Set((nowConfirmed ?? []).map((t) => t.menu_item_id as string));
  const writable = result.rows.filter((r) => !confirmedNow.has(r.menu_item_id));

  if (writable.length > 0) {
    const now = new Date().toISOString();
    const { error: upsertErr } = await admin.from('menu_item_traits').upsert(
      writable.map((r) => ({
        menu_item_id: r.menu_item_id,
        temperature: r.temperature,
        caffeine: r.caffeine,
        is_coffee: r.is_coffee,
        sweetness: r.sweetness,
        body: r.body,
        kind: r.kind,
        moods: r.moods,
        dayparts: r.dayparts,
        flavor_notes: r.flavor_notes,
        source: 'opus',
        confirmed: false,
        updated_at: now,
      })),
      { onConflict: 'menu_item_id' },
    );
    if (upsertErr) return errorResponse(500, upsertErr.message);
  }

  return NextResponse.json({
    tagged: writable.length,
    requested: targets.length,
    batches: result.batches,
    failedBatches: result.failedBatches,
    costUsd: result.usage.costUsdMicros / 1_000_000,
  });
}
