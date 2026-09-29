import { describe, expect, it } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.2) — withRelatedDescriptions. 49 of the 117
// live items have no description (waffle crepes, chips, cupcakes,
// cheesecakes…), so an item with none borrows the description of another item
// that shares a DISTINCTIVE name token — and the borrowed text names the item it
// came from, so Jev knows it describes a different one. An item whose name has
// no distinctive token at all ("Choco-Chip Crepes") borrows from the item whose
// whole name it contains ("Choco-Chips") instead. Pure.

import { buildJevTraitState, withRelatedDescriptions, type MenuItemForTagging } from '@/lib/suggest/traitsPrompt';

function item(name: string, description = ''): MenuItemForTagging {
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    description,
    category: 'Waffles',
    parent_category: '',
    sizes: [{ label: 'Regular', price_inr: 100 }],
    customisations: [],
  };
}

/** What an item borrows from `name`: the source's NAME, then its description. */
const from = (name: string, description: string) => `From the related menu item "${name}": ${description}`;

/** name → related_description, for the items that got one. */
function related(items: MenuItemForTagging[]): Record<string, string | undefined> {
  return Object.fromEntries(withRelatedDescriptions(items).map((i) => [i.name, i.related_description]));
}

describe('withRelatedDescriptions — the examples from COFFEY-SPEC §3.2', () => {
  it('"Oreo Heaven Cupcake" ← "Oreo-Heaven"', () => {
    const r = related([item('Oreo Heaven Cupcake'), item('Oreo-Heaven', 'A dreamy waffle with an Oreo-infused base.')]);
    expect(r['Oreo Heaven Cupcake']).toBe(from('Oreo-Heaven', 'A dreamy waffle with an Oreo-infused base.'));
  });

  it('"Black Forest Chips" ← "Black Forest"', () => {
    const r = related([item('Black Forest Chips'), item('Black Forest', 'Vanilla waffle topped with dark chocolate and cherries.')]);
    expect(r['Black Forest Chips']).toBe(from('Black Forest', 'Vanilla waffle topped with dark chocolate and cherries.'));
  });

  it('"Nutella Stuffed" ← "Nutella" (of several Nutella items — the closest name wins the tie)', () => {
    const r = related([
      item('Nutella Stuffed'),
      item('Nutella-Almond', 'Nutella-Almond waffle.'),
      item('Nutella Mocha', 'A Nutella mocha.'),
      item('Nutella', 'Nutella waffle with a chocolate drizzle.'),
      item('Nutella Iced Mocha', 'An iced Nutella mocha.'),
    ]);
    expect(r['Nutella Stuffed']).toBe(from('Nutella', 'Nutella waffle with a chocolate drizzle.'));
  });

  // The real menu has "Minion Creme (Nutella-Banana)", which sorts BEFORE
  // "Nutella". A tie-break by name alone would hand the stuffed waffle a
  // drink's description; the closest name is the one the spec names.
  it('…even when another Nutella item sorts first alphabetically', () => {
    const r = related([
      item('Minion Creme (Nutella-Banana)', 'A playful, creamy cold coffee blend of Nutella and banana.'),
      item('Nutella Stuffed'),
      item('Nutella', 'Nutella waffle with a chocolate drizzle.'),
      item('Nutella Almond Croissant'),
      item('Nutella-Hazelnut', 'Nutella-Hazelnut waffle.'),
    ]);
    expect(r['Nutella Stuffed']).toBe(from('Nutella', 'Nutella waffle with a chocolate drizzle.'));
    // the croissant shares just "nutella" with each of them; "Nutella" has no extra words, so it is the closest
    expect(r['Nutella Almond Croissant']).toBe(from('Nutella', 'Nutella waffle with a chocolate drizzle.'));
  });

  // "choco" is a generic word now (it linked unrelated items), so this pair is
  // related on "tripple" alone, and "Choco-Chips" — which has only generic words
  // in common with it — is not a candidate at all.
  it('"Tripple Choco Crepes" ← "Tripple Choco" (on "tripple"; "Choco-Chips" shares only generic words)', () => {
    const r = related([
      item('Tripple Choco Crepes'),
      item('Choco-Chips', "A chocolate lover's waffle."),
      item('Tripple Choco', 'Triple chocolate waffle on a vanilla base.'),
    ]);
    expect(r['Tripple Choco Crepes']).toBe(from('Tripple Choco', 'Triple chocolate waffle on a vanilla base.'));
    expect(related([item('Tripple Choco Crepes'), item('Choco-Chips', "A chocolate lover's waffle.")])['Tripple Choco Crepes']).toBeUndefined();
  });
});

describe('withRelatedDescriptions — what is borrowed', () => {
  it('is the source item\'s name in quotes, then its description', () => {
    const r = related([item('Rose Slice'), item('Rose Latte', 'A delicate fusion of espresso, steamed milk and rose syrup.')]);
    expect(r['Rose Slice']).toBe('From the related menu item "Rose Latte": A delicate fusion of espresso, steamed milk and rose syrup.');
  });

  it("keeps the source's name exactly as the menu spells it", () => {
    const r = related([item('Oreo Heaven Cupcake'), item('Oreo-Heaven', 'The waffle.')]);
    expect(r['Oreo Heaven Cupcake']).toMatch(/^From the related menu item "Oreo-Heaven": /);
  });

  it("trims the source's description", () => {
    const r = related([item('Rose Slice'), item('Rose Latte', '  Rose and milk.  \n')]);
    expect(r['Rose Slice']).toBe(from('Rose Latte', 'Rose and milk.'));
  });

  it('turns a double quote in the source name into a single one, so the quoting stays unambiguous', () => {
    const r = related([item('Pistachio Slice'), item('Pistachio "Dream" Waffle', 'A pistachio waffle.')]);
    expect(r['Pistachio Slice']).toBe(`From the related menu item "Pistachio 'Dream' Waffle": A pistachio waffle.`);
  });

  it("reaches Jev in the item's state, as the related_description", () => {
    const [filled] = withRelatedDescriptions([item('Oreo Heaven Cupcake'), item('Oreo-Heaven', 'The waffle.')]);
    const state = buildJevTraitState(filled) as { item: Record<string, unknown> };
    expect(state.item.description).toBe('');
    expect(state.item.related_description).toBe('From the related menu item "Oreo-Heaven": The waffle.');
  });
});

describe('withRelatedDescriptions — what counts as related', () => {
  it('generic words never make two items related', () => {
    const r = related([
      item('Vanilla Crepes'),
      item('Mango Crepes', 'Mango crepes.'),
      item('Strawberry Cheesecake'),
      item('Mango Cheesecake', 'Mango cheesecake.'),
      item('Iced Vanilla Latte'),
      item('Iced Americano', 'An iced americano.'),
      item('Hot Latte'),
      item('Signature Cold Brew', 'A cold brew.'),
      item('Stuffed Slice'),
      item('Cupcake With Waffle And Chips', 'A cupcake.'),
    ]);
    expect(r['Vanilla Crepes']).toBeUndefined();
    expect(r['Strawberry Cheesecake']).toBeUndefined();
    expect(r['Iced Vanilla Latte']).toBeUndefined();
    expect(r['Hot Latte']).toBeUndefined();
    expect(r['Stuffed Slice']).toBeUndefined();
  });

  const SPEC_GENERIC = ['waffle', 'waffles', 'creme', 'crepes', 'chips', 'cupcake', 'slice', 'iced', 'latte', 'signature', 'hioc', 'stuffed', 'cheesecake', 'cold', 'brew', 'hot', 'with', 'and'];
  // Added after running the tagger's related-description lookup over the real
  // menu: each of these linked items that have nothing to do with each other.
  const ADDED_GENERIC = ['white', 'dark', 'honey', 'choco', 'chocolate', 'berry', 'orange', 'truffle', 'cream', 'milk'];

  it.each([...SPEC_GENERIC, ...ADDED_GENERIC])('the word "%s" alone never relates two items', (word) => {
    const r = related([item(`Zzz ${word}`), item(`Yyy ${word}`, 'Has a description.')]);
    expect(r[`Zzz ${word}`]).toBeUndefined();
  });

  it.each(['Whites', 'Truffles', 'Chocolates', 'Creams', 'Oranges', 'Honeys'])('…and neither does its plural "%s"', (word) => {
    const r = related([item(`Zzz ${word}`), item(`Yyy ${word}`, 'Has a description.')]);
    expect(r[`Zzz ${word}`]).toBeUndefined();
  });

  it('generic words alone do nothing — and do no harm next to a distinctive one', () => {
    const alone = related([item('Zzz Honey Orange'), item('Yyy Honey Orange Kiwi', 'Has a description.')]);
    expect(alone['Zzz Honey Orange']).toBeUndefined(); // nothing but generic words in common
    const together = related([item('Kiwi Honey'), item('Kiwi Orange Tea', 'Kiwi tea.')]);
    expect(together['Kiwi Honey']).toBe(from('Kiwi Orange Tea', 'Kiwi tea.')); // related on "kiwi"
  });

  it('accents fold: "Crème" is the generic "creme"', () => {
    const r = related([item('Vanilla Crème'), item('Mango Creme', 'A mango creme.')]);
    expect(r['Vanilla Crème']).toBeUndefined();
  });

  it('an item that has its own description is left alone', () => {
    const own = item('Nutella Waffle', 'Its own description.');
    const [out] = withRelatedDescriptions([own, item('Nutella', 'Another description.')]);
    expect(out).toBe(own);
    expect(out).not.toHaveProperty('related_description');
  });

  it('whitespace-only counts as empty, on both sides', () => {
    const r = related([item('Biscoff Stuffed', '   '), item('Lotus Biscoff Waffle', '  \n '), item('Biscoff Eclair', 'Eclair with Biscoff.')]);
    expect(r['Biscoff Stuffed']).toBe(from('Biscoff Eclair', 'Eclair with Biscoff.'));
    expect(r['Lotus Biscoff Waffle']).toBe(from('Biscoff Eclair', 'Eclair with Biscoff.'));
    expect(r['Biscoff Eclair']).toBeUndefined();
  });

  it('an item with no description anywhere to borrow gets nothing', () => {
    const r = related([item('Rose Slice'), item('Rose Crepes')]);
    expect(r['Rose Slice']).toBeUndefined();
    expect(r['Rose Crepes']).toBeUndefined();
  });

  // (One that DOES contain a source's whole name is another matter — see "an item
  // with no distinctive word borrows from a name it contains" below.)
  it('an item with no distinctive token, and no source whose whole name it contains, is left alone', () => {
    const [out] = withRelatedDescriptions([item('Signature Iced Latte'), item('Hot Latte', 'A latte.')]);
    expect(out).not.toHaveProperty('related_description');
  });

  it('is case-insensitive', () => {
    const r = related([item('OREO HEAVEN cupcake'), item('oreo-heaven', 'The waffle.')]);
    expect(r['OREO HEAVEN cupcake']).toBe(from('oreo-heaven', 'The waffle.'));
  });

  it('tokens are split on non-letters: hyphens, digits, apostrophes', () => {
    const r = related([item('Hazel-Nut Crepes'), item('Hazel2Nut', 'A hazelnut waffle.')]);
    expect(r['Hazel-Nut Crepes']).toBe(from('Hazel2Nut', 'A hazelnut waffle.'));
  });

  it('a stray letter from an apostrophe is not a token — "Devil\'s" is not related to "Hioc\'s"', () => {
    const r = related([item("Devil's Fantasy"), item("Hioc's Signature Creme", 'A cold coffee.'), item("90's Sundae")]);
    expect(r["Devil's Fantasy"]).toBeUndefined();
    expect(r["90's Sundae"]).toBeUndefined();
  });

  it('but the real word still matches: "Devil\'s Fantasy" ← "Dark Fantasy"', () => {
    const r = related([item("Devil's Fantasy"), item('Dark Fantasy', 'An indulgent dark chocolate waffle.')]);
    expect(r["Devil's Fantasy"]).toBe(from('Dark Fantasy', 'An indulgent dark chocolate waffle.'));
  });

  it('a plural "s" is stripped from tokens of 5 or more letters', () => {
    expect(related([item('Cookie Sundae'), item('Cookies Waffle', 'Cookies.')])['Cookie Sundae']).toBe(from('Cookies Waffle', 'Cookies.'));
    expect(related([item('Brownies Sundae'), item('Brownie', 'A brownie.')])['Brownies Sundae']).toBe(from('Brownie', 'A brownie.'));
  });

  it('…but not from shorter ones ("nuts" is not "nut")', () => {
    expect(related([item('Nut Sundae'), item('Nuts Waffle', 'Nuts.')])['Nut Sundae']).toBeUndefined();
  });
});

describe('withRelatedDescriptions — which related item wins', () => {
  it('the one sharing the most distinctive tokens', () => {
    const r = related([
      item('Red Velvet Almond Cupcake'),
      item('Almond Delight', 'One shared token.'),
      item('Red Velvet Almond Waffle', 'Three shared tokens.'),
      item('Red Velvet', 'Two shared tokens.'),
    ]);
    expect(r['Red Velvet Almond Cupcake']).toBe(from('Red Velvet Almond Waffle', 'Three shared tokens.'));
  });

  it('a tie on shared words goes to the closest name: the candidate with the fewest words the item lacks', () => {
    const one = related([item('Mango Slice'), item('Mango Passion Iced Matcha', 'Long.'), item('Mango', 'Just mango.')]);
    expect(one['Mango Slice']).toBe(from('Mango', 'Just mango.'));

    const two = related([item('Red Velvet Cupcake'), item('Red Velvet Cake Special', 'Wordy.'), item('Red Velvet', 'Plain.')]);
    expect(two['Red Velvet Cupcake']).toBe(from('Red Velvet', 'Plain.')); // both share {red, velvet}; only one has extra words
  });

  it('then to the candidate sharing more generic words: "Matcha Latte Iced" ← "Matcha Latte", not "Matcha Creme"', () => {
    const r = related([
      item('Matcha Latte Iced'),
      item('Matcha Creme', 'A velvety, creamy blend of matcha.'),
      item('Matcha Latte', 'A matcha latte with steamed milk.'),
    ]);
    expect(r['Matcha Latte Iced']).toBe(from('Matcha Latte', 'A matcha latte with steamed milk.'));
  });

  it('and only then by name, whatever order the menu loaded in', () => {
    const a = item('Mango Iced Matcha', 'Matcha.');
    const b = item('Mango Cheesecake', 'Cheesecake.');
    const c = item('Mango Slice');
    // "Mango Iced Matcha" has an extra distinctive word (matcha); "Mango Cheesecake" has none
    expect(related([a, b, c])['Mango Slice']).toBe(from('Mango Cheesecake', 'Cheesecake.'));
    expect(related([c, b, a])['Mango Slice']).toBe(from('Mango Cheesecake', 'Cheesecake.'));
    expect(related([b, c, a])['Mango Slice']).toBe(from('Mango Cheesecake', 'Cheesecake.'));
    // equal in every other way: alphabetical
    const x = item('Zed Mango', 'Zed.');
    const y = item('Alpha Mango', 'Alpha.');
    expect(related([x, y, item('Mango Slice')])['Mango Slice']).toBe(from('Alpha Mango', 'Alpha.'));
    expect(related([item('Mango Slice'), y, x])['Mango Slice']).toBe(from('Alpha Mango', 'Alpha.'));
  });

  it('name order ignores case', () => {
    const r = related([item('Mango Slice'), item('mango tea', 'Tea.'), item('Mango Ade', 'Ade.')]);
    expect(r['Mango Slice']).toBe(from('Mango Ade', 'Ade.'));
  });

  it('never picks itself', () => {
    const r = related([item('Rose Latte')]);
    expect(r['Rose Latte']).toBeUndefined();
  });
});

// An item whose name is ONLY generic words ("Choco-Chip Crepes": choco, chip,
// crepes) has no distinctive token to be related on, so it takes a second route:
// a source whose WHOLE name — two words or more, normalised like every other
// token — is contained in its own. The longest such source wins, then the one
// that reads as a phrase inside the item's name, then name order. An item with
// even one distinctive word never takes this route.
describe('withRelatedDescriptions — an item with no distinctive word borrows from a name it contains', () => {
  const CHOCO_CHIPS = "Choco-Chips Waffle is a chocolate lover's dream with a rich chocolate waffle base.";
  const chocoChips = () => item('Choco-Chips', CHOCO_CHIPS);

  it.each(['Choco-Chip Crepes', 'Choco-Chip Chips', 'Choco-Chip Stuffed', 'Choco Chip Cupcake'])('"%s" ← "Choco-Chips"', (name) => {
    expect(related([item(name), chocoChips()])[name]).toBe(from('Choco-Chips', CHOCO_CHIPS));
  });

  it('"Signature Iced Latte" ← "Iced Latte": the whole of a two-word name, inside a longer one', () => {
    const r = related([item('Signature Iced Latte'), item('Iced Latte', 'A latte over ice.')]);
    expect(r['Signature Iced Latte']).toBe(from('Iced Latte', 'A latte over ice.'));
  });

  it('borrows the same text, and reaches Jev the same way, as the ranking route', () => {
    const [filled] = withRelatedDescriptions([item('Choco-Chip Crepes'), chocoChips()]);
    const state = buildJevTraitState(filled) as { item: Record<string, unknown> };
    expect(state.item.description).toBe('');
    expect(state.item.related_description).toBe(`From the related menu item "Choco-Chips": ${CHOCO_CHIPS}`);
  });

  it.each(['CHOCO-CHIP CREPES', 'choco chip crepes', 'Choco2Chip Crepes', 'Choco-Chips Crepe', 'Chöco Chip Crépes'])(
    'normalises like every other token — case, accents, hyphens, digits, plurals: "%s"',
    (name) => {
      expect(related([item(name), chocoChips()])[name]).toBe(from('Choco-Chips', CHOCO_CHIPS));
    },
  );

  it('…on the source side too: "CRÈME-LATTES" is inside "Signature Creme Latte"', () => {
    const r = related([item('Signature Creme Latte'), item('CRÈME-LATTES', 'A creme latte.')]);
    expect(r['Signature Creme Latte']).toBe(from('CRÈME-LATTES', 'A creme latte.'));
  });

  it('needs a source of at least two words: one shared generic word is not a name', () => {
    // ("Latte Latte" is one word once a repeat is folded, and "Chips" is "chip" — still not two)
    const r = related([item('Signature Iced Latte'), item('Latte', 'A latte.'), item('Iced', 'Iced.'), item('Latte Latte', 'Twice.')]);
    expect(r['Signature Iced Latte']).toBeUndefined();
    expect(related([item('Choco-Chip Crepes'), item('Chips', 'Chips.')])['Choco-Chip Crepes']).toBeUndefined();
  });

  it("the source's WHOLE name must be inside the item's: sharing part of it is not enough", () => {
    const r = related([
      item('Choco-Chip Crepes'),
      item('Choco-Chips Sundae', 'A sundae.'), // "sundae" is not in the item's name
      item('Choco Latte', 'A latte.'), // neither is "latte"
      item('Chip Waffle Stack', 'Stacked.'), // nor "waffle" and "stack"
    ]);
    expect(r['Choco-Chip Crepes']).toBeUndefined();
  });

  it('the source must have a description of its own', () => {
    const r = related([item('Choco-Chip Crepes'), item('Choco-Chips'), item('Choco Chip', '  \n ')]);
    expect(r['Choco-Chip Crepes']).toBeUndefined();
    expect(r['Choco-Chips']).toBeUndefined(); // and it, having none either, stays empty
  });

  it('an item that has its own description is left alone', () => {
    const own = item('Choco-Chip Crepes', 'Its own description.');
    const [out] = withRelatedDescriptions([own, chocoChips()]);
    expect(out).toBe(own);
  });

  describe('which source wins', () => {
    /** Every menu order worth trying: as given, reversed, and rotated. */
    const orders = <T>(list: T[]): T[][] => [list, [...list].reverse(), [...list.slice(1), list[0]], [list[list.length - 1], ...list.slice(0, -1)]];

    it('the longest whole name, in any menu order', () => {
      const target = item('Iced Choco Chip Crepes');
      const sources = [item('Choco-Chips', 'Two words.'), item('Iced Choco Chip', 'Three words.'), item('Iced Choco', 'Two more.')];
      for (const menu of orders([target, ...sources])) {
        expect(related(menu)['Iced Choco Chip Crepes']).toBe(from('Iced Choco Chip', 'Three words.'));
      }
    });

    it('longest comes first: a longer name beats a shorter one that reads more like a phrase', () => {
      // "Iced Chip Crepes" has three words, none of them adjacent to "iced" in the item's name;
      // "Choco Chip" has two, and is a phrase inside it
      const target = item('Iced Choco Chip Crepes');
      const sources = [item('Choco Chip', 'Two words, a phrase.'), item('Iced Chip Crepes', 'Three words, scattered.')];
      for (const menu of orders([target, ...sources])) {
        expect(related(menu)['Iced Choco Chip Crepes']).toBe(from('Iced Chip Crepes', 'Three words, scattered.'));
      }
    });

    it('then the closest: the one whose words read as a phrase inside the name — not merely the one that sorts first', () => {
      // "Chip Cupcake" sorts before "Choco Cupcake", but in "Chip Choco Cupcake" it is
      // "choco cupcake" that sits together
      const target = item('Chip Choco Cupcake');
      const sources = [item('Chip Cupcake', 'Scattered.'), item('Choco Cupcake', 'Together.')];
      for (const menu of orders([target, ...sources])) {
        expect(related(menu)['Chip Choco Cupcake']).toBe(from('Choco Cupcake', 'Together.'));
      }
    });

    it('and only then by name, whatever order the menu loaded in', () => {
      // both are two words and both sit together inside "Choco Chip Cupcake"
      const target = item('Choco Chip Cupcake');
      const sources = [item('Choco Chip', 'Choco Chip.'), item('Chip Cupcake', 'Chip Cupcake.')];
      for (const menu of orders([target, ...sources])) {
        expect(related(menu)['Choco Chip Cupcake']).toBe(from('Chip Cupcake', 'Chip Cupcake.'));
      }
      // name order ignores case: by raw character codes "CHOCO CHIP" would come first
      expect(related([target, item('CHOCO CHIP', 'Upper.'), item('chip cupcake', 'Lower.')])['Choco Chip Cupcake']).toBe(from('chip cupcake', 'Lower.'));
    });
  });

  describe('it never runs for an item that has a distinctive word', () => {
    // "Kiwi" is distinctive, so these are ranked on distinctive words alone — and
    // nothing shares "kiwi" with them, though "Choco-Chips" is wholly inside each name.
    it.each(['Choco-Chip Kiwi Crepes', 'Kiwi Choco Chip Cupcake', 'Choco Chip Cupcake Kiwi', 'Kiwi Choco-Chip Stuffed'])(
      '"%s" gets nothing from "Choco-Chips"',
      (name) => {
        expect(related([item(name), chocoChips()])[name]).toBeUndefined();
        const [out] = withRelatedDescriptions([item(name), chocoChips()]);
        expect(out).not.toHaveProperty('related_description');
      },
    );

    it('and when something does share the distinctive word, that is what it gets — whatever names it contains', () => {
      const r = related([item('Choco-Chip Kiwi Crepes'), chocoChips(), item('Kiwi Tea', 'A kiwi tea.')]);
      expect(r['Choco-Chip Kiwi Crepes']).toBe(from('Kiwi Tea', 'A kiwi tea.'));
    });

    it('not even a longer contained name outranks it', () => {
      const r = related([
        item('Iced Choco-Chip Kiwi Crepes'),
        item('Iced Choco Chip', 'Three words, all inside.'),
        item('Kiwi', 'A kiwi.'),
      ]);
      expect(r['Iced Choco-Chip Kiwi Crepes']).toBe(from('Kiwi', 'A kiwi.'));
    });

    it('a single distinctive word is enough to keep it out', () => {
      // the same words as "Choco-Chip Crepes", plus one distinctive one
      expect(related([item('Choco-Chip Crepes'), chocoChips()])['Choco-Chip Crepes']).toBe(from('Choco-Chips', CHOCO_CHIPS));
      expect(related([item('Choco-Chip Crepes Deluxe'), chocoChips()])['Choco-Chip Crepes Deluxe']).toBeUndefined();
    });
  });

  it('a name with no usable words is not a source — an empty name would be "contained" in every other', () => {
    const r = related([item('Choco-Chip Crepes'), item('Ab Cd', 'Two-letter words.'), item('---', 'Symbols.'), item('12', 'Digits.')]);
    expect(r['Choco-Chip Crepes']).toBeUndefined();
  });

  it('…and one with none gets nothing itself, and breaks nothing', () => {
    const r = related([item('---'), item('12'), item(''), item('Ab Cd'), chocoChips()]);
    for (const name of ['---', '12', '', 'Ab Cd']) expect(r[name], name).toBeUndefined();
  });

  it('does not mutate its input, returns what it could not fill as it was, and is idempotent', () => {
    const crepes = item('Choco-Chip Crepes');
    const chips = chocoChips();
    const lonely = item('Signature Iced Latte');
    const out = withRelatedDescriptions([crepes, chips, lonely]);
    expect(crepes).not.toHaveProperty('related_description');
    expect(out[0]).toEqual({ ...crepes, related_description: from('Choco-Chips', CHOCO_CHIPS) });
    expect(out[1]).toBe(chips);
    expect(out[2]).toBe(lonely);
    expect(withRelatedDescriptions(out)).toEqual(out);
  });
});

// The real menu, abbreviated: the families that showed what the first version of
// the lookup got wrong. Descriptions are shortened; names are the live ones.
describe('withRelatedDescriptions — regressions from running it over the real menu', () => {
  const DESCRIBED: [string, string][] = [
    ['Flat White', 'A Flat White is a meticulously crafted coffee with a rich espresso base and velvety microfoam.'],
    ['Almond Honey', 'Almond Honey Waffle is a soft vanilla and almond waffle topped with sweet honey.'],
    ['Honey Cinnamon', 'A Honey Cinnamon Latte blends rich espresso with steamed milk, honey and cinnamon.'],
    ['Signature Hot Chocolate', 'A Signature Hot Chocolate is a rich blend of smooth milk and premium chocolate.'],
    ['Hazelnut Hot Chocolate', 'A Hazelnut Hot Chocolate is rich chocolate, creamy milk and roasted hazelnut.'],
    ['Signature Chocolate Creme', 'Signature Chocolate Crème is a creamy cold blend of rich chocolate and espresso.'],
    ['Choco-Chips', "Choco-Chips Waffle is a chocolate lover's dream with a rich chocolate waffle base."],
    ['Tripple Choco', 'Triple Choco Waffle is a soft vanilla waffle topped with creamy milk chocolate.'],
    ['Dark Fantasy', 'Dark Fantasy Waffle is an indulgent waffle with a rich chocolate base and dark chocolate.'],
    ['White Garland', 'White Garland Waffle has a red velvet base topped with creamy white chocolate.'],
    ['Black Forest', 'Black Forest Waffle has a soft vanilla base, dark chocolate and cherries.'],
    ['Oreo-Heaven', 'Oreo-Heaven Waffle is a dreamy treat with an Oreo-infused base.'],
    ['Oreo Creme', 'Oreo Crème is a velvety blend of crushed Oreo cookies and chocolate.'],
    ['Nutella', 'Nutella Waffle has a soft vanilla base, creamy Nutella and a chocolate drizzle.'],
    ['Nutella-Almond', 'Nutella-Almond Waffle has a vanilla and almond base with creamy Nutella.'],
    ['Nutella-Hazelnut', 'Nutella-Hazelnut Waffle has a vanilla and hazelnut base with creamy Nutella.'],
    ['Nutella Mocha', 'A Nutella Mocha is espresso, steamed milk and Nutella spread.'],
    ['Minion Creme (Nutella-Banana)', 'Minion Crème is a playful, creamy blend of Nutella and banana.'],
    ['Lotus Biscoff Creme', 'Lotus Biscoff Crème is a rich cold coffee with Lotus Biscoff biscuits.'],
    ['Lotus Biscoff Latte', 'A Lotus Biscoff Latte is espresso, steamed milk and a swirl of Biscoff spread.'],
    ['Matcha Latte', 'A Matcha Latte combines finely ground matcha with steamed milk.'],
    ['Matcha Creme', 'Matcha Crème is a velvety, creamy blend of finely ground green tea.'],
    ['Cappucino', 'A Cappucino is espresso, steamed milk and silky micro-foam.'],
    ['Cappucino Iced', 'Iced Cappuccino blends espresso with frothy milk and ice.'],
    ['Cookie Crumble Creme', 'Cookie Crème is a dreamy cold coffee with crushed cookies.'],
    ['Fruity Mango Creme', 'Mango Crème is a rich, creamy blend with ripe mangoes.'],
    ['Blueberry Cheesecake Creme', 'Blueberry Cheesecake Crème is a creamy blend with blueberry cheesecake.'],
    ['Pistachio Latte', 'A Pistachio Latte is steamed milk with pistachio syrup.'],
    ["Hioc's Signature Creme", 'Hioc Signature Crème is a velvety, creamy cold coffee.'],
  ];

  /** Empty-description items → the item each should borrow from (null: none). */
  const EMPTY: [string, string | null][] = [
    // the weak matches this change removed (the first three are all-generic names, so
    // they take the containment route too — and no whole name is inside any of them)
    ['White Truffle Slice', null], // was "Flat White", on "white"
    ['Choco Berry Iced', null], // was "Choco-Chips", on "choco"
    ['Choco Truffle Slice', null], // was "Choco-Chips", on "choco"
    ['Ginger Orange Honey Tea', null], // was "Almond Honey", on "honey"
    ['Death By Chocolate Brownie', null], // was a chocolate drink, on "chocolate"
    // families that were only ever related through words that are generic now
    ['Dark Chip Crepes', null], // all generic; "Choco-Chips" is not inside it ("choco")
    ['Signature Cream Stuffed', null],
    ["90's Sundae", null],
    ["Hioc's Signature Tiramisu", null],
    // all-generic names that contain a whole name: the containment route
    ['Choco-Chip Crepes', 'Choco-Chips'],
    ['Choco-Chip Chips', 'Choco-Chips'],
    ['Choco-Chip Stuffed', 'Choco-Chips'],
    ['Choco Chip Cupcake', 'Choco-Chips'],
    // the relations that are right, and stay
    ['Tripple Choco Crepes', 'Tripple Choco'],
    ['Tripple Choco Chips', 'Tripple Choco'],
    ['Black Forest Chips', 'Black Forest'],
    ['Oreo Heaven Cupcake', 'Oreo-Heaven'],
    ['Oreo Cheesecake', 'Oreo Creme'],
    ['White Garland Cupcake', 'White Garland'],
    ['White Garland Creme', 'White Garland'],
    ['Nutella Stuffed', 'Nutella'],
    ['Nutella-Hazelnut Crepes', 'Nutella-Hazelnut'],
    ['Nutella-Almond Crepes', 'Nutella-Almond'],
    ["Devil's Fantasy", 'Dark Fantasy'],
    ['Matcha Latte Iced', 'Matcha Latte'],
    ['Cinnamon Iced Cappucino', 'Cappucino Iced'],
    ['Biscoff Stuffed', 'Lotus Biscoff Creme'],
  ];

  const menu = [...DESCRIBED.map(([name, description]) => item(name, description)), ...EMPTY.map(([name]) => item(name))];
  const result = related(menu);

  it.each(EMPTY)('"%s" borrows from %j', (name, source) => {
    if (source === null) expect(result[name]).toBeUndefined();
    else expect(result[name]).toMatch(new RegExp(`^From the related menu item "${source.replace(/[()]/g, '\\$&')}": `));
  });

  it('"White Truffle Slice" no longer borrows from "Flat White"', () => {
    expect(result['White Truffle Slice']).toBeUndefined();
    expect(related([item('White Truffle Slice'), item('Flat White', 'A coffee.')])['White Truffle Slice']).toBeUndefined();
  });

  it('"Choco Berry Iced" no longer borrows from "Choco-Chips"', () => {
    expect(result['Choco Berry Iced']).toBeUndefined();
    expect(related([item('Choco Berry Iced'), item('Choco-Chips', 'A waffle.')])['Choco Berry Iced']).toBeUndefined();
  });

  it('the four "Choco-Chip" items borrow "Choco-Chips" again, whole-name containment being the only thing they have', () => {
    const description = DESCRIBED.find(([name]) => name === 'Choco-Chips')![1];
    for (const name of ['Choco-Chip Crepes', 'Choco-Chip Chips', 'Choco-Chip Stuffed', 'Choco Chip Cupcake']) {
      expect(result[name], name).toBe(from('Choco-Chips', description));
    }
  });

  it('none of the described items borrows anything', () => {
    for (const [name] of DESCRIBED) expect(result[name], name).toBeUndefined();
  });
});

describe('withRelatedDescriptions — purity', () => {
  it('does not mutate its input and keeps the order', () => {
    const empty = item('Nutella Stuffed');
    const full = item('Nutella', 'Nutella waffle.');
    const input = [empty, full];
    const out = withRelatedDescriptions(input);
    expect(input).toEqual([item('Nutella Stuffed'), item('Nutella', 'Nutella waffle.')]);
    expect(empty).not.toHaveProperty('related_description');
    expect(out.map((i) => i.name)).toEqual(['Nutella Stuffed', 'Nutella']);
    expect(out[0]).toEqual({ ...empty, related_description: from('Nutella', 'Nutella waffle.') });
    expect(out[1]).toBe(full);
  });

  it('returns items it could not fill as they were (same object)', () => {
    const lonely = item('Rose Slice');
    expect(withRelatedDescriptions([lonely])[0]).toBe(lonely);
  });

  it('keeps extra fields on the items it fills', () => {
    const extra = { ...item('Nutella Stuffed'), note: 'kept' };
    const [out] = withRelatedDescriptions([extra, item('Nutella', 'Nutella waffle.')]);
    expect(out).toMatchObject({ note: 'kept', related_description: from('Nutella', 'Nutella waffle.') });
  });

  it('handles an empty menu', () => {
    expect(withRelatedDescriptions([])).toEqual([]);
  });

  it('is idempotent: running it again changes nothing', () => {
    const once = withRelatedDescriptions([item('Nutella Stuffed'), item('Nutella', 'Nutella waffle.')]);
    expect(withRelatedDescriptions(once)).toEqual(once);
  });
});
