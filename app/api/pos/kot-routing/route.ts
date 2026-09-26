import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { normalizeKotRouting, readKotRouting } from '@/lib/print/kotRouting';

export const dynamic = 'force-dynamic';

// KOT counters (lib/print/kotRouting.ts, supabase/2026-09-kot-counters.sql) —
// which counter prepares which menu categories.
//
// GET: anyone signed in at the counter, so every staffer can SEE where each
// category's slip goes. PUT: managers and owners only — a cashier rerouting
// the kitchen mid-shift is exactly the accident this guards against. Both use
// the device-aware actor (a PIN operator on an enrolled POS counts), and the
// write goes through normalizeKotRouting(), never straight from the body.

function canEdit(role: string): boolean {
  return role === 'manager' || role === 'owner';
}

/** Menu categories in menu order (first appearance by sort_order, then name). */
async function menuCategories(admin: ReturnType<typeof createAdminSupabaseClient>): Promise<string[] | null> {
  const { data, error } = await admin
    .from('menu_items')
    .select('category, sort_order')
    .order('sort_order', { ascending: true })
    .order('category', { ascending: true });
  if (error) {
    console.error('GET /api/pos/kot-routing: menu categories failed', error);
    return null;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of (data ?? []) as { category: string }[]) {
    if (row.category && !seen.has(row.category)) {
      seen.add(row.category);
      out.push(row.category);
    }
  }
  return out;
}

export async function GET() {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const admin = createAdminSupabaseClient();
  const [settings, categories] = await Promise.all([
    admin.from('store_settings').select('kot_routing').eq('is_singleton', true).maybeSingle(),
    menuCategories(admin),
  ]);
  if (settings.error && !isMissingColumnError(settings.error)) {
    console.error('GET /api/pos/kot-routing: store_settings read failed', settings.error);
    return errorResponse(500, 'Could not load the KOT counters');
  }
  if (!categories) return errorResponse(500, 'Could not load the menu categories');

  return NextResponse.json(
    {
      routing: readKotRouting((settings.data as { kot_routing?: unknown } | null)?.kot_routing),
      categories,
      canEdit: canEdit(actor.role),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function PUT(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  if (!canEdit(actor.role)) return errorResponse(403, 'Only a manager or the owner can change KOT counters');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const result = normalizeKotRouting(body);
  if (!result.ok) return errorResponse(400, result.error);

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('store_settings')
    .update({ kot_routing: result.routing })
    .eq('is_singleton', true)
    .select('kot_routing')
    .maybeSingle();
  if (error || !data) {
    console.error('PUT /api/pos/kot-routing: update failed', error);
    return errorResponse(
      500,
      isMissingColumnError(error)
        ? 'Could not save — is supabase/2026-09-kot-counters.sql applied?'
        : 'Could not save the KOT counters',
    );
  }

  return NextResponse.json({ routing: readKotRouting((data as { kot_routing: unknown }).kot_routing) });
}
