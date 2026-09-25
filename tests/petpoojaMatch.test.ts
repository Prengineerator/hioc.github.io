import { describe, expect, it } from 'vitest';
import { matchMenuItem } from '@/lib/petpooja/match';
import type { MenuSnapshotItem } from '@/lib/petpooja/types';

// Small invented menu (real menu item names — not PII — but not the full
// live snapshot). Shaped as MenuSnapshotItem (variants as {label} objects,
// not the bare strings the dry-run snapshot JSON uses).
const menu: MenuSnapshotItem[] = [
  { id: 'm-choco-cupcake', name: 'Choco Chip Cupcake', variants: [{ id: 'v-regular', label: 'Regular' }] },
  { id: 'm-garlic-toast', name: 'Garlic Bread Toast', variants: [{ id: 'v-reg2', label: 'Regular' }] },
  {
    id: 'm-tripple-choco',
    name: 'Tripple Choco',
    variants: [
      { id: 'v-b', label: 'B' },
      { id: 'v-l', label: 'L' },
    ],
  },
  {
    id: 'm-signature-creme',
    name: "Hioc's Signature Creme",
    variants: [
      { id: 'v-large', label: 'Large' },
      { id: 'v-xl', label: 'Extra Large' },
    ],
  },
  { name: 'Test Cookie', variants: [{ label: 'Regular' }] }, // no ids, like a dry-run snapshot
  { id: 'm-hazelnut-creme', name: 'Hazelnut Creme', variants: [{ id: 'v-hc-large', label: 'Large' }] },
  { id: 'm-oreo-creme', name: 'Oreo Creme', variants: [{ id: 'v-oc-large', label: 'Large' }] },
  { id: 'm-sig-hot-choc', name: 'Signature Hot Chocolate', variants: [{ id: 'v-shc-large', label: 'Large' }] },
];

describe('matchMenuItem', () => {
  it('matches exactly (case-insensitive)', () => {
    const r = matchMenuItem('choco chip cupcake', '', menu);
    expect(r.matched_menu_name).toBe('Choco Chip Cupcake');
    expect(r.menu_item_id).toBe('m-choco-cupcake');
  });

  it('matches through the alias table', () => {
    const r = matchMenuItem('Garlic Bread', '', menu);
    expect(r.matched_menu_name).toBe('Garlic Bread Toast');
    expect(r.menu_item_id).toBe('m-garlic-toast');
  });

  it("strips a trailing ' waffle' before matching", () => {
    const r = matchMenuItem('Tripple Choco Waffle', 'B', menu);
    expect(r.matched_menu_name).toBe('Tripple Choco');
    expect(r.variant_id).toBe('v-b');
  });

  it('matches a plural Petpooja name to a singular menu item', () => {
    const r = matchMenuItem('Test Cookies', '', menu);
    expect(r.matched_menu_name).toBe('Test Cookie');
  });

  it('matches a singular Petpooja name to a plural menu item', () => {
    const withPlural: MenuSnapshotItem[] = [{ name: 'Sliders', variants: [{ label: 'Regular' }] }];
    const r = matchMenuItem('Slider', '', withPlural);
    expect(r.matched_menu_name).toBe('Sliders');
  });

  it('auto-assigns the single variant when Petpooja recorded none', () => {
    const r = matchMenuItem('Garlic Bread Toast', '', menu);
    expect(r.matched_menu_name).toBe('Garlic Bread Toast');
    expect(r.variant_id).toBe('v-reg2');
  });

  it('leaves variant_id null when the item has more than one variant and none was recorded', () => {
    const r = matchMenuItem('Tripple Choco', '', menu);
    expect(r.matched_menu_name).toBe('Tripple Choco');
    expect(r.variant_id).toBeNull();
  });

  it('matches the variant label case-insensitively', () => {
    const r = matchMenuItem('Tripple Choco', 'l', menu);
    expect(r.variant_id).toBe('v-l');
  });

  it('normalizes a curly apostrophe to match a straight one', () => {
    const r = matchMenuItem('Hioc’s Signature Creme', 'large', menu);
    expect(r.matched_menu_name).toBe("Hioc's Signature Creme");
    expect(r.variant_id).toBe('v-large');
  });

  it('returns nulls with no ids for an item with no id in the snapshot', () => {
    const r = matchMenuItem('Test Cookie', '', menu);
    expect(r.matched_menu_name).toBe('Test Cookie');
    expect(r.menu_item_id).toBeNull();
  });

  it("strips a relaunch-era ' Coffee' category suffix", () => {
    const r = matchMenuItem('Hazelnut Creme Coffee', 'Large', menu);
    expect(r.matched_menu_name).toBe('Hazelnut Creme');
    expect(r.variant_id).toBe('v-hc-large');
  });

  it("strips ' Non-Coffee', falling back to the item's Creme", () => {
    expect(matchMenuItem('Signature Hot Chocolate Non-Coffee', 'Large', menu).matched_menu_name).toBe(
      'Signature Hot Chocolate',
    );
    expect(matchMenuItem('Oreo Non-Coffee', 'Large', menu).matched_menu_name).toBe('Oreo Creme');
  });

  it("turns ' Stick Waffle' into the plain waffle item", () => {
    const r = matchMenuItem('Tripple Choco Stick Waffle', 'L', menu);
    expect(r.matched_menu_name).toBe('Tripple Choco');
    expect(r.variant_id).toBe('v-l');
  });

  it('maps a pre-relaunch name to its current successor', () => {
    expect(matchMenuItem('Hazelnut Frappe', 'Large', menu).matched_menu_name).toBe('Hazelnut Creme');
    expect(matchMenuItem('Hot Chocolate', 'Large', menu).matched_menu_name).toBe('Signature Hot Chocolate');
  });

  it('does not strip a suffix when the rest still matches nothing', () => {
    expect(matchMenuItem('Corporate Coffee', '', menu).matched_menu_name).toBeNull();
  });

  it('returns all nulls for a genuinely unmatched (discontinued) item', () => {
    const r = matchMenuItem('Nutella Hazelnut Crepes', '', menu);
    expect(r).toEqual({ menu_item_id: null, variant_id: null, matched_menu_name: null });
  });
});
