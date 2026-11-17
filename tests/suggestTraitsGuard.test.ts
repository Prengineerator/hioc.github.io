// A drink whose own name says "Iced" is iced, whatever its traits row says
// (lib/suggest/traitsGuard.ts). On the live menu "Tiramisu Latte Iced" was
// tagged `hot` and was being offered for hot requests.

import { describe, expect, it } from 'vitest';
import { runSuggest } from '@/lib/suggest/engine';
import { menuFacets, unavailableOptions } from '@/lib/suggest/facets';
import { guardTraits, isMistaggedIced } from '@/lib/suggest/traitsGuard';
import type { MenuItemTraits, SuggestInputs } from '@/lib/suggest/types';
import { buildFixtureMenu, buildFixtureTraitsById } from './fixtures/suggestMenu';

const ask = (over: Partial<SuggestInputs> = {}): SuggestInputs => ({
  mood: 'cosy',
  secondaryMood: null,
  kinds: ['drink'],
  temperature: 'either',
  base: 'either',
  strength: 'any',
  sweetness: 'any',
  body: 'any',
  flavours: [],
  needs: [],
  budget: 'any',
  note: '',
  ...over,
});

/** The fixture menu with ONE hot drink renamed "… Iced" while its row still says hot. */
function mistagged() {
  const menu = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();
  const victim = menu.find((m) => traitsById.get(m.id)?.kind === 'drink' && traitsById.get(m.id)?.temperature === 'hot');
  if (!victim) throw new Error('fixture has no hot drink');
  const renamed = menu.map((m) => (m.id === victim.id ? { ...m, name: `${m.name} Iced` } : m));
  return { menu: renamed, traitsById, id: victim.id };
}

describe('guardTraits', () => {
  it('corrects a drink named "Iced" that is tagged otherwise, and only that', () => {
    const { menu, traitsById, id } = mistagged();
    expect(isMistaggedIced(menu.find((m) => m.id === id)!, traitsById.get(id)!)).toBe(true);
    const guarded = guardTraits(menu, traitsById);
    expect(guarded).not.toBe(traitsById);
    expect(guarded.get(id)?.temperature).toBe('iced');
    // The original map and row are untouched; every other row is the same object.
    expect(traitsById.get(id)?.temperature).toBe('hot');
    for (const [otherId, row] of traitsById) if (otherId !== id) expect(guarded.get(otherId)).toBe(row);
  });

  it('returns the very same map when nothing is mis-tagged', () => {
    const traitsById = buildFixtureTraitsById();
    expect(guardTraits(buildFixtureMenu(), traitsById)).toBe(traitsById);
  });

  it('leaves food and desserts alone, and a word that only contains "iced"', () => {
    const row = (over: Partial<MenuItemTraits>) => ({ kind: 'drink', temperature: 'hot', ...over }) as MenuItemTraits;
    expect(isMistaggedIced({ name: 'Iced Lemon Cake' }, row({ kind: 'dessert', temperature: 'ambient' }))).toBe(false);
    expect(isMistaggedIced({ name: 'Spiced Latte' }, row({}))).toBe(false);
    expect(isMistaggedIced({ name: 'Latte Iced' }, row({ temperature: 'iced' }))).toBe(false);
    expect(isMistaggedIced({ name: 'Latte ICED' }, row({}))).toBe(true);
  });

  it('corrects only a row that says hot: a drink served either way stays available hot', () => {
    const row = (over: Partial<MenuItemTraits>) => ({ kind: 'drink', temperature: 'hot', ...over }) as MenuItemTraits;
    expect(isMistaggedIced({ name: 'Latte Iced' }, row({ temperature: 'either' }))).toBe(false);
    expect(isMistaggedIced({ name: 'Americano (Hot/Iced)' }, row({}))).toBe(false);
    expect(isMistaggedIced({ name: 'Un-iced Tea' }, row({}))).toBe(false);
    expect(isMistaggedIced({ name: 'Mocha (Iced)' }, row({}))).toBe(true);
    expect(isMistaggedIced({ name: 'Iced Mocha' }, row({}))).toBe(true);
  });
});

describe('a drink named "Iced" but tagged hot', () => {
  const { menu, traitsById, id } = mistagged();
  const run = (inputs: SuggestInputs, excludeItemIds: string[] = []) =>
    runSuggest({
      request: { inputs, excludeItemIds },
      menu,
      traitsById,
      profile: null,
      popularity: new Map(),
      recentItemIds: [],
      now: new Date('2026-06-01T10:00:00Z'),
      decider: null,
      fallbackReason: 'disabled',
    });

  it('is never shortlisted or picked for a hot request, across the refine chain', async () => {
    let exclude: string[] = [];
    for (let round = 0; round < 3; round++) {
      const result = await run(ask({ temperature: 'hot' }), exclude);
      expect(result.candidateIds).not.toContain(id);
      expect(result.pickIds).not.toContain(id);
      exclude = [...exclude, ...result.pickIds];
    }
  });

  it('is a candidate for an iced request', async () => {
    const result = await run(ask({ temperature: 'iced' }));
    expect(result.candidateIds).toContain(id);
  });

  it('counts as iced for the wizard too', () => {
    const only = menu.filter((m) => m.id === id);
    const facets = menuFacets(only, traitsById);
    expect(facets).toHaveLength(1);
    expect(facets[0].temperature).toBe('iced');
    const off = unavailableOptions({ kinds: ['drink'], options: [] }, facets);
    expect(off.has('temp:hot')).toBe(true);
    expect(off.has('temp:iced')).toBe(false);
  });
});
