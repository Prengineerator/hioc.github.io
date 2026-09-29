import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getTraitsOverview } from '@/lib/suggest/queries';
import { legacySweetnessFromLevel } from '@/lib/suggest/sweetness';
import { isMissingColumnError, TRAIT_V2_FIELDS, V2_ONLY_MOODS, validateTraitPatch } from '@/lib/suggest/traitsValidate';
import { SWEETNESS_SCALE } from '@/lib/suggest/types';

export const dynamic = 'force-dynamic';

// Phase 7 · SUG-2 — owner review of Jev-tagged menu traits.
// GET  — every menu item with its traits row (or null) plus the "N
//        unconfirmed / M missing" banner counts and — since Coffey v2 — how many
//        items still need the new taste profile and whether the v2 migration is
//        applied (Traits tab).
// PATCH { id, ...fields } — edits one item's traits. Any content field
//        present makes this an edit: source becomes 'owner' and the row is
//        marked confirmed, per SUG-2's AC ("owner edits caffeine to none →
//        source='owner' and confirmed=true"). With no content field and
//        `confirm: true`, it just confirms the row as Jev tagged it.
//        The fields are the v1 ones AND the Coffey v2 ones (COFFEY-SPEC §3.4:
//        sweetness_level, intensity, refreshment, indulgence, novelty,
//        textures, mood_fit). `traits_version`, `source` and `confirmed` are
//        never patchable — a body that sends them has them ignored.
// PATCH { confirmIds: string[] } — "Confirm all visible": marks existing rows
//        confirmed without touching their content or source.
//
// SWEETNESS stays consistent between its two columns (COFFEY-SPEC §3.1): the
// 0–10 `sweetness_level` is the source of truth and the legacy 0–3 `sweetness`
// is derived from it. So an edit of `sweetness_level` also writes
// `sweetness = legacySweetnessFromLevel(level)`; an edit of only the legacy
// `sweetness` (an older browser tab) also writes
// `sweetness_level = SWEETNESS_SCALE.legacyToLevel[sweetness]` — but only once
// the migration is applied, because before it there is no such column.
//
// Before the migration a v2 field — or one of the two moods its widened CHECK
// adds, 'focus' and 'unwind' — is refused with 409 and what to do about it,
// never a 500.

const MAX_BULK_CONFIRM = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const V2_PENDING_MESSAGE = 'Apply supabase/2026-10-coffey-traits-v2.sql in Supabase, then save again.';

export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const overview = await getTraitsOverview();
  return NextResponse.json(overview);
}

export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const admin = createAdminSupabaseClient();

  // Bulk confirm: { confirmIds: string[] }.
  if (Array.isArray(body.confirmIds)) {
    const ids = body.confirmIds.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id));
    if (ids.length === 0) return errorResponse(400, 'confirmIds must be a non-empty array of item ids');
    if (ids.length > MAX_BULK_CONFIRM) return errorResponse(400, `confirmIds must have ${MAX_BULK_CONFIRM} or fewer ids`);

    const { data, error } = await admin
      .from('menu_item_traits')
      .update({ confirmed: true })
      .in('menu_item_id', ids)
      .select('menu_item_id');
    if (error) return errorResponse(500, error.message);
    return NextResponse.json({ confirmed: (data ?? []).length });
  }

  // Single-row edit/confirm: { id, ...fields, confirm? }.
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id || !UUID_RE.test(id)) return errorResponse(400, 'A valid item id is required');

  const { id: _id, confirm, confirmIds: _confirmIds, ...rest } = body;
  const { patch, error: validationError } = validateTraitPatch(rest);
  if (validationError) return errorResponse(400, validationError);

  const hasContentEdit = Object.keys(patch).length > 0;
  if (!hasContentEdit && confirm !== true) {
    return errorResponse(400, 'Nothing to update — send trait fields to edit, or confirm: true');
  }

  // Is the v2 migration applied? Only asked when this edit needs to know: a v2
  // field (or a v2-only mood) is in the patch (409 if the migration is missing),
  // or the legacy `sweetness` is set alone (its 0–10 twin is only written when
  // it exists).
  const touchesV2 =
    TRAIT_V2_FIELDS.some((field) => field in patch) || (patch.moods ?? []).some((mood) => V2_ONLY_MOODS.includes(mood));
  const legacySweetnessOnly = patch.sweetness !== undefined && patch.sweetness_level === undefined;
  let migrated = true;
  if (touchesV2 || legacySweetnessOnly) {
    const probe = await admin.from('menu_item_traits').select('traits_version').limit(1);
    migrated = !isMissingColumnError(probe.error);
    if (!migrated && touchesV2) return errorResponse(409, V2_PENDING_MESSAGE);
  }

  if (patch.sweetness_level !== undefined) {
    patch.sweetness = legacySweetnessFromLevel(patch.sweetness_level);
  } else if (patch.sweetness !== undefined && migrated) {
    patch.sweetness_level = SWEETNESS_SCALE.legacyToLevel[patch.sweetness];
  }

  const update: Record<string, unknown> = hasContentEdit
    ? { ...patch, source: 'owner', confirmed: true, updated_at: new Date().toISOString() }
    : { confirmed: true };

  const { data, error } = await admin.from('menu_item_traits').update(update).eq('menu_item_id', id).select().maybeSingle();
  if (error) {
    // The migration is missing (or landed, or a stale schema cache lapsed,
    // between the probe and the write) — same answer as above, not a 500.
    if (isMissingColumnError(error)) return errorResponse(409, V2_PENDING_MESSAGE);
    return errorResponse(500, error.message);
  }
  if (!data) return errorResponse(404, 'No traits row for that item yet — generate traits first');

  return NextResponse.json({ traits: data });
}
