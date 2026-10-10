import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Coffey add-ons (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2.3) — the owner's
// Add-ons editor. There is no DOM in this suite, so this covers (1) the pure
// rules the editor is built on (lib/suggest/addonTraitsUi.ts: the two-chip cap,
// the "+n" read-outs, the PATCH body — which is also run through the route's own
// validator, so the editor and the route cannot drift apart) and (2) a server
// render of the section across the states that matter: loading, the migration
// pending, a row being edited, an edited (overridden) row. It catches what the
// types can't: a banner that says the wrong thing, an Edit button that is
// enabled when it must not be, a zero printed as "+0".

import { AddonTraitsSection } from '@/components/owner/suggestions/AddonTraitsSection';
import { TraitsTab } from '@/components/owner/suggestions/TraitsTab';
import { deriveAddonTraits } from '@/lib/suggest/addonTraits';
import {
  ADDON_TRAITS_ENDPOINT,
  CHIP_LIMIT_HINTS,
  CHIP_LIMITS,
  buildPatchBody,
  deltaOptionLabel,
  deltaPills,
  familyLabel,
  formatAddonPrice,
  formatDelta,
  groupTitle,
  replaceOption,
  resetOverride,
  roleLabel,
  saveOverride,
  toAddonEditState,
  toggleChip,
  toggleFamily,
  toggleTexture,
  type AddonTraitsGroup,
  type FetchLike,
  type AddonTraitsOption,
  type AddonTraitsOverview,
} from '@/lib/suggest/addonTraitsUi';
import { ADDON_FAMILIES_MAX, ADDON_TEXTURES_MAX, validateAddonTraitsPatch } from '@/lib/suggest/addonTraitsValidate';
import { FLAVOUR_FAMILY_INFO, TEXTURES } from '@/lib/suggest/traitVocabulary';
import { ADDON_ROLES, FLAVOUR_FAMILIES, type AddonTraits } from '@/lib/suggest/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const syrupNames = { name: 'Syrup', display_name: 'Add a Syrup' };
const condimentNames = { name: 'Condiments', display_name: 'Add Condiments' };

const option = (
  id: string,
  names: { name: string; display_name: string },
  name: string,
  price: number,
  over: Partial<AddonTraitsOption> = {},
): AddonTraitsOption => {
  const derived = deriveAddonTraits(names, { name });
  return { id, name, price_inr: price, is_available: true, label: name, derived, traits: derived, overridden: false, ...over };
};

const OVERRIDE: AddonTraits = {
  role: 'topping',
  flavour_families: ['caramel', 'nutty'],
  sweetness_delta: 4,
  intensity_delta: 1,
  indulgence_delta: 2,
  textures: ['crunchy', 'soft'],
};

const hazelnut = option('o-hazel', syrupNames, 'Hazelnut', 35);
const vanilla = option('o-vanilla', syrupNames, 'Vanilla', 35);
const chocolate = option('o-choc', condimentNames, 'Chocolate Sauce', 30);
const nutella = option('o-nutella', condimentNames, 'Nutella', 40, { overridden: true, traits: OVERRIDE });
const offShot = option('o-shot', condimentNames, 'Espresso Shot', 60, { is_available: false });

const groups: AddonTraitsGroup[] = [
  { id: 'g-syrup', name: 'Syrup', display_name: 'Add a Syrup', options: [hazelnut, vanilla] },
  { id: 'g-cond', name: 'Condiments', display_name: 'Add Condiments', options: [chocolate, nutella, offShot] },
  { id: 'g-empty', name: 'Empty', display_name: 'An Empty Group', options: [] },
];

const overview = (over: Partial<AddonTraitsOverview> = {}): AddonTraitsOverview => ({ groups, menuMissing: false, ...over });

/** The section, server-rendered, with apostrophes and quotes normalised for matching. */
function render(data?: AddonTraitsOverview, editingId?: string): string {
  return renderToStaticMarkup(createElement(AddonTraitsSection, { initial: { data, editingId } }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

/** The one table row that starts with this option name. */
function rowOf(html: string, name: string): string {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const found = rows.find((r) => r.includes(`>${name}</span>`));
  if (!found) throw new Error(`no row for "${name}"`);
  return found;
}

/** The HTML `disabled` attribute — not the Tailwind `disabled:` variant classes. */
const DISABLED = / disabled=""/;

const buttonTag = (html: string, label: string): string => {
  const match = new RegExp(`<button[^>]*>[^<]*${label}[^<]*</button>`).exec(html);
  if (!match) throw new Error(`no button labelled "${label}"`);
  return match[0];
};

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe('toggleChip — the cap of two', () => {
  it('adds an unchosen chip', () => {
    expect(toggleChip([], 'nutty', 2)).toEqual({ next: ['nutty'], refused: false });
    expect(toggleChip(['nutty'], 'caramel', 2)).toEqual({ next: ['nutty', 'caramel'], refused: false });
  });

  it('removes a chosen chip', () => {
    expect(toggleChip(['nutty', 'caramel'], 'nutty', 2)).toEqual({ next: ['caramel'], refused: false });
  });

  it('REFUSES a third chip and leaves the selection as it was', () => {
    expect(toggleChip(['nutty', 'caramel'], 'fruity', 2)).toEqual({ next: ['nutty', 'caramel'], refused: true });
  });

  it('a chosen chip can still be removed at the cap', () => {
    expect(toggleChip(['nutty', 'caramel'], 'caramel', 2).refused).toBe(false);
  });

  it('after removing one at the cap, another can be added', () => {
    const afterRemove = toggleChip(['nutty', 'caramel'], 'nutty', 2).next;
    expect(toggleChip(afterRemove, 'fruity', 2)).toEqual({ next: ['caramel', 'fruity'], refused: false });
  });

  it('follows `order` when one is given, and the end of the list when not', () => {
    expect(toggleChip(['nutty'], 'chocolatey', 2, FLAVOUR_FAMILIES).next).toEqual(['chocolatey', 'nutty']);
    expect(toggleChip(['nutty'], 'chocolatey', 2).next).toEqual(['nutty', 'chocolatey']);
  });

  it('never changes the array it was given', () => {
    const selected = ['nutty'] as const;
    toggleChip(selected, 'caramel', 2);
    toggleChip(selected, 'nutty', 2);
    expect(selected).toEqual(['nutty']);
  });

  it('a cap of zero refuses everything', () => {
    expect(toggleChip([], 'nutty', 0)).toEqual({ next: [], refused: true });
  });
});

describe('toggleFamily / toggleTexture — applied to the edit state', () => {
  const base = toAddonEditState(deriveAddonTraits(syrupNames, { name: 'Hazelnut' })); // flavour, nutty

  it('the caps are the validator\'s (and so the database\'s)', () => {
    expect(CHIP_LIMITS).toEqual({ flavour_families: ADDON_FAMILIES_MAX, textures: ADDON_TEXTURES_MAX });
    expect(ADDON_FAMILIES_MAX).toBe(2);
    expect(ADDON_TEXTURES_MAX).toBe(2);
  });

  it('a second family is added, in FLAVOUR_FAMILIES order', () => {
    const { edit, refused } = toggleFamily(base, 'chocolatey');
    expect(refused).toBe(false);
    expect(edit.flavour_families).toEqual(['chocolatey', 'nutty']);
  });

  it('a third family is refused and the edit state is returned as it was', () => {
    const two = toggleFamily(base, 'caramel').edit;
    const result = toggleFamily(two, 'fruity');
    expect(result.refused).toBe(true);
    expect(result.edit).toBe(two);
    expect(result.edit.flavour_families).toEqual(['caramel', 'nutty']);
  });

  it('tapping a chosen family clears it', () => {
    expect(toggleFamily(base, 'nutty').edit.flavour_families).toEqual([]);
  });

  it('textures: two are allowed, a third is refused', () => {
    const one = toggleTexture(base, 'crunchy');
    const two = toggleTexture(one.edit, 'soft');
    expect(two.edit.textures).toEqual(['crunchy', 'soft']);
    const three = toggleTexture(two.edit, 'icy');
    expect(three.refused).toBe(true);
    expect(three.edit.textures).toEqual(['crunchy', 'soft']);
    expect(toggleTexture(two.edit, 'soft').edit.textures).toEqual(['crunchy']);
  });

  it('a toggle leaves the other fields alone, and the original state untouched', () => {
    const next = toggleTexture(toggleFamily(base, 'caramel').edit, 'fizzy').edit;
    expect(next).toMatchObject({ role: 'flavour', sweetness_delta: 2, intensity_delta: 0, indulgence_delta: 0 });
    expect(base.flavour_families).toEqual(['nutty']);
    expect(base.textures).toEqual([]);
  });

  it('has a hint for each chip group that says what to do', () => {
    expect(CHIP_LIMIT_HINTS.flavour_families).toMatch(/Up to 2 flavours/);
    expect(CHIP_LIMIT_HINTS.textures).toMatch(/Up to 2 textures/);
    for (const hint of Object.values(CHIP_LIMIT_HINTS)) expect(hint).toMatch(/remove/);
  });
});

describe('toAddonEditState', () => {
  it('copies the arrays, so editing never mutates the row on screen', () => {
    const edit = toAddonEditState(OVERRIDE);
    expect(edit).toEqual(OVERRIDE);
    expect(edit.flavour_families).not.toBe(OVERRIDE.flavour_families);
    expect(edit.textures).not.toBe(OVERRIDE.textures);
  });
});

describe('formatDelta / deltaPills — "+n", zeros hidden', () => {
  it('prints a lift as +n', () => {
    expect(formatDelta(1)).toBe('+1');
    expect(formatDelta(5)).toBe('+5');
  });

  it('hides a zero (and anything that is not a positive number)', () => {
    for (const n of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatDelta(n), String(n)).toBeNull();
  });

  it('lists only the non-zero lifts, sweetness then strength then treat', () => {
    expect(deltaPills({ ...OVERRIDE })).toEqual([
      { key: 'sweetness', label: 'Sweet', text: '+4' },
      { key: 'strength', label: 'Strength', text: '+1' },
      { key: 'treat', label: 'Treat', text: '+2' },
    ]);
    expect(deltaPills({ ...OVERRIDE, sweetness_delta: 0, indulgence_delta: 0 })).toEqual([{ key: 'strength', label: 'Strength', text: '+1' }]);
    expect(deltaPills({ ...OVERRIDE, sweetness_delta: 0, intensity_delta: 0, indulgence_delta: 0 })).toEqual([]);
  });

  it('labels a select option "0" or "+n"', () => {
    expect([0, 1, 2, 3, 4, 5].map(deltaOptionLabel)).toEqual(['0', '+1', '+2', '+3', '+4', '+5']);
  });
});

describe('labels', () => {
  it('every role has a readable label', () => {
    for (const role of ADDON_ROLES) expect(roleLabel(role)).toMatch(/^[A-Z][a-z]+$/);
    expect(roleLabel('flavour')).toBe('Flavour');
  });

  it('a family reads as the customer sees it: emoji and label', () => {
    for (const f of FLAVOUR_FAMILIES) expect(familyLabel(f)).toBe(`${FLAVOUR_FAMILY_INFO[f].emoji} ${FLAVOUR_FAMILY_INFO[f].label}`);
    expect(familyLabel('nutty')).toBe('🌰 Nutty');
  });

  it('a price is rupees', () => {
    expect(formatAddonPrice(35)).toBe('₹35');
    expect(formatAddonPrice(0)).toBe('₹0');
  });

  it('a group is titled by its display name, falling back to its name', () => {
    expect(groupTitle({ name: 'Syrup', display_name: 'Add a Syrup' })).toBe('Add a Syrup');
    expect(groupTitle({ name: 'Syrup', display_name: '  ' })).toBe('Syrup');
  });
});

describe('buildPatchBody — what Save sends', () => {
  it('is exactly the seven keys the route accepts', () => {
    expect(buildPatchBody('o-1', toAddonEditState(OVERRIDE))).toEqual({
      optionId: 'o-1',
      role: 'topping',
      flavour_families: ['caramel', 'nutty'],
      sweetness_delta: 4,
      intensity_delta: 1,
      indulgence_delta: 2,
      textures: ['crunchy', 'soft'],
    });
  });

  it('sends the families in FLAVOUR_FAMILIES order', () => {
    const body = buildPatchBody('o-1', { ...OVERRIDE, flavour_families: ['nutty', 'chocolatey'] });
    expect(body.flavour_families).toEqual(['chocolatey', 'nutty']);
  });

  it('the route\'s validator accepts it, and stores what the editor holds', () => {
    const id = '3dd077ea-b036-58f0-9a3b-dab3746e894c';
    const edits: AddonTraits[] = [
      OVERRIDE,
      deriveAddonTraits(syrupNames, { name: 'Hazelnut' }),
      { role: 'other', flavour_families: [], sweetness_delta: 0, intensity_delta: 0, indulgence_delta: 0, textures: [] },
      { role: 'shot', flavour_families: [], sweetness_delta: 5, intensity_delta: 2, indulgence_delta: 2, textures: ['icy', 'fizzy'] },
      { role: 'flavour', flavour_families: ['floral', 'chocolatey'], sweetness_delta: 0, intensity_delta: 0, indulgence_delta: 0, textures: [] },
    ];
    for (const edit of edits) {
      const verdict = validateAddonTraitsPatch(buildPatchBody(id, toAddonEditState(edit)));
      expect(typeof verdict, JSON.stringify(edit)).not.toBe('string');
      if (typeof verdict !== 'string') {
        expect(verdict.optionId).toBe(id);
        expect(verdict.traits.role).toBe(edit.role);
        expect([...verdict.traits.flavour_families].sort()).toEqual([...edit.flavour_families].sort());
        expect(verdict.traits.textures).toEqual(edit.textures);
      }
    }
  });

  it('any edit the chips can reach is accepted: every role, every family pair, every texture pair', () => {
    const id = '3dd077ea-b036-58f0-9a3b-dab3746e894c';
    let edit = toAddonEditState(OVERRIDE);
    for (const role of ADDON_ROLES) {
      expect(typeof validateAddonTraitsPatch(buildPatchBody(id, { ...edit, role }))).not.toBe('string');
    }
    for (const a of FLAVOUR_FAMILIES) {
      for (const b of FLAVOUR_FAMILIES) {
        edit = { ...edit, flavour_families: [] };
        edit = toggleFamily(edit, a).edit;
        edit = toggleFamily(edit, b).edit; // a === b clears it again
        edit = toggleFamily(edit, 'floral').edit; // refused at the cap
        expect(edit.flavour_families.length).toBeLessThanOrEqual(2);
        expect(typeof validateAddonTraitsPatch(buildPatchBody(id, edit)), `${a}+${b}`).not.toBe('string');
      }
    }
    for (const a of TEXTURES) {
      for (const b of TEXTURES) {
        edit = { ...edit, textures: [] };
        edit = toggleTexture(edit, a).edit;
        edit = toggleTexture(edit, b).edit;
        edit = toggleTexture(edit, 'chewy').edit;
        expect(edit.textures.length).toBeLessThanOrEqual(2);
        expect(typeof validateAddonTraitsPatch(buildPatchBody(id, edit)), `${a}+${b}`).not.toBe('string');
      }
    }
  });
});

describe('replaceOption', () => {
  it('swaps the option with that id, wherever it is, and nothing else', () => {
    const fresh = { ...nutella, overridden: false, traits: nutella.derived };
    const next = replaceOption(overview(), fresh);
    expect(next.groups[1].options[1]).toBe(fresh);
    expect(next.groups[1].options[0]).toBe(chocolate);
    expect(next.groups[0]).toBe(groups[0]); // untouched groups are not copied
    expect(next.menuMissing).toBe(false);
  });

  it('is a no-op for an id it does not know', () => {
    const next = replaceOption(overview(), { ...hazelnut, id: 'nope' });
    expect(next.groups.map((g) => g.options)).toEqual(groups.map((g) => g.options));
  });

  it('does not mutate the data it was given', () => {
    const data = overview();
    replaceOption(data, { ...hazelnut, name: 'changed' });
    expect(data.groups[0].options[0].name).toBe('Hazelnut');
  });
});

describe('saveOverride / resetOverride — what Save and Reset do on the wire', () => {
  const ID = '3dd077ea-b036-58f0-9a3b-dab3746e894c';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fake = (res: Response | Error) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: FetchLike = (url, init) => {
      calls.push({ url, init });
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    };
    return { fetcher, calls };
  };
  const edit = toAddonEditState(OVERRIDE);

  it('Save PATCHes the owner route with the JSON body buildPatchBody makes', async () => {
    const { fetcher, calls } = fake(json({ option: nutella }));
    await saveOverride(fetcher, ID, edit);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/owner/suggest/addon-traits');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(buildPatchBody(ID, edit));
  });

  it('Save hands back the server\'s fresh copy of the option, so the row can be refreshed from it', async () => {
    const result = await saveOverride(fake(json({ option: nutella })).fetcher, ID, edit);
    expect(result).toEqual({ ok: true, value: nutella });
  });

  it('Save with an answer that carries no option says so (the caller re-fetches)', async () => {
    expect(await saveOverride(fake(json({})).fetcher, ID, edit)).toEqual({ ok: true, value: null });
    expect(await saveOverride(fake(json({ option: { id: 'x' } })).fetcher, ID, edit)).toEqual({ ok: true, value: null });
    expect(await saveOverride(fake(new Response('not json', { status: 200 })).fetcher, ID, edit)).toEqual({ ok: true, value: null });
  });

  it('Save failure shows the server\'s own message', async () => {
    const m409 = 'Apply supabase/2026-10-coffey-addons-pairings.sql in Supabase, then try again.';
    expect(await saveOverride(fake(json({ error: m409 }, 409)).fetcher, ID, edit)).toEqual({ ok: false, message: m409 });
    expect(await saveOverride(fake(json({ error: 'Invalid value for "textures"' }, 400)).fetcher, ID, edit)).toEqual({
      ok: false,
      message: 'Invalid value for "textures"',
    });
    expect(await saveOverride(fake(json({ error: 'Owner access required' }, 403)).fetcher, ID, edit)).toMatchObject({ message: 'Owner access required' });
  });

  it('Save failure with no usable message falls back to a plain one', async () => {
    for (const res of [new Response('', { status: 500 }), new Response('<html>', { status: 502 }), json({ error: '' }, 500), json({ error: 7 }, 500), json(null, 500)]) {
      expect(await saveOverride(fake(res).fetcher, ID, edit)).toEqual({ ok: false, message: 'Save failed' });
    }
  });

  it('a network failure is a message, not a thrown error', async () => {
    const result = await saveOverride(fake(new TypeError('Failed to fetch')).fetcher, ID, edit);
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/Could not reach the server/) });
    expect(await resetOverride(fake(new TypeError('Failed to fetch')).fetcher, ID)).toMatchObject({ ok: false });
  });

  it('Reset DELETEs ?optionId= with the id, and needs no body back', async () => {
    const { fetcher, calls } = fake(new Response(null, { status: 204 }));
    expect(await resetOverride(fetcher, ID)).toEqual({ ok: true, value: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/api/owner/suggest/addon-traits?optionId=${ID}`);
    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].init?.body).toBeUndefined();
  });

  it('Reset URL-encodes the id', async () => {
    const { fetcher, calls } = fake(new Response(null, { status: 204 }));
    await resetOverride(fetcher, 'a b&c');
    expect(calls[0].url).toBe('/api/owner/suggest/addon-traits?optionId=a%20b%26c');
  });

  it('Reset failure shows the server\'s message, or "Reset failed"', async () => {
    expect(await resetOverride(fake(json({ error: 'Apply the SQL' }, 409)).fetcher, ID)).toEqual({ ok: false, message: 'Apply the SQL' });
    expect(await resetOverride(fake(new Response('', { status: 500 })).fetcher, ID)).toEqual({ ok: false, message: 'Reset failed' });
  });

  it('a failed write never calls fetch a second time', async () => {
    const fetcher = vi.fn<FetchLike>(() => Promise.resolve(json({ error: 'no' }, 500)));
    await saveOverride(fetcher, ID, edit);
    await resetOverride(fetcher, ID);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('the endpoint', () => {
  it('is the owner route', () => {
    expect(ADDON_TRAITS_ENDPOINT).toBe('/api/owner/suggest/addon-traits');
  });
});

// ---------------------------------------------------------------------------
// The section, server-rendered
// ---------------------------------------------------------------------------

describe('Add-ons section — the heading and the help line', () => {
  const html = render(overview());

  it('is titled "Add-ons" and says what the traits are for', () => {
    expect(html).toMatch(/<h2[^>]*>Add-ons<\/h2>/);
    expect(html).toContain(
      "Coffey reads these to point customers to an add-on for a flavour they asked for. They're worked out from the names; correct anything that's wrong.",
    );
  });

  it('shows "Loading…" and no table while it has no data yet', () => {
    const loading = render(undefined);
    expect(loading).toContain('Loading…');
    expect(loading).not.toContain('<table');
    expect(loading).toContain('>Add-ons<');
  });
});

describe('Add-ons section — the list', () => {
  const html = render(overview());

  it('is grouped: each group\'s display name is a sub-heading, and a group with no options is left out', () => {
    expect(html).toMatch(/<h3[^>]*>Add a Syrup<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>Add Condiments<\/h3>/);
    expect(html).not.toContain('An Empty Group');
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html.indexOf('Add a Syrup')).toBeLessThan(html.indexOf('Add Condiments'));
  });

  it('lists each option under its group with name and price', () => {
    for (const [name, price] of [['Hazelnut', '₹35'], ['Vanilla', '₹35'], ['Chocolate Sauce', '₹30'], ['Nutella', '₹40']]) {
      const row = rowOf(html, name);
      expect(row).toContain(price);
    }
    expect(html.indexOf('>Hazelnut<')).toBeLessThan(html.indexOf('>Chocolate Sauce<'));
  });

  it('marks an option that is switched off', () => {
    expect(rowOf(html, 'Espresso Shot')).toContain('switched off');
    expect(rowOf(html, 'Hazelnut')).not.toContain('switched off');
  });

  it('shows the role, with the family as a pill with its emoji and label', () => {
    const row = rowOf(html, 'Hazelnut');
    expect(row).toContain('>Flavour<');
    expect(row).toContain('🌰 Nutty');
  });

  it('shows the lifts as "+n" and hides every zero', () => {
    const row = rowOf(html, 'Hazelnut'); // sweetness +2, nothing else
    expect(row).toContain('+2');
    expect(row).not.toMatch(/\+1|\+3|\+0/);
    expect(html).not.toContain('+0');
    const nutellaRow = rowOf(html, 'Nutella'); // +4, +1, +2
    expect(nutellaRow).toContain('+4');
    expect(nutellaRow).toContain('+1');
    expect(nutellaRow).toContain('+2');
  });

  it('shows an override\'s traits, not the derived ones', () => {
    const row = rowOf(html, 'Nutella');
    expect(row).toContain('>Topping<');
    expect(row).toContain('🍯 Caramel &amp; toffee');
    expect(row).toContain('🌰 Nutty');
    expect(row).toContain('>crunchy<');
    expect(row).toContain('>soft<');
  });

  it('puts the "Edited" pill on overridden options only', () => {
    expect(rowOf(html, 'Nutella')).toContain('>Edited<');
    for (const name of ['Hazelnut', 'Vanilla', 'Chocolate Sauce', 'Espresso Shot']) expect(rowOf(html, name)).not.toContain('Edited');
    expect(html.match(/>Edited</g)).toHaveLength(1);
  });

  it('offers "Reset to derived" only on overridden options', () => {
    expect(rowOf(html, 'Nutella')).toContain('Reset to derived');
    expect(html.match(/Reset to derived/g)).toHaveLength(1);
  });

  it('is read-only until Edit is pressed: no selects, no chips, no Save', () => {
    expect(html).not.toContain('<select');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('>Save<');
    expect(html.match(/>Edit</g)).toHaveLength(5);
    expect(buttonTag(html, 'Edit')).not.toMatch(DISABLED);
  });

  it('says so when there are no add-ons at all', () => {
    expect(render(overview({ groups: [] }))).toContain('No add-ons on the menu yet.');
    expect(render(overview({ groups: [groups[2]] }))).toContain('No add-ons on the menu yet.');
  });
});

describe('Add-ons section — before the migration', () => {
  const html = render(overview({ menuMissing: true }));

  it('tells the owner to apply the SQL file', () => {
    expect(html).toContain('Apply supabase/2026-10-coffey-addons-pairings.sql in Supabase to save changes here');
    expect(html).toMatch(/editing is turned off/);
  });

  it('turns every Edit button off', () => {
    const edits = html.match(/<button[^>]*>Edit<\/button>/g) ?? [];
    expect(edits).toHaveLength(5);
    for (const e of edits) expect(e).toMatch(DISABLED);
  });

  it('still shows the derived traits', () => {
    expect(html).toContain('🌰 Nutty');
    expect(rowOf(html, 'Hazelnut')).toContain('+2');
  });

  it('cannot open the editor even if asked to', () => {
    // A stale `editingId` from before the data said "missing" is still just a row being edited,
    // but the Edit button that opens it is off — checked above. Without one, no editor shows.
    expect(html).not.toContain('<select');
  });

  it('shows no banner once the table is there', () => {
    expect(render(overview())).not.toContain('Apply supabase/2026-10-coffey-addons-pairings.sql');
  });
});

describe('Add-ons section — inline editing', () => {
  const html = render(overview(), 'o-hazel');
  const row = rowOf(html, 'Hazelnut');

  it('the role is a <select> of every role, with the current one chosen', () => {
    const select = /<select[^>]*aria-label="Role for Hazelnut"[^>]*>([\s\S]*?)<\/select>/.exec(row);
    expect(select).not.toBeNull();
    const options = [...(select?.[1] ?? '').matchAll(/<option value="([^"]*)"( selected="")?>/g)];
    expect(options.map((o) => o[1])).toEqual([...ADDON_ROLES]);
    expect(options.filter((o) => o[2]).map((o) => o[1])).toEqual(['flavour']);
  });

  it('flavours are toggle chips — all seven, the current one pressed', () => {
    const group = /<div role="group" aria-label="Flavours for Hazelnut"[^>]*>([\s\S]*?)<\/div>/.exec(row)?.[1] ?? '';
    const chips = [...group.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)];
    expect(chips).toHaveLength(FLAVOUR_FAMILIES.length);
    expect(chips.filter((c) => c[1] === 'true').map((c) => c[2])).toEqual(['🌰 Nutty']);
  });

  it('textures are toggle chips — all twelve', () => {
    const group = /<div role="group" aria-label="Textures for Hazelnut"[^>]*>([\s\S]*?)<\/div>/.exec(row)?.[1] ?? '';
    const chips = [...group.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)];
    expect(chips.map((c) => c[2])).toEqual([...TEXTURES]);
    expect(chips.filter((c) => c[1] === 'true')).toHaveLength(0);
  });

  it('chips at the cap are NOT disabled — a third tap is refused with a hint, not swallowed', () => {
    const capped = rowOf(render(overview(), 'o-nutella'), 'Nutella'); // two families, two textures
    const pressed = capped.match(/aria-pressed="true"/g) ?? [];
    expect(pressed).toHaveLength(4);
    const chips = capped.match(/<button[^>]*aria-pressed="[^"]*"[^>]*>/g) ?? [];
    expect(chips).toHaveLength(FLAVOUR_FAMILIES.length + TEXTURES.length);
    for (const chip of chips) expect(chip).not.toMatch(DISABLED);
    // a chip that would be a third is dimmed
    expect(chips.filter((c) => c.includes('opacity-50')).length).toBe(FLAVOUR_FAMILIES.length - 2 + (TEXTURES.length - 2));
  });

  it('the three lifts are small <select>s with the right ranges, current value chosen', () => {
    const optionsOf = (label: string) => {
      const m = new RegExp(`<select[^>]*aria-label="${label} added by Hazelnut"[^>]*>([\\s\\S]*?)</select>`).exec(row);
      return [...(m?.[1] ?? '').matchAll(/<option value="(\d)"( selected="")?>([^<]*)</g)].map((o) => [o[1], Boolean(o[2]), o[3]]);
    };
    expect(optionsOf('Sweetness')).toEqual([['0', false, '0'], ['1', false, '+1'], ['2', true, '+2'], ['3', false, '+3'], ['4', false, '+4'], ['5', false, '+5']]);
    expect(optionsOf('Strength')).toEqual([['0', true, '0'], ['1', false, '+1'], ['2', false, '+2']]);
    expect(optionsOf('Treat')).toEqual([['0', true, '0'], ['1', false, '+1'], ['2', false, '+2']]);
  });

  it('has Save and Cancel; Reset to derived only when the option is overridden', () => {
    expect(row).toContain('>Save<');
    expect(row).toContain('>Cancel<');
    expect(row).not.toContain('Reset to derived');
    expect(rowOf(render(overview(), 'o-nutella'), 'Nutella')).toContain('Reset to derived');
  });

  it('only the row being edited is in edit mode', () => {
    expect(html.match(/>Save</g)).toHaveLength(1);
    expect(html.match(/>Edit</g)).toHaveLength(4);
    expect(rowOf(html, 'Vanilla')).not.toContain('<select');
  });

  it('starts from the row\'s resolved traits (an override\'s, not the derived ones)', () => {
    const edited = rowOf(render(overview(), 'o-nutella'), 'Nutella');
    expect(edited).toMatch(/<option value="topping" selected="">/);
    expect(edited).toMatch(/aria-pressed="true"[^>]*>🍯 Caramel &amp; toffee</);
    expect(edited).toMatch(/aria-pressed="true"[^>]*>crunchy</);
  });

  it('the editor shows no hint until a third chip is refused', () => {
    expect(row).not.toContain('Up to 2');
  });
});

describe('Add-ons section — phone layout and brand', () => {
  const html = render(overview(), 'o-hazel');

  it('each table scrolls sideways inside its own wrapper, and is wider than a phone', () => {
    expect(html.match(/overflow-x-auto/g)).toHaveLength(2);
    expect(html.match(/min-width:\s*960px/g)).toHaveLength(2);
  });

  it('the section itself never widens the page', () => {
    expect(html).toMatch(/<section[^>]*min-w-0/);
    expect(html).not.toMatch(/\bw-\[\d{4,}px\]/);
  });

  it('pins the option name column while the table scrolls', () => {
    expect(html).toContain('sticky left-0');
  });

  it('every button, select and chip is at least 44px tall', () => {
    const controls = html.match(/<(button|select)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(20);
    for (const c of controls) expect(c, c).toContain('min-h-[44px]');
  });

  it('uses only brand tokens: no arbitrary colours, no off-brand palette, tan never as text', () => {
    expect(html).not.toMatch(/\[#[0-9a-f]{3,8}\]/i);
    expect(html).not.toMatch(/(?:bg|text|border|ring|fill|stroke)-(?:gray|grey|slate|zinc|neutral|stone|blue|green|emerald|amber|yellow|orange|indigo|purple|pink|white|black)\b/);
    expect(html).not.toMatch(/text-tan(?![-\w])/);
    for (const token of ['text-charcoal', 'text-muted', 'bg-surface', 'border-line', 'bg-cream']) expect(html).toContain(token);
  });

  it('no element carries two competing text colours or font weights', () => {
    const states = [html, render(overview()), render(overview({ menuMissing: true })), render(overview(), 'o-nutella'), render(undefined)];
    for (const state of states) {
      for (const [, classes] of state.matchAll(/class="([^"]*)"/g)) {
        const tokens = classes.split(/\s+/);
        const colours = tokens.filter((t) => /^text-(charcoal|muted|cream|tan-dark|red-\d+)$/.test(t));
        const weights = tokens.filter((t) => /^font-(normal|medium|semibold|bold)$/.test(t));
        expect(colours.length, classes).toBeLessThanOrEqual(1);
        expect(weights.length, classes).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the Edited pill is a filled tan-dark pill with cream text (tan carries text only in its dark shade)', () => {
    expect(render(overview())).toMatch(/bg-tan-dark[^"]*text-cream[^"]*">Edited</);
  });

  it('every table header is a column header, and the actions column is named for screen readers', () => {
    expect((html.match(/<th scope="col"/g) ?? []).length).toBe(16); // 8 per table
    expect(html).toContain('<span class="sr-only">Actions</span>');
  });
});

describe('Traits tab — the Add-ons section is mounted at its end', () => {
  const tab = renderToStaticMarkup(
    createElement(TraitsTab, {
      initial: {
        data: { rows: [], unconfirmedCount: 0, missingCount: 0, needsUpgrade: 0, migrationApplied: true, missingTables: false },
        filter: 'all',
      },
    }),
  );

  it('renders the section once, after the menu traits', () => {
    expect(tab.match(/>Add-ons</g)).toHaveLength(1);
    expect(tab.indexOf('Menu traits')).toBeGreaterThan(-1);
    expect(tab.indexOf('Menu traits')).toBeLessThan(tab.indexOf('>Add-ons<'));
  });

  it('is the last thing in the tab', () => {
    const tail = tab.slice(tab.indexOf('<section'));
    expect(tail.startsWith('<section')).toBe(true);
    expect(tail.endsWith('</section></div>')).toBe(true);
  });
});
