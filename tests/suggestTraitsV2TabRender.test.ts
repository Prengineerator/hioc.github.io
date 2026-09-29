import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.4) — a render smoke test of the owner
// Traits tab. There is no DOM in this suite, so this server-renders the tab
// from `initialData` (effects do not run on the server) across the states that
// matter: migration pending, migration applied with v2 / half-migrated / missing
// rows, and the base table missing. It catches what the types can't — a
// read-out that assumes a v2 field is there, a banner that says the wrong
// thing, a button that is enabled when it must not be.

import { TraitsTab, type Filter, type TraitsTabProps } from '@/components/owner/suggestions/TraitsTab';
import type { TraitsOverview, TraitsOverviewRow } from '@/lib/suggest/queries';
import type { MenuItemTraits } from '@/lib/suggest/types';

const V1: MenuItemTraits = {
  menu_item_id: 'x',
  temperature: 'hot',
  caffeine: 'high',
  is_coffee: true,
  sweetness: 1,
  body: 'light',
  kind: 'drink',
  moods: ['boost', 'cosy'],
  dayparts: ['morning'],
  flavor_notes: ['espresso'],
  source: 'opus',
  confirmed: false,
  updated_at: '2026-09-01T00:00:00Z',
};

const V2: MenuItemTraits = {
  ...V1,
  sweetness_level: 4,
  intensity: 3,
  refreshment: 1,
  indulgence: 0,
  novelty: 2,
  textures: ['silky', 'frothy', 'creamy'],
  mood_fit: { boost: 2.8, focus: 2.1, cosy: 1.4, unwind: 0.4 },
  traits_version: 2,
};

const row = (id: string, name: string, traits: MenuItemTraits | null): TraitsOverviewRow => ({
  menuItemId: id,
  name,
  category: 'Coffee',
  parentCategory: 'Hot',
  isVeg: true,
  isAvailable: true,
  traits: traits ? { ...traits, menu_item_id: id } : null,
});

function overview(over: Partial<TraitsOverview> = {}): TraitsOverview {
  return {
    rows: [row('a', 'Cappucino Iced', V2), row('b', 'Espresso', { ...V1, sweetness_level: 0, traits_version: 1 }), row('c', 'Oreo Heaven Cupcake', null)],
    unconfirmedCount: 2,
    missingCount: 1,
    needsUpgrade: 2,
    migrationApplied: true,
    missingTables: false,
    ...over,
  };
}

/** The tab, server-rendered, with apostrophes normalised for matching. */
function render(data: TraitsOverview, filter?: Filter, editingId?: string): string {
  const props: TraitsTabProps = { initial: { data, filter, editingId } };
  return renderToStaticMarkup(createElement(TraitsTab, props)).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

/** The HTML `disabled` attribute — not the Tailwind `disabled:` variant classes. */
const DISABLED = / disabled=""/;

const buttonTag = (html: string, label: string): string => {
  const match = new RegExp(`<button[^>]*>[^<]*${label}[^<]*</button>`).exec(html);
  if (!match) throw new Error(`no button labelled "${label}" in:\n${html.slice(0, 600)}`);
  return match[0];
};

describe('Traits tab — the banner and the Regenerate button', () => {
  it('after the migration: "N items need Coffey\'s new taste profile" and an ENABLED "Regenerate with Jev"', () => {
    const html = render(overview({ needsUpgrade: 2 }));
    expect(html).toContain("2 items need Coffey's new taste profile");
    expect(buttonTag(html, 'Regenerate with Jev')).not.toMatch(DISABLED);
  });

  it('says "1 item needs" for one', () => {
    expect(render(overview({ needsUpgrade: 1 }))).toContain("1 item needs Coffey's new taste profile");
  });

  it('with nothing left to upgrade it says so, and Regenerate stays available (it re-tags unconfirmed rows)', () => {
    const html = render(overview({ needsUpgrade: 0 }));
    expect(html).toContain("Every item has Coffey's new taste profile");
    expect(html).not.toMatch(/\d+ items? needs? Coffey/);
    expect(buttonTag(html, 'Regenerate with Jev')).not.toMatch(DISABLED);
  });

  it('before the migration: tells the owner to apply it, and the button is DISABLED', () => {
    const html = render(overview({ migrationApplied: false, needsUpgrade: 3 }));
    expect(html).toContain("Apply supabase/2026-10-coffey-traits-v2.sql in Supabase to unlock Coffey's new taste profile");
    expect(html).not.toMatch(/\d+ items? needs? Coffey/);
    expect(buttonTag(html, 'Regenerate with Jev')).toMatch(DISABLED);
  });

  it('explains that owner edits are kept, once it is usable', () => {
    expect(render(overview())).toMatch(/Items you edited keep your edits/);
  });

  it('no banner at all when the base table is missing — just the pointer to its migration', () => {
    const html = render(overview({ rows: [], missingTables: true, migrationApplied: false }));
    expect(html).not.toContain('Regenerate with Jev');
    expect(html).toContain('supabase/2026-09-suggestion-engine.sql');
  });

  it('keeps "Confirm all visible" and drops the old "Generate missing traits" button', () => {
    const html = render(overview());
    expect(html).toContain('Confirm all visible');
    expect(html).not.toContain('Generate missing traits');
  });
});

describe('Traits tab — the per-row read-outs (after the migration)', () => {
  const html = render(overview());

  it('shows a 0–10 sweetness bar', () => {
    expect(html).toContain('aria-label="Sweetness 4 out of 10"');
    expect(html).toContain('width:40%'); // 4/10
  });

  it('dims the bar of a row that is still on the old scale', () => {
    // Espresso: level 0 backfilled from the legacy value, traits_version 1 → an estimate
    expect(html).toContain('aria-label="Sweetness 0 out of 10"');
    expect(html).toContain('bg-tan/50');
  });

  it('has a column each for strength, refresh, treat and novelty, with the values', () => {
    for (const header of ['Strength', 'Refresh', 'Treat', 'Novelty']) expect(html).toContain(header);
    const cells = [...html.matchAll(/<td[^>]*text-center[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);
    // Cappucino Iced first (3, 1, 0, 2), then Espresso's dashes are spans (not matched as plain text)
    expect(cells.slice(0, 4)).toEqual(['3', '1', '0', '2']);
  });

  it('shows up to three textures', () => {
    for (const t of ['silky', 'frothy', 'creamy']) expect(html).toContain(`>${t}</span>`);
  });

  it('shows the top moods from mood_fit with their fit, best first — not the ones below 1', () => {
    expect(html).toContain('boost 2.8');
    expect(html).toContain('focus 2.1');
    expect(html).toContain('cosy 1.4');
    expect(html).not.toContain('unwind 0.4');
    expect(html.indexOf('boost 2.8')).toBeLessThan(html.indexOf('focus 2.1'));
  });

  it('a row not yet tagged at v2 falls back to its plain moods and dashes for the rest', () => {
    expect(html).toContain('boost, cosy');
    expect(html).toContain('needs Coffey profile');
  });

  it('an item with no traits row gets one message across the trait columns', () => {
    const missing = render(overview(), 'missing');
    expect(missing).toContain('Oreo Heaven Cupcake');
    expect(missing).toContain('No traits yet — press “Regenerate with Jev” above.');
    expect(missing).toMatch(/<td colSpan="14"[^>]*>No traits yet/);
  });

  it('offers the "Needs Coffey profile" filter', () => {
    expect(html).toContain('Needs Coffey profile');
  });

  it('shows only unconfirmed rows by default', () => {
    const shown = render(overview({ rows: [row('a', 'Cappucino Iced', { ...V2, confirmed: true }), row('b', 'Espresso', V2)] }));
    expect(shown).toContain('Espresso');
    expect(shown).not.toContain('Cappucino Iced');
  });
});

describe('Traits tab — inline editing (after the migration)', () => {
  const data = overview({
    rows: [row('a', 'Cappucino Iced', V2), row('b', 'Espresso', { ...V1, sweetness_level: 0, traits_version: 1 })],
  });

  it('a v2 row: sweetness on the 0–10 scale, the four 0–3 scores, texture chips and a fit box per mood', () => {
    const html = render(data, 'all', 'a');
    expect(html).toContain('aria-label="Sweetness, 0 to 10"');
    expect(html.match(/<option value="10"/g)?.length).toBeGreaterThanOrEqual(1);
    for (const label of ['Strength', 'Refresh', 'Treat', 'Novelty']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('aria-label="Sweetness, 0 to 3"'); // the legacy select is not offered once migrated
    // the graded fit is edited through eight number boxes (one per mood), not v1 chips
    expect(html.match(/type="number"/g)?.length).toBe(8);
    expect(html).toContain('step="0.1"');
    expect(html).toContain('max="3"');
    for (const mood of ['boost', 'focus', 'unwind', 'cosy', 'comfort', 'celebrate', 'cool', 'surprise']) expect(html).toContain(mood);
    expect(html).toContain('>Save<');
    expect(html).toContain('>Cancel<');
  });

  it('shows the current values in the boxes and selects', () => {
    const html = render(data, 'all', 'a');
    expect(html).toContain('value="2.8"'); // boost fit
    expect(html).toMatch(/<option value="4" selected="">4<\/option>/); // sweetness level
  });

  it('texture chips are toggles; at three, the others are disabled (the limit)', () => {
    const html = render(data, 'all', 'a'); // silky, frothy, creamy already chosen
    for (const t of ['silky', 'frothy', 'creamy']) expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${t}</button>`));
    expect(html).toMatch(/aria-pressed="false" disabled=""[^>]*>icy<\/button>/);
    expect(html).toMatch(/aria-pressed="false" disabled=""[^>]*>chewy<\/button>/);
    expect(html.match(/aria-pressed="(true|false)"/g)?.length).toBeGreaterThanOrEqual(12);
  });

  it('a row not yet graded edits its moods as chips — all eight once migrated — and offers "—" for a score it does not have yet', () => {
    const html = render(data, 'all', 'b');
    for (const m of ['boost', 'focus', 'unwind', 'cosy', 'comfort', 'celebrate', 'cool', 'surprise']) {
      expect(html).toMatch(new RegExp(`aria-pressed="(true|false)"[^>]*>${m}</button>`));
    }
    expect(html).not.toContain('type="number"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>boost<\/button>/); // the v1 mood chips
    expect(html).toMatch(/aria-pressed="false"[^>]*>surprise<\/button>/);
    expect(html).toContain('<option value="" selected="">—</option>');
  });

  it('only the row being edited is in edit mode', () => {
    const html = render(data, 'all', 'a');
    expect(html.match(/>Save</g)?.length).toBe(1);
    expect(html.match(/>Edit</g)?.length).toBe(1); // Espresso keeps its Edit button
  });

  it('a row with no level and no v2 fields at all (half-migrated) falls back to the legacy 0–3 select', () => {
    const legacy = overview({ rows: [row('b', 'Espresso', V1)] });
    const html = render(legacy, 'all', 'b');
    expect(html).toContain('aria-label="Sweetness, 0 to 3"');
    expect(html).not.toContain('aria-label="Sweetness, 0 to 10"');
  });
});

describe('Traits tab — before the migration', () => {
  const pre = overview({
    migrationApplied: false,
    needsUpgrade: 3,
    rows: [row('a', 'Cappucino Iced', { ...V1, sweetness: 2 })],
  });
  const html = render(pre);

  it('shows the legacy 0–3 sweetness as a number, with no 0–10 bar', () => {
    expect(html).not.toContain('Sweetness 2 out of 10');
    expect(html).not.toContain('out of 10');
    expect(html).toMatch(/<td[^>]*>2<\/td>/);
  });

  it('does not offer the "Needs Coffey profile" filter or the "needs Coffey profile" note', () => {
    expect(html).not.toContain('Needs Coffey profile');
    expect(html).not.toContain('needs Coffey profile');
  });

  it('still renders every v1 column', () => {
    for (const header of ['Temp', 'Caffeine', 'Coffee', 'Body', 'Kind', 'Moods', 'Dayparts', 'Flavor notes', 'Status', 'Actions']) expect(html).toContain(header);
  });

  it('editing offers only the six moods the old database CHECK knows — not focus or unwind', () => {
    const editing = render(pre, 'all', 'a');
    for (const m of ['boost', 'cosy', 'comfort', 'celebrate', 'cool', 'surprise']) expect(editing).toMatch(new RegExp(`aria-pressed="(true|false)"[^>]*>${m}</button>`));
    for (const m of ['focus', 'unwind']) expect(editing).not.toMatch(new RegExp(`aria-pressed="(true|false)"[^>]*>${m}</button>`));
  });

  it('editing offers the legacy 0–3 sweetness and none of the v2 controls', () => {
    const editing = render(pre, 'all', 'a');
    expect(editing).toContain('aria-label="Sweetness, 0 to 3"');
    for (const bad of ['Sweetness, 0 to 10', 'aria-label="Strength"', 'type="number"', '>silky<', '>icy<']) expect(editing).not.toContain(bad);
    expect(editing).toContain('>Save<');
  });

  it('tolerates a row with none of the v2 fields', () => {
    expect(html).toContain('Cappucino Iced');
    expect(html).toContain('espresso');
  });
});

describe('Traits tab — a table that scrolls sideways', () => {
  it('sits in a horizontally scrolling wrapper and is wider than a phone', () => {
    const html = render(overview());
    expect(html).toContain('overflow-x-auto');
    expect(html).toMatch(/min-width:\s*1640px/);
  });

  it('pins the item name column', () => {
    expect(render(overview())).toContain('sticky left-0');
  });
});

describe('Traits tab — brand tokens', () => {
  it('tan is decoration only (never text), and the neutrals are the named tokens', () => {
    const html = render(overview());
    expect(html).not.toMatch(/text-tan(?![-\w])/); // text-tan-dark is fine; plain text-tan never is
    expect(html).toContain('bg-tan'); // the sweetness bar's fill
    expect(html).toContain('bg-surface');
    expect(html).toContain('border-line');
    expect(html).not.toContain('bg-[#f2efe9]');
    expect(html).not.toContain('border-[#d8d2c7]');
  });
});
