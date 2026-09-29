import { describe, expect, it } from 'vitest';
import { flavourFamiliesOf } from '@/lib/suggest/flavor';
import { FLAVOR_VOCABULARY } from '@/lib/suggest/traitVocabulary';
import { FLAVOUR_FAMILIES } from '@/lib/suggest/types';

// COFFEY-SPEC §1 "Flavours you love" / §4.2 preference term: an item belongs to
// every flavour family whose pattern (lib/suggest/traitVocabulary.ts) matches its
// name or any flavour note. These are SOFT preferences — lib/suggest/score.ts
// scores them, lib/suggest/filter.ts never filters on them.

describe('flavourFamiliesOf', () => {
  it('matches by name', () => {
    expect(flavourFamiliesOf('Signature Hot Chocolate', [])).toContain('chocolatey');
    expect(flavourFamiliesOf('Nutella Waffle', [])).toContain('chocolatey');
    expect(flavourFamiliesOf('Kit-Kat Frappe', [])).toContain('chocolatey');
    expect(flavourFamiliesOf('Double Fudge Brownie', [])).toContain('chocolatey');
    expect(flavourFamiliesOf('Fruity Strawberry Creme', [])).toContain('fruity');
    expect(flavourFamiliesOf('Berry Lemonade Iced', [])).toContain('fruity');
    expect(flavourFamiliesOf('Passionfruit Iced Tea', [])).toContain('fruity');
    expect(flavourFamiliesOf('Salted Caramel Latte', [])).toContain('caramel');
    expect(flavourFamiliesOf('Hazelnut Creme', [])).toContain('nutty');
    expect(flavourFamiliesOf('Lotus Biscoff Shake', [])).toContain('biscuit');
    expect(flavourFamiliesOf('Cinnamon Roll', [])).toContain('spiced');
    expect(flavourFamiliesOf('Rose Latte', [])).toContain('floral');
  });

  it('matches by flavour note when the name gives no hint', () => {
    expect(flavourFamiliesOf('Mocha', ['chocolate', 'coffee-forward'])).toContain('chocolatey');
    expect(flavourFamiliesOf('Signature Blend', ['cocoa', 'nutty'])).toEqual(['chocolatey', 'nutty']);
    expect(flavourFamiliesOf('Signature Cooler', ['citrus', 'zesty'])).toContain('fruity');
    expect(flavourFamiliesOf('House Special', ['blueberry'])).toContain('fruity');
  });

  it('is case-insensitive', () => {
    expect(flavourFamiliesOf('CHOCOLATE FUDGE CAKE', [])).toContain('chocolatey');
    expect(flavourFamiliesOf('STRAWBERRY SMOOTHIE', [])).toContain('fruity');
    expect(flavourFamiliesOf('x', ['CARAMEL'])).toEqual(['caramel']);
  });

  it('is empty for an item that belongs to no family', () => {
    expect(flavourFamiliesOf('Espresso', ['bold'])).toEqual([]);
    expect(flavourFamiliesOf('Latte', [])).toEqual([]);
    expect(flavourFamiliesOf('', [])).toEqual([]);
  });

  it('does not confuse the families', () => {
    expect(flavourFamiliesOf('Berry Lemonade Iced', ['berry', 'citrus'])).toEqual(['fruity']);
    expect(flavourFamiliesOf('Espresso', ['bold', 'nutty'])).toEqual(['nutty']);
    expect(flavourFamiliesOf('Signature Hot Chocolate', ['chocolate'])).not.toContain('fruity');
  });

  it('puts an item in EVERY family it belongs to (that is what makes OR semantics work)', () => {
    expect(flavourFamiliesOf('Oreo Creme', ['oreo', 'creamy'])).toEqual(['chocolatey', 'biscuit']);
    expect(flavourFamiliesOf('Nutella Shake', ['chocolate', 'hazelnut'])).toEqual(['chocolatey', 'nutty']);
    expect(flavourFamiliesOf('Biscoff Cheesecake', ['biscoff', 'creamy'])).toEqual(['biscuit', 'spiced']);
  });

  it('returns families in FLAVOUR_FAMILIES order, whichever text matched first', () => {
    // The note is fruity, the name is chocolatey — the order is the vocabulary's.
    const families = flavourFamiliesOf('Chocolate Brownie', ['strawberry', 'caramel']);
    expect(families).toEqual(['chocolatey', 'caramel', 'fruity']);
    const positions = families.map((f) => FLAVOUR_FAMILIES.indexOf(f));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("has no 'savoury' family: \"Something savoury\" is what `kinds: ['food']` asks, so savoury dishes belong to none", () => {
    expect(FLAVOUR_FAMILIES as readonly string[]).not.toContain('savoury');
    expect(flavourFamiliesOf('Cheesy Garlic Bread', ['garlic', 'cheesy'])).toEqual([]);
    expect(flavourFamiliesOf('Baked Cheese Nachos', ['cheesy', 'spicy'])).toEqual([]);
    // …while a dish that also happens to be caramel or fruity still is.
    expect(flavourFamiliesOf('Blueberry Cheesecake', ['blueberry', 'cream cheese'])).toEqual(['fruity']);
    expect(flavourFamiliesOf('Red Velvet Cupcake', ['vanilla', 'cream cheese'])).toEqual(['chocolatey']);
  });

  it('tolerates a row with no notes at all', () => {
    expect(flavourFamiliesOf('Mocha', undefined as unknown as string[])).toContain('chocolatey');
  });

  it("agrees with the tagger's vocabulary: every fixed flavour note lands in the family it is declared for", () => {
    // Jev tags from FLAVOR_VOCABULARY and the customer asks by family, so a note
    // whose declared family the matcher did not recognise would silently never match.
    for (const { note, family } of FLAVOR_VOCABULARY) {
      const families = flavourFamiliesOf('Some Item', [note]);
      if (family) expect(families, `note "${note}"`).toContain(family);
      else expect(families, `note "${note}" has no family`).toEqual([]);
    }
  });
});
