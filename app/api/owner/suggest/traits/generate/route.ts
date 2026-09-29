import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { MENU_ITEM_SELECT, shapeMenuItem, type MenuItemRow } from '@/lib/orders/lines';
import { deciderProvider } from '@/lib/suggest/models';
import { legacySweetnessFromLevel } from '@/lib/suggest/sweetness';
import { tagMenuItemTraits, withRelatedDescriptions, type MenuItemForTagging, type TagTraitsResult } from '@/lib/suggest/traitsPrompt';
import { classifyTraitsSchemaError, TRAITS_V2_MIGRATION_HINT, type ValidatedTraitRowV2 } from '@/lib/suggest/traitsValidate';
import { CURRENT_TRAITS_VERSION, SWEETNESS_SCALE } from '@/lib/suggest/types';
import type { MenuItem } from '@/lib/types';

export const dynamic = 'force-dynamic';
// Jev's concurrent per-item pool shares a ~50s internal budget; the tagger's
// own timeout sits under this.
export const maxDuration = 60;

// POST /api/owner/suggest/traits/generate — owner-only trait tagging (SUG-2),
// via Jev (lib/suggest/traitsPrompt.ts), and — since Coffey v2 — the owner's
// REGENERATE button (docs/COFFEY-SPEC.md §3.3).
//
// Before the migration (supabase/2026-10-coffey-traits-v2.sql) this answers
// 409 with what to do about it, never a 500: it probes `traits_version` first.
//
// TARGETS are the items that are missing a traits row, OR whose row is
// unconfirmed, OR whose row was tagged before CURRENT_TRAITS_VERSION. That last
// clause is what makes Regenerate work when every row is confirmed (the live
// menu: 95 bulk-confirmed model rows, 22 owner-edited).
//
// WRITE RULES — the v1 AC "confirmed rows are byte-identical after Generate"
// now reads: confirmed rows already at the current version are never written,
// and an owner-edited row never loses an owner-set v1 value:
//   * an OWNER row (source='owner' and confirmed) gets ONLY the v2 columns plus
//     traits_version, through an UPDATE — never an upsert, which could touch
//     its v1 fields. `source`, `confirmed` and updated_at are not written.
//     Its SWEETNESS stays the owner's: Jev's finer 0–10 `sweetness_level` is
//     written only when it agrees with the 0–3 `sweetness` the owner left
//     (legacySweetnessFromLevel(level) === sweetness); when it doesn't, the
//     level is the owner's own value on the 0–10 scale
//     (SWEETNESS_SCALE.legacyToLevel[sweetness]) — the engine reads the level
//     before the legacy column, so writing Jev's would silently override them.
//   * every other target gets the full row upserted: source 'opus' (the
//     schema's label for any model-tagged row), confirmed false,
//     traits_version 2, updated_at now.
//
// RACE GUARD: Jev takes tens of seconds, and the owner may confirm or edit rows
// meanwhile. After tagging, `(confirmed, source, traits_version)` is re-read
// and any row that became confirmed during the run — and wasn't an owner row at
// the first read — is dropped. A row that is (or has just become) an owner row
// still gets the v2-only merge, so a fresh owner edit is never overwritten.
//
// RESUMABLE: everything that didn't finish in the ~50s budget simply stays at
// the old version. Targets are worked in priority order — rows still below the
// current version first, unconfirmed rows already at the current version last —
// so pressing again always continues where the last press stopped instead of
// re-tagging what it just wrote. `remaining` is the targets still below the
// current version after this run.
//
// Rate-limited to 5/hour per owner (this is a paid model call over the
// whole menu) and returns 503 — not a generic 500 — when TYPESAFE_API_KEY is
// not configured, so the owner sees a clear "not set up" message.

const GENERATE_PER_HOUR = 5;
const RATE_WINDOW_SECS = 3600;
/** Owner-row merges are one UPDATE each; run them a few at a time. */
const MERGE_CONCURRENCY = 10;

const BASE_MIGRATION_HINT = 'Apply supabase/2026-09-suggestion-engine.sql and then supabase/2026-10-coffey-traits-v2.sql in Supabase, then press Regenerate again.';

/** What a read of menu_item_traits says about one item. */
interface TraitState {
  confirmed: boolean;
  source: string;
  version: number;
  /** The legacy 0–3 `sweetness` as stored — for an owner row, what the owner
   * set. null if the read didn't carry a usable value. */
  sweetness: number | null;
}

/** The columns both reads (the first, and the race guard's re-read) select. */
const TRAIT_STATE_COLUMNS = 'menu_item_id, confirmed, source, traits_version, sweetness';

function readTraitStates(data: unknown): Map<string, TraitState> {
  const states = new Map<string, TraitState>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    states.set(row.menu_item_id as string, {
      confirmed: row.confirmed === true,
      source: typeof row.source === 'string' ? row.source : '',
      version: typeof row.traits_version === 'number' ? row.traits_version : 1,
      sweetness: typeof row.sweetness === 'number' ? row.sweetness : null,
    });
  }
  return states;
}

const isOwnerRow = (s: TraitState | undefined): boolean => s !== undefined && s.source === 'owner' && s.confirmed;

/** The menu row as Jev is shown it: sizes with prices, and each add-on group's
 * display name with its option names (COFFEY-SPEC §3.2). */
function toTaggingItem(item: MenuItem): MenuItemForTagging {
  return {
    id: item.id,
    name: item.name,
    description: item.description ?? '',
    category: item.category,
    parent_category: item.parent_category ?? '',
    sizes: item.variants.map((v) => ({ label: v.label, price_inr: v.price_inr })),
    customisations: item.addon_groups.map((g) => ({
      group: g.display_name || g.name,
      options: g.options.map((o) => o.name),
    })),
  };
}

/** The 0–10 level an OWNER row gets. Jev's finer level is kept only when it
 * agrees with the 0–3 `sweetness` the owner left on the row; otherwise the
 * owner's value wins, expressed on the 0–10 scale. With no usable owner value
 * (never the case for a stored row: the column is NOT NULL, 0–3) Jev's level
 * stands. */
function ownerSweetnessLevel(jevLevel: number, ownerSweetness: number | null): number {
  if (ownerSweetness === null || !Number.isInteger(ownerSweetness) || ownerSweetness < 0 || ownerSweetness > 3) return jevLevel;
  return legacySweetnessFromLevel(jevLevel) === ownerSweetness ? jevLevel : SWEETNESS_SCALE.legacyToLevel[ownerSweetness as 0 | 1 | 2 | 3];
}

/** The v2 columns only — what an owner-edited row is allowed to receive.
 * `sweetnessLevel` overrides Jev's own (see ownerSweetnessLevel). */
function v2Columns(r: ValidatedTraitRowV2, sweetnessLevel: number = r.sweetness_level) {
  return {
    sweetness_level: sweetnessLevel,
    intensity: r.intensity,
    refreshment: r.refreshment,
    indulgence: r.indulgence,
    novelty: r.novelty,
    textures: r.textures,
    mood_fit: r.mood_fit,
    traits_version: CURRENT_TRAITS_VERSION,
  };
}

export async function POST() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const allowed = await rateLimitOk(`suggest-traits:${owner.id}`, GENERATE_PER_HOUR, RATE_WINDOW_SECS);
  if (!allowed) return errorResponse(429, `Only ${GENERATE_PER_HOUR} trait generations per hour — try again shortly.`);

  if (deciderProvider() === null) {
    return errorResponse(503, 'Set TYPESAFE_API_KEY to turn on Jev trait tagging.');
  }

  const admin = createAdminSupabaseClient();

  // Is the v2 migration applied? A missing column is the expected "not yet"
  // (409, with what to do); anything else is a real failure.
  const probe = await admin.from('menu_item_traits').select('traits_version').limit(1);
  if (probe.error) {
    const problem = classifyTraitsSchemaError(probe.error);
    if (problem === 'missing_column') return errorResponse(409, TRAITS_V2_MIGRATION_HINT);
    if (problem === 'missing_table') return errorResponse(409, BASE_MIGRATION_HINT);
    return errorResponse(500, probe.error.message);
  }

  const [itemsResult, traitsResult] = await Promise.all([
    admin.from('menu_items').select(MENU_ITEM_SELECT),
    admin.from('menu_item_traits').select(TRAIT_STATE_COLUMNS),
  ]);
  if (itemsResult.error) return errorResponse(500, itemsResult.error.message);
  if (traitsResult.error) return errorResponse(500, traitsResult.error.message);

  const before = readTraitStates(traitsResult.data);
  const belowCurrent = (id: string): boolean => {
    const s = before.get(id);
    return !s || s.version < CURRENT_TRAITS_VERSION;
  };

  // The whole menu goes through withRelatedDescriptions — an item borrows the
  // description of another one whether or not that one is being re-tagged.
  const menu = withRelatedDescriptions(
    (itemsResult.data ?? []).map((row) => toTaggingItem(shapeMenuItem(row as unknown as MenuItemRow))),
  );

  // Missing / below the current version first (they are what "N items need
  // Coffey's new taste profile" counts), then the unconfirmed rows that are
  // already current. Menu order within each group.
  const upgrade = menu.filter((i) => belowCurrent(i.id));
  const unconfirmed = menu.filter((i) => !belowCurrent(i.id) && before.get(i.id)?.confirmed !== true);
  const targets = [...upgrade, ...unconfirmed];

  if (targets.length === 0) {
    return NextResponse.json({ tagged: 0, requested: 0, batches: 0, failedBatches: 0, costUsd: 0, needsReview: [], remaining: 0 });
  }

  let result: TagTraitsResult;
  try {
    result = await tagMenuItemTraits(targets);
  } catch (err) {
    return errorResponse(503, err instanceof Error ? err.message : 'Jev trait tagging is unavailable.');
  }

  // Race guard: re-read (confirmed, source, traits_version — and sweetness, for
  // an owner row's merge) now that Jev is done.
  const { data: nowData, error: recheckErr } = await admin.from('menu_item_traits').select(TRAIT_STATE_COLUMNS);
  if (recheckErr) return errorResponse(500, recheckErr.message);
  const after = readTraitStates(nowData);

  const fullRows: ValidatedTraitRowV2[] = [];
  // An owner row is merged with the owner's CURRENT sweetness in hand: the
  // re-read if the row is still there (they may have changed it mid-run), the
  // first read if not.
  const mergeRows: { row: ValidatedTraitRowV2; ownerSweetness: number | null }[] = [];
  for (const row of result.rows) {
    const was = before.get(row.menu_item_id);
    const now = after.get(row.menu_item_id);
    if (isOwnerRow(was)) {
      mergeRows.push({ row, ownerSweetness: (now ?? was)?.sweetness ?? null }); // an owner row: the v2 columns only
    } else if (now?.confirmed === true && was?.confirmed !== true) {
      continue; // became confirmed while Jev was tagging — never overwrite it
    } else if (isOwnerRow(now)) {
      mergeRows.push({ row, ownerSweetness: now?.sweetness ?? null }); // the owner edited it mid-run: keep their v1 fields
    } else {
      fullRows.push(row);
    }
  }

  const stamp = new Date().toISOString();
  if (fullRows.length > 0) {
    const { error: upsertErr } = await admin.from('menu_item_traits').upsert(
      fullRows.map((r) => ({
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
        ...v2Columns(r),
        // 'opus' is the schema's label for any model-tagged row (a CHECK
        // constraint allows only 'opus' | 'owner'); Jev rows use it too.
        source: 'opus',
        confirmed: false,
        updated_at: stamp,
      })),
      { onConflict: 'menu_item_id' },
    );
    if (upsertErr) return errorResponse(500, upsertErr.message);
  }

  for (let i = 0; i < mergeRows.length; i += MERGE_CONCURRENCY) {
    const results = await Promise.all(
      mergeRows
        .slice(i, i + MERGE_CONCURRENCY)
        .map(({ row, ownerSweetness }) =>
          admin
            .from('menu_item_traits')
            .update(v2Columns(row, ownerSweetnessLevel(row.sweetness_level, ownerSweetness)))
            .eq('menu_item_id', row.menu_item_id),
        ),
    );
    const failed = results.find((res) => res.error);
    if (failed?.error) return errorResponse(500, failed.error.message);
  }

  const written = new Set([...fullRows, ...mergeRows.map((m) => m.row)].map((r) => r.menu_item_id));
  const responseBody: Record<string, unknown> = {
    tagged: written.size,
    requested: targets.length,
    batches: result.batches,
    failedBatches: result.failedBatches,
    costUsd: result.usage.costUsdMicros / 1_000_000,
    // §5.1 "Low-confidence review hints" — item names whose
    // traits the owner should double-check before confirming. Always present
    // (possibly empty) so the client never has to guess whether it's missing.
    needsReview: result.needsReview,
    // COFFEY-SPEC §3.3: the targets still below the current version — press
    // Regenerate again until this reads 0.
    remaining: targets.filter((t) => belowCurrent(t.id) && !written.has(t.id)).length,
  };
  // Surface WHY something went wrong (a bad key, a 429 rate limit, an item
  // that never started, …) whenever ANY item failed — not
  // only when NOTHING got tagged — so a partial success ("38 of 40 tagged")
  // still tells the owner what to do about the other 2.
  if (result.firstError) responseBody.error = result.firstError;
  return NextResponse.json(responseBody);
}
