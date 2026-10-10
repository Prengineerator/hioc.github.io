// Coffey add-ons (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2.3) — the pure side of
// the owner's Add-ons editor (components/owner/suggestions/AddonTraitsSection.tsx):
// the shape /api/owner/suggest/addon-traits answers with, and the rules the
// editor is built on (the two-chip cap, the "+n" read-outs, the PATCH body). Kept
// out of the component so they can be tested without a DOM, and shared with the
// route as types only.
//
// Pure: no Supabase, no 'server-only', safe to import from client components.

import { ADDON_FAMILIES_MAX, ADDON_TEXTURES_MAX } from './addonTraitsValidate';
import { FLAVOUR_FAMILY_INFO } from './traitVocabulary';
import { FLAVOUR_FAMILIES, type AddonRole, type AddonTraits, type FlavourFamily, type Texture } from './types';

// ---------------------------------------------------------------------------
// The API's answer
// ---------------------------------------------------------------------------

/** One add-on option as GET (and a successful PATCH) describe it. */
export interface AddonTraitsOption {
  id: string;
  name: string;
  price_inr: number;
  /** False when the option is switched off on the menu (addon_options.is_available). */
  is_available: boolean;
  /** The customer-facing name (lib/suggest/addonTraits.ts addonLabel). */
  label: string;
  /** What the names alone give it (deriveAddonTraits). */
  derived: AddonTraits;
  /** What Coffey actually uses: the owner's override when there is one, else `derived`. */
  traits: AddonTraits;
  overridden: boolean;
}

export interface AddonTraitsGroup {
  id: string;
  name: string;
  display_name: string;
  options: AddonTraitsOption[];
}

export interface AddonTraitsOverview {
  groups: AddonTraitsGroup[];
  /** True while supabase/2026-10-coffey-addons-pairings.sql is not applied: the
   * traits shown are the derived ones and nothing can be saved yet. */
  menuMissing: boolean;
}

export const ADDON_TRAITS_ENDPOINT = '/api/owner/suggest/addon-traits';

// ---------------------------------------------------------------------------
// Edit state
// ---------------------------------------------------------------------------

/** What the inline editor holds for one row: a full set of traits, edited in
 * place. (Plain AddonTraits — every field is always present and valid to save.) */
export type AddonEditState = AddonTraits;

/** A copy of `traits` to edit, so toggling a chip never mutates the row shown. */
export function toAddonEditState(traits: AddonTraits): AddonEditState {
  return { ...traits, flavour_families: [...traits.flavour_families], textures: [...traits.textures] };
}

export type ChipField = 'flavour_families' | 'textures';

export const CHIP_LIMITS: Record<ChipField, number> = {
  flavour_families: ADDON_FAMILIES_MAX,
  textures: ADDON_TEXTURES_MAX,
};

/** Shown beside a chip group when a third tap is refused. */
export const CHIP_LIMIT_HINTS: Record<ChipField, string> = {
  flavour_families: `Up to ${ADDON_FAMILIES_MAX} flavours — tap one to remove it first.`,
  textures: `Up to ${ADDON_TEXTURES_MAX} textures — tap one to remove it first.`,
};

/**
 * One tap on a toggle chip. A chosen chip is removed; an unchosen one is added
 * unless `max` are already chosen, in which case the tap is REFUSED (`refused`)
 * and the selection is returned unchanged, so the UI can say why. With `order`,
 * the result follows that order (the families' fixed order); without it, a new
 * chip goes on the end.
 */
export function toggleChip<T extends string>(
  selected: readonly T[],
  value: T,
  max: number,
  order?: readonly T[],
): { next: T[]; refused: boolean } {
  if (selected.includes(value)) return { next: selected.filter((s) => s !== value), refused: false };
  if (selected.length >= max) return { next: [...selected], refused: true };
  const next = [...selected, value];
  return { next: order ? order.filter((o) => next.includes(o)) : next, refused: false };
}

/** A tap on a flavour-family chip, applied to the edit state. */
export function toggleFamily(edit: AddonEditState, family: FlavourFamily): { edit: AddonEditState; refused: boolean } {
  const { next, refused } = toggleChip(edit.flavour_families, family, ADDON_FAMILIES_MAX, FLAVOUR_FAMILIES);
  return { edit: refused ? edit : { ...edit, flavour_families: next }, refused };
}

/** A tap on a texture chip, applied to the edit state. */
export function toggleTexture(edit: AddonEditState, texture: Texture): { edit: AddonEditState; refused: boolean } {
  const { next, refused } = toggleChip(edit.textures, texture, ADDON_TEXTURES_MAX);
  return { edit: refused ? edit : { ...edit, textures: next }, refused };
}

/** The PATCH body for one row's edit — exactly what validateAddonTraitsPatch
 * accepts. */
export function buildPatchBody(optionId: string, edit: AddonEditState): Record<string, unknown> {
  return {
    optionId,
    role: edit.role,
    flavour_families: FLAVOUR_FAMILIES.filter((f) => edit.flavour_families.includes(f)),
    sweetness_delta: edit.sweetness_delta,
    intensity_delta: edit.intensity_delta,
    indulgence_delta: edit.indulgence_delta,
    textures: [...edit.textures],
  };
}

/** The overview with one option replaced by the server's fresh copy of it (found
 * by id, in whichever group holds it). Unchanged when no option has that id. */
export function replaceOption(data: AddonTraitsOverview, option: AddonTraitsOption): AddonTraitsOverview {
  return {
    ...data,
    groups: data.groups.map((group) =>
      group.options.some((o) => o.id === option.id)
        ? { ...group, options: group.options.map((o) => (o.id === option.id ? option : o)) }
        : group,
    ),
  };
}

// ---------------------------------------------------------------------------
// Writes — Save and Reset to derived
// ---------------------------------------------------------------------------

/** The part of `fetch` the editor uses, so a test can hand in a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type WriteResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** The server's own `{ error }` text when it sent one, else `fallback`. */
async function serverMessage(res: Response, fallback: string): Promise<string> {
  try {
    const json: unknown = await res.json();
    const error = json && typeof json === 'object' ? (json as { error?: unknown }).error : undefined;
    if (typeof error === 'string' && error.trim()) return error;
  } catch {
    // an empty or non-JSON body: the fallback will do
  }
  return fallback;
}

const NETWORK_MESSAGE = 'Could not reach the server — check your connection and try again.';

function isOptionPayload(value: unknown): value is AddonTraitsOption {
  if (!value || typeof value !== 'object') return false;
  const o = value as Partial<AddonTraitsOption>;
  return typeof o.id === 'string' && typeof o.label === 'string' && typeof o.overridden === 'boolean' && !!o.traits && !!o.derived;
}

/**
 * Save: PATCH one option's edit. On success, `value` is the server's fresh copy
 * of the option (so the row shows what is stored), or null if the answer
 * carried none and the caller should re-fetch. On failure, `message` is what the
 * server said (the owner reads it as is), never a thrown error.
 */
export async function saveOverride(
  fetcher: FetchLike,
  optionId: string,
  edit: AddonEditState,
): Promise<WriteResult<AddonTraitsOption | null>> {
  try {
    const res = await fetcher(ADDON_TRAITS_ENDPOINT, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPatchBody(optionId, edit)),
    });
    if (!res.ok) return { ok: false, message: await serverMessage(res, 'Save failed') };
    const json: unknown = await res.json().catch(() => null);
    const option = json && typeof json === 'object' ? (json as { option?: unknown }).option : undefined;
    return { ok: true, value: isOptionPayload(option) ? option : null };
  } catch {
    return { ok: false, message: NETWORK_MESSAGE };
  }
}

/** Reset to derived: DELETE one option's override. The answer is 204 with no
 * body, so the caller re-fetches to show the derived traits. */
export async function resetOverride(fetcher: FetchLike, optionId: string): Promise<WriteResult<null>> {
  try {
    const res = await fetcher(`${ADDON_TRAITS_ENDPOINT}?optionId=${encodeURIComponent(optionId)}`, { method: 'DELETE' });
    if (!res.ok) return { ok: false, message: await serverMessage(res, 'Reset failed') };
    return { ok: true, value: null };
  } catch {
    return { ok: false, message: NETWORK_MESSAGE };
  }
}

// ---------------------------------------------------------------------------
// Read-outs
// ---------------------------------------------------------------------------

/** "+2" for a lift, null for none: a zero is hidden, not printed. */
export function formatDelta(n: number): string | null {
  return Number.isFinite(n) && n > 0 ? `+${Math.round(n)}` : null;
}

export interface DeltaPill {
  key: 'sweetness' | 'strength' | 'treat';
  label: string;
  text: string;
}

/** The sweetness, strength and treat lifts that are not zero, in that order. */
export function deltaPills(traits: AddonTraits): DeltaPill[] {
  const lifts: { key: DeltaPill['key']; label: string; value: number }[] = [
    { key: 'sweetness', label: 'Sweet', value: traits.sweetness_delta },
    { key: 'strength', label: 'Strength', value: traits.intensity_delta },
    { key: 'treat', label: 'Treat', value: traits.indulgence_delta },
  ];
  return lifts.flatMap(({ key, label, value }) => {
    const text = formatDelta(value);
    return text ? [{ key, label, text }] : [];
  });
}

/** An option of a delta <select>: "0", "+1", "+2". */
export function deltaOptionLabel(n: number): string {
  return formatDelta(n) ?? '0';
}

const ROLE_LABELS: Record<AddonRole, string> = {
  flavour: 'Flavour',
  topping: 'Topping',
  shot: 'Shot',
  sweetener: 'Sweetener',
  milk: 'Milk',
  ice: 'Ice',
  serve: 'Serve',
  side: 'Side',
  other: 'Other',
};

export function roleLabel(role: AddonRole): string {
  return ROLE_LABELS[role] ?? role;
}

/** "🍫 Chocolatey" — the same words and emoji the customer's flavour step uses. */
export function familyLabel(family: FlavourFamily): string {
  const info = FLAVOUR_FAMILY_INFO[family];
  return `${info.emoji} ${info.label}`;
}

/** "₹35" */
export function formatAddonPrice(priceInr: number): string {
  return `₹${priceInr}`;
}

/** The group's customer-facing name, falling back to its internal one. */
export function groupTitle(group: Pick<AddonTraitsGroup, 'name' | 'display_name'>): string {
  return group.display_name.trim() || group.name;
}
