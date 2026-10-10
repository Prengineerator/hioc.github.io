import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { addonLabel, deriveAddonTraits, resolveAddonTraits } from '@/lib/suggest/addonTraits';
import type { AddonTraitsGroup, AddonTraitsOption, AddonTraitsOverview } from '@/lib/suggest/addonTraitsUi';
import { isAddonOptionId, validateAddonTraitsPatch } from '@/lib/suggest/addonTraitsValidate';
import { TEXTURES } from '@/lib/suggest/traitVocabulary';
import { classifyTraitsSchemaError, type DbErrorLike } from '@/lib/suggest/traitsValidate';
import { ADDON_ROLES, FLAVOUR_FAMILIES, type AddonRole, type AddonTraits, type FlavourFamily, type Texture } from '@/lib/suggest/types';

export const dynamic = 'force-dynamic';

// Coffey add-ons (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2.3) — the owner's view
// of every add-on option's taste profile, and the overrides of it. Owner →
// Suggestions → Traits → Add-ons.
//
// GET    — every add-on group with its options (both in sort_order). Each option
//          carries its `derived` traits (from the names, lib/suggest/addonTraits.ts),
//          the `traits` Coffey really uses (the owner's override when there is
//          one) and an `overridden` flag. `menuMissing` is true while
//          addon_option_traits does not exist; the derived traits are still
//          returned, so the owner can look before migrating.
// PATCH  { optionId, role, flavour_families, sweetness_delta, intensity_delta,
//          indulgence_delta, textures } — saves one override (an upsert of the
//          whole row; validateAddonTraitsPatch). Answers { option }, the row as
//          GET would now describe it. 404 when the option is not on the menu.
// DELETE ?optionId=<uuid> — "Reset to derived": removes the override. Idempotent:
//          204 whether or not there was one.
//
// All three are owner-only (the guard /api/owner/suggest/traits uses) and, while
// supabase/2026-10-coffey-addons-pairings.sql is not applied, a write answers 409
// with what to do about it — never a 500.

const MIGRATION_MESSAGE = 'Apply supabase/2026-10-coffey-addons-pairings.sql in Supabase, then try again.';

type Row = Record<string, unknown>;
type AdminClient = ReturnType<typeof createAdminSupabaseClient>;

/** True when addon_option_traits is not there to read or write yet. PostgREST
 * reports a missing table as 42P01 / PGRST205; a table created a moment ago
 * that its schema cache has not met yet fails as a missing column (PGRST204) —
 * the same fix, because the migration ends by asking PostgREST to reload. */
function isMissingTable(error: DbErrorLike | null | undefined): boolean {
  const kind = classifyTraitsSchemaError(error);
  return kind === 'missing_table' || kind === 'missing_column';
}

function bySortOrder(a: Row, b: Row): number {
  return (
    (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
    String(a.name ?? '').localeCompare(String(b.name ?? '')) ||
    String(a.id ?? '').localeCompare(String(b.id ?? ''))
  );
}

/** A stored override as AddonTraits, or null for a row too malformed to use (the
 * table's CHECKs make that impossible; this keeps a surprise from reaching the
 * page as an unknown role). */
function rowToTraits(row: Row): AddonTraits | null {
  if (typeof row.role !== 'string' || !(ADDON_ROLES as readonly string[]).includes(row.role)) return null;
  const list = <T extends string>(value: unknown, allowed: readonly string[]): T[] =>
    Array.isArray(value) ? (value.filter((v): v is T => typeof v === 'string' && allowed.includes(v)) as T[]) : [];
  return {
    role: row.role as AddonRole,
    flavour_families: list<FlavourFamily>(row.flavour_families, FLAVOUR_FAMILIES),
    sweetness_delta: Number(row.sweetness_delta) || 0,
    intensity_delta: Number(row.intensity_delta) || 0,
    indulgence_delta: Number(row.indulgence_delta) || 0,
    textures: list<Texture>(row.textures, TEXTURES),
  };
}

function toOption(group: Row | null | undefined, option: Row, overrides: Map<string, AddonTraits>): AddonTraitsOption {
  const groupNames = { name: String(group?.name ?? ''), display_name: String(group?.display_name ?? '') };
  const optionName = { id: String(option.id), name: String(option.name ?? '') };
  return {
    id: optionName.id,
    name: optionName.name,
    price_inr: Number(option.price_inr) || 0,
    is_available: option.is_available !== false,
    label: addonLabel(groupNames, optionName),
    derived: deriveAddonTraits(groupNames, optionName),
    traits: resolveAddonTraits(groupNames, optionName, overrides),
    overridden: overrides.has(optionName.id),
  };
}

export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const admin: AdminClient = createAdminSupabaseClient();
  const [groupsResult, overridesResult] = await Promise.all([
    admin.from('addon_groups').select('*, options:addon_options(*)').order('sort_order', { ascending: true }),
    admin.from('addon_option_traits').select('*'),
  ]);

  if (groupsResult.error) {
    console.error('addon-traits GET: addon_groups failed', groupsResult.error);
    return errorResponse(500, 'Failed to load add-ons');
  }

  let menuMissing = false;
  const overrides = new Map<string, AddonTraits>();
  if (overridesResult.error) {
    if (!isMissingTable(overridesResult.error)) {
      console.error('addon-traits GET: addon_option_traits failed', overridesResult.error);
      return errorResponse(500, 'Failed to load add-on traits');
    }
    menuMissing = true;
  } else {
    for (const row of (overridesResult.data ?? []) as Row[]) {
      const traits = rowToTraits(row);
      if (traits) overrides.set(String(row.option_id), traits);
    }
  }

  const groups: AddonTraitsGroup[] = ((groupsResult.data ?? []) as Row[]).sort(bySortOrder).map((group) => ({
    id: String(group.id),
    name: String(group.name ?? ''),
    display_name: String(group.display_name ?? ''),
    options: [...((group.options ?? []) as Row[])].sort(bySortOrder).map((option) => toOption(group, option, overrides)),
  }));

  const overview: AddonTraitsOverview = { groups, menuMissing };
  return NextResponse.json(overview);
}

export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const parsed = validateAddonTraitsPatch(body);
  if (typeof parsed === 'string') return errorResponse(400, parsed);
  const { optionId, traits } = parsed;

  const admin: AdminClient = createAdminSupabaseClient();

  // The option, with its group (the group's names decide the derived traits).
  const { data: option, error: optionError } = await admin
    .from('addon_options')
    .select('*, addon_group:addon_groups(*)')
    .eq('id', optionId)
    .maybeSingle();
  if (optionError) {
    console.error('addon-traits PATCH: addon_options failed', optionError);
    return errorResponse(500, 'Failed to save add-on traits');
  }
  if (!option) return errorResponse(404, 'That add-on option no longer exists');

  const { error } = await admin.from('addon_option_traits').upsert(
    {
      option_id: optionId,
      role: traits.role,
      flavour_families: traits.flavour_families,
      sweetness_delta: traits.sweetness_delta,
      intensity_delta: traits.intensity_delta,
      indulgence_delta: traits.indulgence_delta,
      textures: traits.textures,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'option_id' },
  );
  if (error) {
    if (isMissingTable(error)) return errorResponse(409, MIGRATION_MESSAGE);
    // The option was deleted between the lookup and the write.
    if (error.code === '23503') return errorResponse(404, 'That add-on option no longer exists');
    console.error('addon-traits PATCH: upsert failed', error);
    return errorResponse(500, 'Failed to save add-on traits');
  }

  const saved = toOption((option as Row).addon_group as Row | null, option as Row, new Map([[optionId, traits]]));
  return NextResponse.json({ option: saved });
}

export async function DELETE(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const optionId = new URL(request.url).searchParams.get('optionId');
  if (!isAddonOptionId(optionId)) return errorResponse(400, 'A valid option id is required');

  const admin: AdminClient = createAdminSupabaseClient();
  const { error } = await admin.from('addon_option_traits').delete().eq('option_id', optionId);
  if (error) {
    if (isMissingTable(error)) return errorResponse(409, MIGRATION_MESSAGE);
    console.error('addon-traits DELETE failed', error);
    return errorResponse(500, 'Failed to reset add-on traits');
  }
  return new NextResponse(null, { status: 204 });
}
