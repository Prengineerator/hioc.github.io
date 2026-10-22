// Add-on group writes (2026-10-addon-change-requests.sql), the add-on sibling of
// lib/menu/applyMenuChange.ts: validating the add-on form, reading a group's
// current values, working out what a proposal changes, and writing a create or
// an edit. Three callers share them, as for menu items:
//   - the staff add-on routes (app/api/addon-groups/**) when the owner edits
//     from the POS;
//   - the same routes storing a staff member's or manager's change as a request;
//   - the owner approving that request (lib/menu/changeRequests.ts), which
//     replays the stored payload through the same validator and writers.
// Nothing here checks who is asking: the route does that first.
//
// Options are edited IN PLACE by id and never deleted: past orders
// (order_item_addons), stock recipes (addon_recipe_lines) and Coffey traits all
// point at an option's id, so replacing the list the way menu sizes are replaced
// would quietly cut those links. An option the café stops offering is switched
// off (POS → Menu → On / off).

import type { SupabaseClient } from '@supabase/supabase-js';
import { isUuid } from '@/lib/api/constants';
import { failure, type Failure, type Outcome } from '@/lib/menu/applyMenuChange';
import type {
  AddonGroupChangePayload,
  AddonGroupChangeRequest,
  AddonOptionChange,
  AddonSelection,
} from '@/lib/menu/changeRequestTypes';
import type { AddonGroup } from '@/lib/types';
import { ADDON_NAME_MAX, ADDON_OPTIONS_MAX, ADDON_PRICE_MAX } from '@/lib/menu/addonLimits';

type Admin = SupabaseClient;

export const ADDON_GROUP_GONE_MESSAGE =
  'This add-on group no longer exists, so the change cannot be applied. Reject the request to clear it.';

export const ADDON_CHANGE_MIGRATION_HINT =
  'Add-on approvals are not set up yet — run supabase/2026-10-addon-change-requests.sql, then try again.';

const GROUP_SELECT = '*, options:addon_options(*)';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** An add-on group as the form submits it, checked. Every field is present. */
export interface AddonGroupValues {
  display_name: string;
  selection_type: AddonSelection;
  min_select: number;
  max_select: number;
  options: AddonOptionChange[];
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Checks the add-on form's values. The rules a customer depends on:
 *  - a name, and 1–30 options, each with a name (unique in the group, any case)
 *    and a whole-rupee price from 0;
 *  - "pick one" allows at most one (min 0 = optional, 1 = required);
 *  - "pick several" has 0 ≤ min ≤ max, max ≥ 1, and max no more than the
 *    options there are (min more than that would make every item using the
 *    group impossible to order);
 *  - an option's `id`, when given, is a uuid and appears once. Whether it
 *    belongs to THIS group is for the caller, who knows the group.
 */
export function validateAddonGroupBody(body: Record<string, unknown>): Outcome<AddonGroupValues> {
  const { display_name, selection_type, min_select, max_select, options } = body;

  if (typeof display_name !== 'string' || display_name.trim() === '') {
    return failure(400, 'Give the add-on group a name.');
  }
  if (display_name.trim().length > ADDON_NAME_MAX) {
    return failure(400, `The add-on group name must be ${ADDON_NAME_MAX} characters or fewer.`);
  }
  if (selection_type !== 'single' && selection_type !== 'multi') {
    return failure(400, 'selection_type must be single or multi');
  }
  if (!isWholeNumber(min_select) || !isWholeNumber(max_select)) {
    return failure(400, 'min_select and max_select must be whole numbers');
  }
  if (!Array.isArray(options) || options.length === 0) {
    return failure(400, 'Add at least one option.');
  }
  if (options.length > ADDON_OPTIONS_MAX) {
    return failure(400, `An add-on group can have at most ${ADDON_OPTIONS_MAX} options.`);
  }

  const parsed: AddonOptionChange[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const raw of options) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return failure(400, 'Each option needs a name and a price.');
    }
    const { id, name, price_inr } = raw as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') {
      return failure(400, 'Every option needs a name.');
    }
    const trimmed = name.trim();
    if (trimmed.length > ADDON_NAME_MAX) {
      return failure(400, `Option names must be ${ADDON_NAME_MAX} characters or fewer.`);
    }
    if (!isWholeNumber(price_inr) || price_inr < 0 || price_inr > ADDON_PRICE_MAX) {
      return failure(400, `The price for "${trimmed}" must be a whole number of rupees from 0.`);
    }
    const key = trimmed.toLowerCase();
    if (names.has(key)) return failure(400, `"${trimmed}" is listed twice.`);
    names.add(key);
    if (id !== undefined && id !== null) {
      if (!isUuid(id)) return failure(400, 'option ids must be valid uuids');
      if (ids.has(id)) return failure(400, 'An option appears twice.');
      ids.add(id);
      parsed.push({ id, name: trimmed, price_inr });
    } else {
      parsed.push({ name: trimmed, price_inr });
    }
  }

  if (selection_type === 'single') {
    if (max_select !== 1 || (min_select !== 0 && min_select !== 1)) {
      return failure(400, 'A pick-one group allows exactly one choice (required or optional).');
    }
  } else {
    if (max_select < 1) return failure(400, 'Allow at least one choice.');
    if (min_select < 0 || min_select > max_select) {
      return failure(400, 'The minimum must be between 0 and the maximum.');
    }
    if (max_select > parsed.length) {
      return failure(400, `The maximum can't be more than the ${parsed.length} option(s) in the group.`);
    }
  }

  return {
    ok: true,
    value: {
      display_name: display_name.trim(),
      selection_type,
      min_select,
      max_select,
      options: parsed,
    },
  };
}

// ---------------------------------------------------------------------------
// What a proposal changes (pure)
// ---------------------------------------------------------------------------

/** A group's values as the form shows them, from an addon_groups row read with its options. */
export function addonSnapshotFromRow(row: Record<string, unknown>): AddonGroupChangePayload {
  const options = [...((row.options as { id: string; name: string; price_inr: number; sort_order: number }[] | null) ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((o) => ({ id: o.id, name: o.name, price_inr: o.price_inr }));
  return {
    display_name: String(row.display_name ?? ''),
    selection_type: row.selection_type === 'multi' ? 'multi' : 'single',
    min_select: Number(row.min_select ?? 0),
    max_select: Number(row.max_select ?? 1),
    options,
  };
}

/** A create's values, as stored in the request payload. */
export function addonPayloadFromValues(values: AddonGroupValues): AddonGroupChangePayload {
  return {
    display_name: values.display_name,
    selection_type: values.selection_type,
    min_select: values.min_select,
    max_select: values.max_select,
    options: values.options.map((o) => ({ ...o })),
  };
}

const SCALAR_KEYS = ['display_name', 'selection_type', 'min_select', 'max_select'] as const;

function sameOptions(a: AddonOptionChange[], b: AddonOptionChange[]): boolean {
  return (
    a.length === b.length &&
    a.every((o, i) => (o.id ?? null) === (b[i].id ?? null) && o.name === b[i].name && o.price_inr === b[i].price_inr)
  );
}

/**
 * Only the proposed fields that differ from the group as it stands. Options are
 * compared as an ordered list of { id, name, price } (order is display order), so
 * a rename, a new price, a new option or a reorder is a change.
 */
export function diffAddonPayload(
  snapshot: AddonGroupChangePayload,
  proposed: AddonGroupChangePayload,
): AddonGroupChangePayload {
  const changes: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    if (proposed[key] === undefined) continue;
    if (snapshot[key] !== proposed[key]) changes[key] = proposed[key];
  }
  if (proposed.options !== undefined && !sameOptions(snapshot.options ?? [], proposed.options)) {
    changes.options = proposed.options;
  }
  return changes as AddonGroupChangePayload;
}

/**
 * The payload fields whose live value no longer matches what the group held when
 * the request was made — approving would silently overwrite those newer values.
 * For options, an existing option's name or price that has since changed counts
 * (options added since are untouched by the request, so they don't).
 */
export function staleAddonFields(request: AddonGroupChangeRequest, live: AddonGroupChangePayload): string[] {
  const { snapshot, payload } = request;
  if (!snapshot || !payload) return [];
  const stale: string[] = [];
  for (const key of SCALAR_KEYS) {
    if (payload[key] !== undefined && snapshot[key] !== live[key]) stale.push(key);
  }
  if (payload.options !== undefined) {
    const liveById = new Map((live.options ?? []).map((o) => [o.id, o]));
    const changed = (snapshot.options ?? []).some((o) => {
      const now = liveById.get(o.id);
      return !now || now.name !== o.name || now.price_inr !== o.price_inr;
    });
    if (changed) stale.push('options');
  }
  return stale;
}

const FIELD_WORDS: Record<string, string> = {
  display_name: 'name',
  selection_type: 'choice rule',
  min_select: 'choice rule',
  max_select: 'choice rule',
  options: 'options & prices',
};

export function staleAddonFailure(fields: string[]): Failure {
  const words = [...new Set(fields.map((f) => FIELD_WORDS[f] ?? f))];
  return {
    ...failure(
      409,
      `This add-on group was changed after the request was made (${words.join(', ')}). Review the current group, then approve anyway or reject.`,
    ),
    extra: { stale: true, fields },
  };
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

function shapeGroup(row: Record<string, unknown>): AddonGroup {
  const group = row as unknown as AddonGroup;
  return {
    ...group,
    options: [...(group.options ?? [])].sort((a, b) => a.sort_order - b.sort_order),
  };
}

export async function loadAddonGroup(admin: Admin, id: string): Promise<Outcome<AddonGroup>> {
  const { data, error } = await admin.from('addon_groups').select(GROUP_SELECT).eq('id', id).maybeSingle();
  if (error) return failure(500, 'Failed to load the add-on group');
  if (!data) return failure(404, 'Not found');
  return { ok: true, value: shapeGroup(data as Record<string, unknown>) };
}

/** The group's full current values (options in order, with ids), or a 404. */
export async function loadAddonSnapshot(admin: Admin, id: string): Promise<Outcome<AddonGroupChangePayload>> {
  const loaded = await loadAddonGroup(admin, id);
  if (!loaded.ok) return loaded;
  return { ok: true, value: addonSnapshotFromRow(loaded.value as unknown as Record<string, unknown>) };
}

/** An option id the proposal names that is not in the group (another group's, or deleted). */
export function foreignOptionId(values: Pick<AddonGroupValues, 'options'>, groupOptionIds: Set<string>): string | null {
  return values.options.find((o) => o.id !== undefined && !groupOptionIds.has(o.id))?.id ?? null;
}

const nameTaken = (name: string) =>
  failure(409, `An add-on group called "${name}" already exists. Pick another name, or edit that group.`);

/**
 * Creates the group (at the end of the list) and its options. The internal
 * `name` (the unique matching key the Petpooja import uses) starts as the
 * display name. A failure after the group exists deletes it again, so a
 * half-made group never stays (and a retried approval can't make two).
 */
export async function applyAddonCreate(admin: Admin, values: AddonGroupValues): Promise<Outcome<AddonGroup>> {
  const { data: last } = await admin
    .from('addon_groups')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const sortOrder = (Number((last as { sort_order?: number } | null)?.sort_order) || 0) + 10;

  const { data: group, error: groupError } = await admin
    .from('addon_groups')
    .insert({
      name: values.display_name,
      display_name: values.display_name,
      selection_type: values.selection_type,
      min_select: values.min_select,
      max_select: values.max_select,
      sort_order: sortOrder,
    })
    .select('id')
    .single();
  if (groupError || !group) {
    if (groupError?.code === '23505') return nameTaken(values.display_name);
    return failure(500, 'Failed to create the add-on group');
  }
  const groupId = (group as { id: string }).id;

  const { error: optionsError } = await admin.from('addon_options').insert(
    values.options.map((o, i) => ({
      addon_group_id: groupId,
      name: o.name,
      price_inr: o.price_inr,
      sort_order: i * 10,
    })),
  );
  if (optionsError) {
    await admin.from('addon_groups').delete().eq('id', groupId);
    return failure(500, 'Failed to create the add-on options');
  }

  const full = await loadAddonGroup(admin, groupId);
  if (!full.ok) {
    await admin.from('addon_groups').delete().eq('id', groupId);
    return failure(500, 'Failed to load the new add-on group');
  }
  return full;
}

/**
 * Applies an edit: the group's own fields that `changes` names, and — when it
 * carries `options` — each listed option in place (existing ones by id: name,
 * price, position; new ones inserted). Options the list leaves out are left
 * exactly as they are; nothing is deleted. Every option id must belong to the
 * group (a 409 otherwise, before anything is written).
 */
export async function applyAddonUpdate(
  admin: Admin,
  groupId: string,
  changes: AddonGroupChangePayload,
): Promise<Outcome<AddonGroup>> {
  const current = await loadAddonGroup(admin, groupId);
  if (!current.ok) return current;

  if (changes.options) {
    const ids = new Set(current.value.options.map((o) => o.id));
    const foreign = foreignOptionId({ options: changes.options }, ids);
    if (foreign) return failure(409, 'An option in this change is no longer in the group. Reload and try again.');
  }

  const updates: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    if (changes[key] !== undefined) updates[key] = changes[key];
  }
  if (Object.keys(updates).length > 0) {
    const { error } = await admin.from('addon_groups').update(updates).eq('id', groupId);
    if (error) return failure(500, 'Failed to update the add-on group');
  }

  if (changes.options) {
    for (const [i, option] of changes.options.entries()) {
      if (option.id) {
        const { error } = await admin
          .from('addon_options')
          .update({ name: option.name, price_inr: option.price_inr, sort_order: i * 10 })
          .eq('id', option.id)
          .eq('addon_group_id', groupId);
        if (error) return failure(500, 'Failed to update the add-on options');
      } else {
        const { error } = await admin.from('addon_options').insert({
          addon_group_id: groupId,
          name: option.name,
          price_inr: option.price_inr,
          sort_order: i * 10,
        });
        if (error) return failure(500, 'Failed to add the new add-on option');
      }
    }
  }

  return loadAddonGroup(admin, groupId);
}
