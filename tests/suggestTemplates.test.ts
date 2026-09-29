import { describe, expect, it } from 'vitest';
import { withInputDefaults } from '@/lib/suggest/inputs';
import {
  MAX_MATCH_TAGS,
  deterministicPicks,
  fitsMood,
  matchTagsFor,
  reasonCodeFor,
  templateHeader,
  templateReason,
} from '@/lib/suggest/templates';
import { lintReason } from '@/lib/suggest/tone';
import { FLAVOUR_FAMILY_INFO, MOOD_INFO } from '@/lib/suggest/traitVocabulary';
import { BUDGETS, FLAVOUR_FAMILIES, KINDS, MOODS, SUGGEST_LIMITS } from '@/lib/suggest/types';
import type { Candidate, MenuItemTraits, Mood, SuggestInputs, SuggestionPick } from '@/lib/suggest/types';
import { MATCHA_LATTE_TRAITS, buildFixtureMenu, buildFixtureTraitsById, buildSugarGroup, makeTraits } from './fixtures/suggestMenu';

function makeInputs(over: Partial<SuggestInputs> = {}): SuggestInputs {
  return withInputDefaults({ mood: 'boost', ...over });
}

/** A pre-Coffey row: legacy 0–3 sweetness, no v2 fields. */
function legacyTraits(over: Partial<MenuItemTraits> = {}): MenuItemTraits {
  return makeTraits({ menu_item_id: 'x', ...over });
}

/** A Coffey (v2) row with neutral defaults: mid-sweet, nothing extreme to mention. */
function v2Traits(over: Partial<MenuItemTraits> = {}): MenuItemTraits {
  return makeTraits({
    menu_item_id: 'x',
    traits_version: 2,
    sweetness: 2,
    sweetness_level: 5,
    intensity: 1,
    refreshment: 1,
    indulgence: 1,
    novelty: 1,
    textures: [],
    mood_fit: {},
    ...over,
  });
}

function candidate(over: Partial<Candidate> & { menuItemId: string; category: string; score: number }): Candidate {
  return {
    name: over.menuItemId,
    minPriceInr: 100,
    maxPriceInr: 100,
    description: '',
    sugarAdjustable: false,
    traits: legacyTraits({ menu_item_id: over.menuItemId }),
    ...over,
  };
}

const CLAUSE_OF_TRAIT = 'a lovely match for what you asked for';

// ---------------------------------------------------------------------------
// headers
// ---------------------------------------------------------------------------

describe('templateHeader', () => {
  it('returns a distinct, non-empty, tone-clean header for every mood', () => {
    const headers = MOODS.map((m) => templateHeader(m));
    expect(new Set(headers).size).toBe(MOODS.length);
    for (const h of headers) expect(lintReason(h).ok, h).toBe(true);
  });

  it("is Coffey's voice, straight from the shared vocabulary (COFFEY-SPEC §4.6)", () => {
    for (const m of MOODS) expect(templateHeader(m)).toBe(MOOD_INFO[m].header);
    expect(templateHeader('boost')).toBe("Coffey's picks for a little lift ⚡");
    expect(templateHeader('focus')).toBe("Coffey's picks to help you focus ☕");
    expect(templateHeader('unwind')).toBe("Coffey's picks to help you unwind 🧘");
    expect(templateHeader('cosy')).toBe("Coffey's picks for a cosy moment ☕");
    expect(templateHeader('comfort')).toBe("Coffey's picks for some comfort ☕");
    expect(templateHeader('celebrate')).toBe("Coffey's picks to celebrate 🎉");
    expect(templateHeader('cool')).toBe("Coffey's picks to cool you down 🧊");
    expect(templateHeader('surprise')).toBe("Coffey's picks to surprise you ✨");
  });

  it('every header carries exactly one emoji', () => {
    for (const m of MOODS) {
      const header = templateHeader(m);
      // lintReason allows ≤1; the tone guide's "Do" is one warm touch, so it is exactly one.
      expect(lintReason(header).ok).toBe(true);
      expect(header).toMatch(/Coffey's picks/);
    }
  });
});

// ---------------------------------------------------------------------------
// reasons — pre-Coffey rows keep v1's exact shapes
// ---------------------------------------------------------------------------

describe('templateReason — a row tagged before Coffey (v1 shapes, byte for byte)', () => {
  const inputs = makeInputs();
  const traits = legacyTraits({ flavor_notes: ['bold', 'nutty', 'smooth'] });

  it('a mood reason: "A lovely pick — {notes}, {clause}."', () => {
    expect(templateReason(traits, inputs, 'boost', 'Espresso')).toBe(
      'A lovely pick — bold and nutty, a good lift when you need the energy.',
    );
  });

  it('…with no notes: "A lovely pick — {clause}."', () => {
    expect(templateReason(legacyTraits({ flavor_notes: [] }), inputs, 'boost')).toBe(
      'A lovely pick — a good lift when you need the energy.',
    );
  });

  it('uses the v1 wording for each of the six v1 moods, byte for byte', () => {
    const v1Clauses: Record<string, string> = {
      boost: 'a good lift when you need the energy',
      cosy: 'warm and unhurried, a cosy choice',
      celebrate: 'a little indulgence, lovely for celebrating',
      comfort: 'rich and comforting',
      cool: 'cold and refreshing for a warm day',
      surprise: 'a little different from your usual, worth a try',
    };
    for (const [mood, clause] of Object.entries(v1Clauses)) {
      expect(templateReason(legacyTraits(), inputs, mood as Mood), mood).toBe(`A lovely pick — ${clause}.`);
      expect(templateReason(traits, inputs, mood as Mood), mood).toBe(`A lovely pick — bold and nutty, ${clause}.`);
    }
  });

  it("has clauses for the new moods, from the shared vocabulary", () => {
    expect(templateReason(legacyTraits(), inputs, 'focus')).toBe('A lovely pick — easy to sip while you focus.');
    expect(templateReason(legacyTraits(), inputs, 'unwind')).toBe(
      'A lovely pick — soothing and gentle, easy to unwind with.',
    );
    for (const m of MOODS) {
      expect(templateReason(legacyTraits(), inputs, m)).toBe(`A lovely pick — ${MOOD_INFO[m].clause}.`);
    }
  });

  it("'trait': \"A lovely pick, with {notes}.\" or \"A lovely pick for what you asked for.\"", () => {
    expect(templateReason(traits, inputs, 'trait')).toBe('A lovely pick, with bold and nutty.');
    expect(templateReason(legacyTraits({ flavor_notes: [] }), inputs, 'trait')).toBe('A lovely pick for what you asked for.');
  });

  it("'usual' and 'popular'", () => {
    expect(templateReason(traits, inputs, 'usual')).toBe('Your usual — bold and nutty, always a good choice.');
    expect(templateReason(legacyTraits({ flavor_notes: [] }), inputs, 'usual')).toBe('Your usual — always a good choice.');
    expect(templateReason(traits, inputs, 'popular')).toBe('Our regulars love this one, with bold and nutty.');
    expect(templateReason(legacyTraits({ flavor_notes: [] }), inputs, 'popular')).toBe('Our regulars love this one.');
  });

  it('names at most the top two notes', () => {
    const reason = templateReason(legacyTraits({ flavor_notes: ['alpha', 'beta', 'gamma', 'delta'] }), inputs, 'cosy');
    expect(reason).toContain('alpha and beta');
    expect(reason).not.toMatch(/gamma|delta/);
  });

  it('never uses the v2 richer sentence, whatever the customer asked for', () => {
    const picky = makeInputs({ sweetness: 'none', body: 'light', strength: 'strong' });
    // No descriptors on a legacy row — the shape is v1's.
    expect(templateReason(traits, picky, 'boost')).toBe(
      'A lovely pick — bold and nutty, a good lift when you need the energy.',
    );
  });
});

describe('templateReason — the customer\'s flavour family (chocolatey / fruity …)', () => {
  it("names the chocolatey flavour when the item's name/flavor_notes match and the family was chosen", () => {
    const traits = legacyTraits({ flavor_notes: ['chocolate', 'coffee-forward'] });
    const reason = templateReason(traits, makeInputs({ flavours: ['chocolatey'] }), 'trait', 'Mocha');
    expect(reason).toMatch(/chocolat/i);
    expect(reason).toBe('A lovely pick, with rich chocolate notes.');
    expect(lintReason(reason).ok).toBe(true);
  });

  it("names the fruity flavour when the item's name/flavor_notes match and the family was chosen", () => {
    const traits = legacyTraits({ flavor_notes: ['berry', 'citrus'] });
    const reason = templateReason(traits, makeInputs({ flavours: ['fruity'] }), 'trait', 'Berry Lemonade Iced');
    expect(reason).toMatch(/fruity/i);
    expect(reason).toBe('A lovely pick, with a bright, fruity flavour.');
    expect(lintReason(reason).ok).toBe(true);
  });

  it('falls back to the generic flavor-note join when the family was chosen but the item does not match it', () => {
    const traits = legacyTraits({ flavor_notes: ['bold', 'nutty'] });
    const reason = templateReason(traits, makeInputs({ flavours: ['chocolatey'] }), 'trait', 'Espresso');
    expect(reason).not.toMatch(/chocolat/i);
    expect(reason).toBe('A lovely pick, with bold and nutty.');
    expect(lintReason(reason).ok).toBe(true);
  });

  it('works without a name argument (e.g. the "usual" card call site) — flavor_notes alone still apply', () => {
    const traits = legacyTraits({ flavor_notes: ['chocolate'] });
    const reason = templateReason(traits, makeInputs({ flavours: ['chocolatey'] }), 'usual');
    expect(reason).toMatch(/chocolat/i);
    expect(lintReason(reason).ok).toBe(true);
  });

  it('matches on the item NAME when the notes say nothing', () => {
    const reason = templateReason(legacyTraits({ flavor_notes: [] }), makeInputs({ flavours: ['nutty'] }), 'trait', 'Nutella Waffle');
    expect(reason).toBe('A lovely pick, with toasty nutty notes.');
  });

  it("uses each family's own phrase (COFFEY-SPEC §4.6)", () => {
    const items: Record<(typeof FLAVOUR_FAMILIES)[number], { name: string; phrase: string }> = {
      chocolatey: { name: 'Mocha', phrase: 'rich chocolate notes' },
      caramel: { name: 'Salted Caramel Latte', phrase: 'buttery caramel notes' },
      nutty: { name: 'Hazelnut Creme', phrase: 'toasty nutty notes' },
      biscuit: { name: 'Lotus Biscoff Shake', phrase: 'cookie-crumb notes' },
      fruity: { name: 'Berry Lemonade', phrase: 'a bright, fruity flavour' },
      spiced: { name: 'Cinnamon Roll', phrase: 'warm spice' },
      floral: { name: 'Rose Latte', phrase: 'delicate floral notes' },
    };
    for (const family of FLAVOUR_FAMILIES) {
      const { name, phrase } = items[family];
      expect(FLAVOUR_FAMILY_INFO[family].phrase).toBe(phrase);
      const traits = v2Traits({ flavor_notes: ['vanilla'], intensity: null });
      const reason = templateReason(traits, makeInputs({ flavours: [family] }), 'trait', name);
      expect(reason, family).toContain(`with ${phrase} —`);
      expect(lintReason(reason).ok, family).toBe(true);
    }
  });

  it("prefers the first family the customer asked for that the item has", () => {
    const traits = legacyTraits({ flavor_notes: ['chocolate', 'strawberry'] });
    expect(templateReason(traits, makeInputs({ flavours: ['fruity', 'chocolatey'] }), 'trait', 'X')).toBe(
      'A lovely pick, with a bright, fruity flavour.',
    );
    expect(templateReason(traits, makeInputs({ flavours: ['chocolatey', 'fruity'] }), 'trait', 'X')).toBe(
      'A lovely pick, with rich chocolate notes.',
    );
  });
});

// ---------------------------------------------------------------------------
// reasons — Coffey (v2) rows
// ---------------------------------------------------------------------------

describe('templateReason — a Coffey (v2) row: descriptors, flavour, clause (COFFEY-SPEC §4.6)', () => {
  const clause = MOOD_INFO.boost.clause;

  it('has the shape "{Descriptor} and {descriptor2}, with {flavour} — {clause}."', () => {
    const traits = v2Traits({ intensity: 3, textures: ['icy'], flavor_notes: ['espresso', 'buttery'] });
    expect(templateReason(traits, makeInputs(), 'boost', 'X')).toBe(
      `Bold and icy, with espresso and buttery notes — ${clause}.`,
    );
  });

  it('with one descriptor: "{Descriptor}, with {flavour} — {clause}."', () => {
    const traits = v2Traits({ intensity: 3, flavor_notes: ['espresso'] });
    expect(templateReason(traits, makeInputs(), 'boost', 'X')).toBe(`Bold, with espresso notes — ${clause}.`);
  });

  it('with no flavour: "{Descriptor} and {descriptor2} — {clause}."', () => {
    const traits = v2Traits({ intensity: 3, textures: ['icy'], flavor_notes: [] });
    expect(templateReason(traits, makeInputs(), 'boost', 'X')).toBe(`Bold and icy — ${clause}.`);
  });

  it('with no descriptor to lead with: "A lovely pick, with {flavour} — {clause}."', () => {
    // A food item: no intensity, mid-sweet, not refreshing, no texture.
    const traits = v2Traits({ kind: 'food', flavor_notes: ['garlic'] });
    expect(templateReason(traits, makeInputs(), 'comfort', 'X')).toBe(
      `A lovely pick, with garlic notes — ${MOOD_INFO.comfort.clause}.`,
    );
  });

  it('with nothing at all: "A lovely pick — {clause}."', () => {
    const traits = v2Traits({ kind: 'food', flavor_notes: [] });
    expect(templateReason(traits, makeInputs(), 'comfort', 'X')).toBe(`A lovely pick — ${MOOD_INFO.comfort.clause}.`);
  });

  describe('descriptors', () => {
    const bare = (over: Partial<MenuItemTraits> = {}) =>
      v2Traits({ intensity: null, refreshment: 0, textures: [], flavor_notes: [], ...over });
    const lead = (traits: MenuItemTraits, inputs: SuggestInputs = makeInputs()) =>
      templateReason(traits, inputs, 'boost', 'X').split(' — ')[0];

    it('intensity, for drinks: 3 bold, 2 full-flavoured, 1 mellow, 0 gentle', () => {
      expect(lead(bare({ intensity: 3 }))).toBe('Bold');
      expect(lead(bare({ intensity: 2 }))).toBe('Full-flavoured');
      expect(lead(bare({ intensity: 1 }))).toBe('Mellow');
      expect(lead(bare({ intensity: 0 }))).toBe('Gentle');
    });

    it('intensity is for drinks only — a dessert or a snack is not called "bold"', () => {
      expect(lead(bare({ kind: 'dessert', intensity: 3 }))).toBe('A lovely pick');
      expect(lead(bare({ kind: 'food', intensity: 3 }))).toBe('A lovely pick');
    });

    it("sweetness bands, on the customer's own scale: 0–1 unsweetened, 2–3 lightly sweet, 4–5 medium-sweet, 6–8 sweet, 9–10 dessert-sweet (when the customer set one)", () => {
      const asked = makeInputs({ sweetness: 'medium' });
      // Non-adjustable, so the word describes the item as made.
      const word = (level: number) => lead(bare({ sweetness_level: level }), asked);
      for (const level of [0, 1]) expect(word(level), `${level}`).toBe('Unsweetened');
      for (const level of [2, 3]) expect(word(level), `${level}`).toBe('Lightly sweet');
      for (const level of [4, 5]) expect(word(level), `${level}`).toBe('Medium-sweet');
      for (const level of [6, 7, 8]) expect(word(level), `${level}`).toBe('Sweet');
      for (const level of [9, 10]) expect(word(level), `${level}`).toBe('Dessert-sweet');
    });

    it('a target always reads as its own label: not sweet → unsweetened, lightly sweet → lightly sweet, medium → medium-sweet, sweet → sweet, very sweet → dessert-sweet', () => {
      const own = { none: 'Unsweetened', light: 'Lightly sweet', medium: 'Medium-sweet', sweet: 'Sweet', very: 'Dessert-sweet' } as const;
      const target = { none: 0, light: 3, medium: 5, sweet: 7, very: 10 } as const;
      for (const pref of ['none', 'light', 'medium', 'sweet', 'very'] as const) {
        const asked = makeInputs({ sweetness: pref });
        // An item exactly at the target, as the kitchen makes it…
        expect(lead(bare({ sweetness_level: target[pref] }), asked), `${pref} as made`).toBe(own[pref]);
        // …and one that sugar brings up to it (a coffee at level target−3, "Normal" adds 3).
        if (target[pref] >= 3) {
          const cold = bare({ sweetness_level: target[pref] - 3 });
          expect(templateReason(cold, asked, 'boost', 'X', true).split(' — ')[0], `${pref} with sugar`).toBe(own[pref]);
        }
      }
    });

    it('sweetness is left out when the customer set none and the item is mid-sweet (2–7)', () => {
      for (const level of [2, 3, 4, 5, 6, 7]) {
        expect(lead(bare({ sweetness_level: level })), `${level}`).toBe('A lovely pick');
      }
    });

    it('…but an extreme is named unprompted: unsweetened at ≤1, and from 8 up (sweet at 8, dessert-sweet at 9–10)', () => {
      expect(lead(bare({ sweetness_level: 0 }))).toBe('Unsweetened');
      expect(lead(bare({ sweetness_level: 1 }))).toBe('Unsweetened');
      expect(lead(bare({ sweetness_level: 8 }))).toBe('Sweet');
      expect(lead(bare({ sweetness_level: 9 }))).toBe('Dessert-sweet');
      expect(lead(bare({ sweetness_level: 10 }))).toBe('Dessert-sweet');
    });

    it('a savoury item is never called "unsweetened" unprompted — but is when the customer set a sweetness', () => {
      expect(lead(bare({ kind: 'food', sweetness_level: 0 }))).toBe('A lovely pick');
      expect(lead(bare({ kind: 'food', sweetness_level: 0 }), makeInputs({ sweetness: 'none' }))).toBe('Unsweetened');
    });

    it('a legacy 0–3 sweetness on a v2 row (no level) reads through the 0–10 scale', () => {
      // Legacy 0 → level 0 → "unsweetened".
      expect(lead(bare({ sweetness_level: null, sweetness: 0 }))).toBe('Unsweetened');
      // Legacy 3 → level 9 → "dessert-sweet".
      expect(lead(bare({ sweetness_level: null, sweetness: 3 }))).toBe('Dessert-sweet');
    });

    it("with a sugar choice, the sweetness word describes the drink as they'll get it, agreeing with the sugar note", () => {
      // A cold brew at level 0; "Lightly sweet" (3) is reachable with Normal sugar.
      const traits = bare({ sweetness_level: 0 });
      const asked = makeInputs({ sweetness: 'light' });
      const withoutSugar = templateReason(traits, asked, 'boost', 'X', false);
      const withSugar = templateReason(traits, asked, 'boost', 'X', true);
      expect(withoutSugar.startsWith('Unsweetened')).toBe(true);
      expect(withSugar.startsWith('Lightly sweet')).toBe(true); // level 3 = the "light" target, in its own words
      // Unprompted, sugar changes nothing: the drink is described as made.
      expect(templateReason(traits, makeInputs(), 'boost', 'X', true).startsWith('Unsweetened')).toBe(true);
    });

    it('refreshment ≥2: "crisp and refreshing" on its own, "crisp" beside another descriptor', () => {
      expect(lead(bare({ kind: 'dessert', refreshment: 2 }))).toBe('Crisp and refreshing');
      expect(lead(bare({ kind: 'dessert', refreshment: 3 }))).toBe('Crisp and refreshing');
      expect(lead(bare({ intensity: 3, refreshment: 3 }))).toBe('Bold and crisp'); // the §4.6 example
      expect(lead(bare({ kind: 'dessert', refreshment: 1 }))).toBe('A lovely pick');
    });

    it('the first texture', () => {
      expect(lead(bare({ kind: 'dessert', textures: ['gooey', 'chewy'] }))).toBe('Gooey');
      expect(lead(bare({ intensity: 2, textures: ['silky', 'creamy'] }))).toBe('Full-flavoured and silky');
    });

    it('never more than two, in the order intensity, sweetness, refreshment, texture', () => {
      const all = bare({ intensity: 3, sweetness_level: 0, refreshment: 3, textures: ['icy'] });
      expect(lead(all)).toBe('Bold and unsweetened');
      const noIntensity = bare({ kind: 'dessert', sweetness_level: 9, refreshment: 3, textures: ['icy'] });
      expect(lead(noIntensity)).toBe('Dessert-sweet and crisp');
    });

    describe('chosen by what the customer asked for first', () => {
      const rich = bare({ intensity: 3, sweetness_level: 3, refreshment: 3, textures: ['thick'] });

      it('by default: intensity, then refreshment (a mid-sweet item has no sweetness word)', () => {
        expect(lead(rich)).toBe('Bold and crisp');
      });

      it('a sweetness moves the sweetness word to the front', () => {
        expect(lead(rich, makeInputs({ sweetness: 'medium' }))).toBe('Lightly sweet and bold');
      });

      it('"light" moves refreshment to the front', () => {
        expect(lead(rich, makeInputs({ body: 'light' }))).toBe('Crisp and bold');
      });

      it('"rich" moves the texture to the front', () => {
        expect(lead(rich, makeInputs({ body: 'rich' }))).toBe('Thick and bold');
      });

      it('a strength keeps intensity first (and lifts it above a sweetness that was not asked about)', () => {
        const extreme = bare({ intensity: 3, sweetness_level: 0, refreshment: 3 });
        expect(lead(extreme, makeInputs({ strength: 'strong' }))).toBe('Bold and unsweetened');
        // …while asking about body puts the refreshment word ahead of the unprompted extreme.
        expect(lead(extreme, makeInputs({ body: 'light' }))).toBe('Crisp and bold');
      });

      it('two things asked about: both come first, in the usual order between them', () => {
        expect(lead(rich, makeInputs({ sweetness: 'medium', body: 'light' }))).toBe('Lightly sweet and crisp');
        expect(lead(rich, makeInputs({ strength: 'mild', body: 'rich' }))).toBe('Bold and thick');
      });
    });
  });

  describe('the flavour phrase', () => {
    const drink = (over: Partial<MenuItemTraits>) => v2Traits({ intensity: null, refreshment: 0, ...over });

    it('the top two notes, joined with "and", plus "notes"', () => {
      expect(templateReason(drink({ flavor_notes: ['espresso', 'buttery', 'vanilla'] }), makeInputs(), 'boost', 'X')).toContain(
        'with espresso and buttery notes —',
      );
      expect(templateReason(drink({ flavor_notes: ['espresso'] }), makeInputs(), 'boost', 'X')).toContain('with espresso notes —');
    });

    it("the customer's requested family when the item matches it", () => {
      const traits = drink({ flavor_notes: ['espresso', 'chocolate'] });
      expect(templateReason(traits, makeInputs({ flavours: ['chocolatey'] }), 'boost', 'X')).toContain('with rich chocolate notes —');
    });

    it('…else the top two notes as usual', () => {
      const traits = drink({ flavor_notes: ['espresso', 'chocolate'] });
      expect(templateReason(traits, makeInputs({ flavours: ['floral'] }), 'boost', 'X')).toContain('with espresso and chocolate notes —');
    });

    it('is left out when the item has no notes and no requested family matched', () => {
      const reason = templateReason(drink({ flavor_notes: [] }), makeInputs({ flavours: ['floral'] }), 'boost', 'X');
      expect(reason).not.toContain('with');
    });
  });

  describe('the clause', () => {
    it('is the mood clause from the shared vocabulary, for every mood', () => {
      for (const m of MOODS) {
        const reason = templateReason(v2Traits({ intensity: 3, flavor_notes: ['espresso'] }), makeInputs(), m, 'X');
        expect(reason, m).toBe(`Bold, with espresso notes — ${MOOD_INFO[m].clause}.`);
      }
    });

    it("'trait' says the pick is a match for what was asked", () => {
      expect(templateReason(v2Traits({ intensity: 3, flavor_notes: ['espresso'] }), makeInputs(), 'trait', 'X')).toBe(
        `Bold, with espresso notes — ${CLAUSE_OF_TRAIT}.`,
      );
      expect(templateReason(v2Traits({ kind: 'food' }), makeInputs(), 'trait', 'X')).toBe(`A lovely pick — ${CLAUSE_OF_TRAIT}.`);
    });

    it("'usual' and 'popular' keep their v1 shapes, with the v2 flavour phrase", () => {
      const traits = v2Traits({ intensity: 3, flavor_notes: ['espresso', 'buttery'] });
      expect(templateReason(traits, makeInputs(), 'usual', 'X')).toBe('Your usual — espresso and buttery notes, always a good choice.');
      expect(templateReason(traits, makeInputs(), 'popular', 'X')).toBe('Our regulars love this one, with espresso and buttery notes.');
      const bare = v2Traits({ flavor_notes: [] });
      expect(templateReason(bare, makeInputs(), 'usual', 'X')).toBe('Your usual — always a good choice.');
      expect(templateReason(bare, makeInputs(), 'popular', 'X')).toBe('Our regulars love this one.');
    });
  });

  describe('length and tone are enforced, whatever the notes hold', () => {
    const long = v2Traits({ intensity: 2, sweetness_level: 9, flavor_notes: ['white chocolate', 'butterscotch'] });

    it('a sentence that would run past 120 characters drops detail instead of being cut mid-word', () => {
      // 128 characters with both notes; one note fits.
      const reason = templateReason(long, makeInputs(), 'surprise', 'X');
      expect(reason).toBe(
        'Full-flavoured and dessert-sweet, with white chocolate notes — a little different from your usual, worth a try.',
      );
      expect(reason.length).toBeLessThanOrEqual(SUGGEST_LIMITS.reasonMaxChars);
      expect(reason).not.toContain('…');
    });

    it('with nothing shorter that names a flavour, it names none — still no ellipsis', () => {
      const huge = v2Traits({ intensity: 2, sweetness_level: 9, flavor_notes: ['q'.repeat(90), 'z'.repeat(90)] });
      const reason = templateReason(huge, makeInputs(), 'surprise', 'X');
      expect(reason).toBe('Full-flavoured and dessert-sweet — a little different from your usual, worth a try.');
      expect(reason.length).toBeLessThanOrEqual(SUGGEST_LIMITS.reasonMaxChars);
    });

    it('falls back to the plain sentence when even the descriptors cannot fit', () => {
      // A texture name is data too; a 200-character one leaves only the plain sentence.
      const odd = v2Traits({ kind: 'dessert', textures: ['w'.repeat(200)] as unknown as MenuItemTraits['textures'], flavor_notes: [] });
      const reason = templateReason(odd, makeInputs(), 'surprise', 'X');
      expect(reason).toBe('A lovely pick — a little different from your usual, worth a try.');
    });

    it('a note the tone lint rejects is left out of the sentence, never shown', () => {
      const naughty = v2Traits({ intensity: 3, flavor_notes: ['healthy', 'detox'] });
      const reason = templateReason(naughty, makeInputs(), 'boost', 'X');
      expect(reason).toBe(`Bold — ${MOOD_INFO.boost.clause}.`);
      expect(lintReason(reason).ok).toBe(true);
    });

    it('…on a pre-Coffey row too', () => {
      const naughty = legacyTraits({ flavor_notes: ['healthy', 'cures'] });
      const reason = templateReason(naughty, makeInputs(), 'boost', 'X');
      expect(reason).toBe(`A lovely pick — ${MOOD_INFO.boost.clause}.`);
      expect(lintReason(reason).ok).toBe(true);
    });

    it('strips angle brackets that would fail the lint (a note is never rendered as HTML)', () => {
      const reason = templateReason(v2Traits({ intensity: 3, flavor_notes: ['<b>bold</b>'] }), makeInputs(), 'boost', 'X');
      expect(reason).not.toMatch(/[<>]/);
      expect(lintReason(reason).ok).toBe(true);
    });
  });
});

describe('templateReason — the whole matrix passes the tone lint and the 120-character cap', () => {
  const menu = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();
  const rows = menu
    .map((item) => ({ item, traits: traitsById.get(item.id) }))
    .filter((r): r is { item: (typeof menu)[number]; traits: MenuItemTraits } => Boolean(r.traits));

  const prefVariants: Partial<SuggestInputs>[] = [
    {},
    { sweetness: 'none' },
    { sweetness: 'light' },
    { sweetness: 'medium' },
    { sweetness: 'sweet' },
    { sweetness: 'very' },
    { strength: 'strong' },
    { strength: 'mild' },
    { strength: 'balanced' },
    { body: 'light' },
    { body: 'rich' },
    { flavours: ['chocolatey'] },
    { flavours: ['fruity', 'nutty'] },
    { flavours: [...FLAVOUR_FAMILIES] },
    {
      sweetness: 'medium',
      strength: 'mild',
      body: 'light',
      flavours: ['caramel', 'floral'],
      kinds: ['drink', 'dessert', 'food'],
      temperature: 'iced',
      budget: 'under_200',
      needs: ['no_caffeine'],
      note: 'studying late',
    },
  ];

  it('covers both eras of trait rows', () => {
    expect(rows.some((r) => (r.traits.traits_version ?? 1) >= 2)).toBe(true);
    expect(rows.some((r) => (r.traits.traits_version ?? 1) < 2)).toBe(true);
    expect(rows.length).toBeGreaterThan(35);
  });

  it('every mood × preference set × item × reasonCode yields a clean, short, non-empty reason', () => {
    let checked = 0;
    MOODS.forEach((mood, i) => {
      const secondaryMood = MOODS[(i + 1) % MOODS.length];
      for (const prefs of prefVariants) {
        const inputs = makeInputs({ mood, secondaryMood, ...prefs });
        for (const { item, traits } of rows) {
          for (const code of [mood, secondaryMood, 'trait', 'usual', 'popular'] as SuggestionPick['reasonCode'][]) {
            // A sugar choice only changes the sentence when a sweetness was asked for.
            for (const sugar of prefs.sweetness ? [false, true] : [false]) {
              const reason = templateReason(traits, inputs, code, item.name, sugar);
              const label = `${item.id} / ${code} / ${JSON.stringify(prefs)}`;
              expect(reason.length, label).toBeGreaterThan(0);
              expect(reason.length, `${label}: ${reason}`).toBeLessThanOrEqual(SUGGEST_LIMITS.reasonMaxChars);
              expect(lintReason(reason).ok, `${label}: ${reason}`).toBe(true);
              expect(reason, label).toMatch(/^[A-Z]/);
              expect(reason, label).toMatch(/\.$/);
              checked++;
            }
          }
        }
      }
    });
    expect(checked).toBeGreaterThan(15000);
  }, 30_000);

  it('a v2 row always states its clause, so the reason says WHY', () => {
    for (const mood of MOODS) {
      for (const prefs of prefVariants) {
        const inputs = makeInputs({ mood, ...prefs });
        for (const { item, traits } of rows) {
          if ((traits.traits_version ?? 1) < 2) continue;
          expect(templateReason(traits, inputs, mood, item.name), `${item.id} ${mood}`).toContain(MOOD_INFO[mood].clause);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// which feeling an item serves
// ---------------------------------------------------------------------------

describe('fitsMood / reasonCodeFor', () => {
  it('a graded row fits a mood at ≥2 of 3 — and the grade, not the legacy tag, decides', () => {
    expect(fitsMood(v2Traits({ mood_fit: { cool: 2 } }), 'cool')).toBe(true);
    expect(fitsMood(v2Traits({ mood_fit: { cool: 3 } }), 'cool')).toBe(true);
    expect(fitsMood(v2Traits({ mood_fit: { cool: 1.9 } }), 'cool')).toBe(false);
    // Jev tagged it cool only as the single best of a poor lot: 1.0 is not a fit…
    expect(fitsMood(v2Traits({ mood_fit: { cool: 1 }, moods: ['cool'] }), 'cool')).toBe(false);
    // …and a grade of 3 is a fit even if `moods` was left without it.
    expect(fitsMood(v2Traits({ mood_fit: { cool: 3 }, moods: [] }), 'cool')).toBe(true);
  });

  it('a legacy row fits the moods it is tagged with', () => {
    expect(fitsMood(legacyTraits({ moods: ['cool'] }), 'cool')).toBe(true);
    expect(fitsMood(legacyTraits({ moods: ['cool'] }), 'boost')).toBe(false);
    expect(fitsMood(legacyTraits({ moods: [] }), 'cool')).toBe(false);
  });

  it('a mood the graded row does not grade falls back to the tag', () => {
    expect(fitsMood(v2Traits({ mood_fit: { boost: 3 }, moods: ['cool'] }), 'cool')).toBe(true);
  });

  it('reasonCodeFor is the first of the customer\'s feelings the item fits (primary first), else "trait"', () => {
    const both = legacyTraits({ moods: ['boost', 'cool'] });
    expect(reasonCodeFor(both, { mood: 'boost', secondaryMood: 'cool' })).toBe('boost');
    expect(reasonCodeFor(both, { mood: 'cool', secondaryMood: 'boost' })).toBe('cool');
    const onlySecond = legacyTraits({ moods: ['cool'] });
    expect(reasonCodeFor(onlySecond, { mood: 'boost', secondaryMood: 'cool' })).toBe('cool');
    expect(reasonCodeFor(onlySecond, { mood: 'boost', secondaryMood: null })).toBe('trait');
    expect(reasonCodeFor(legacyTraits({ moods: [] }), { mood: 'boost', secondaryMood: 'cool' })).toBe('trait');
  });
});

// ---------------------------------------------------------------------------
// match tags (COFFEY-SPEC §4.6)
// ---------------------------------------------------------------------------

describe('matchTagsFor', () => {
  interface SubjectOpts {
    name?: string;
    sugarAdjustable?: boolean;
  }
  const subject = (traits: MenuItemTraits, opts: SubjectOpts = {}) => ({
    name: opts.name ?? 'Item',
    traits,
    sugarAdjustable: opts.sugarAdjustable ?? false,
  });
  /** An item that fits nothing in particular, so a tag under test stands alone. */
  const plain = (over: Partial<MenuItemTraits> = {}) =>
    v2Traits({ intensity: null, refreshment: 0, sweetness_level: 5, mood_fit: {}, moods: [], caffeine: 'medium', ...over });
  const neutral = () => makeInputs({ mood: 'surprise' });

  it('is empty when nothing was asked for and the item fits no feeling', () => {
    expect(matchTagsFor(subject(plain()), neutral())).toEqual([]);
  });

  describe('1 — the feeling it fits', () => {
    it('is the mood tag from the shared vocabulary, for every mood', () => {
      const tagOf: Record<Mood, string> = {
        boost: 'A proper lift',
        focus: 'Good for focus',
        unwind: 'Calming',
        cosy: 'Cosy',
        comfort: 'Comforting',
        celebrate: 'A treat',
        cool: 'Refreshing',
        surprise: 'Something new',
      };
      for (const mood of MOODS) {
        expect(MOOD_INFO[mood].tag).toBe(tagOf[mood]);
        const tags = matchTagsFor(subject(plain({ mood_fit: { [mood]: 2 } })), makeInputs({ mood }));
        expect(tags, mood).toEqual([tagOf[mood]]);
      }
    });

    it('needs a graded fit of 2 (a v2 row) or the tag (a legacy row)', () => {
      expect(matchTagsFor(subject(plain({ mood_fit: { boost: 1.9 } })), makeInputs({ mood: 'boost' }))).toEqual([]);
      expect(matchTagsFor(subject(plain({ mood_fit: { boost: 2 } })), makeInputs({ mood: 'boost' }))).toEqual(['A proper lift']);
      const legacy = legacyTraits({ moods: ['cool'] });
      expect(matchTagsFor(subject(legacy), makeInputs({ mood: 'cool' }))).toEqual(['Refreshing']);
      expect(matchTagsFor(subject(legacy), makeInputs({ mood: 'boost' }))).toEqual([]);
    });

    it('is ONE tag: the primary feeling if the item fits it, else the secondary', () => {
      const both = plain({ mood_fit: { boost: 3, cool: 3 } });
      expect(matchTagsFor(subject(both), makeInputs({ mood: 'boost', secondaryMood: 'cool' }))).toEqual(['A proper lift']);
      expect(matchTagsFor(subject(both), makeInputs({ mood: 'cool', secondaryMood: 'boost' }))).toEqual(['Refreshing']);
      const onlySecond = plain({ mood_fit: { boost: 0, cool: 3 } });
      expect(matchTagsFor(subject(onlySecond), makeInputs({ mood: 'boost', secondaryMood: 'cool' }))).toEqual(['Refreshing']);
    });
  });

  describe('2 — the flavour family they asked for that the item belongs to', () => {
    const named: Record<(typeof FLAVOUR_FAMILIES)[number], string> = {
      chocolatey: 'Mocha',
      caramel: 'Salted Caramel Latte',
      nutty: 'Hazelnut Creme',
      biscuit: 'Lotus Biscoff Shake',
      fruity: 'Berry Lemonade',
      spiced: 'Cinnamon Roll',
      floral: 'Rose Latte',
    };

    it("is the family's tag, for every family", () => {
      for (const family of FLAVOUR_FAMILIES) {
        const tags = matchTagsFor(subject(plain(), { name: named[family] }), makeInputs({ mood: 'surprise', flavours: [family] }));
        expect(tags, family).toEqual([FLAVOUR_FAMILY_INFO[family].tag]);
      }
      expect(FLAVOUR_FAMILY_INFO.biscuit.tag).toBe('Cookies & biscuit');
    });

    it('is absent when the family was not asked for, or the item is not in it', () => {
      expect(matchTagsFor(subject(plain(), { name: 'Mocha' }), neutral())).toEqual([]);
      expect(matchTagsFor(subject(plain(), { name: 'Mocha' }), makeInputs({ mood: 'surprise', flavours: ['fruity'] }))).toEqual([]);
    });

    it('matches on the notes too, and takes the first asked-for family the item has', () => {
      const traits = plain({ flavor_notes: ['chocolate', 'strawberry'] });
      expect(matchTagsFor(subject(traits), makeInputs({ mood: 'surprise', flavours: ['fruity', 'chocolatey'] }))).toEqual(['Fruity']);
      expect(matchTagsFor(subject(traits), makeInputs({ mood: 'surprise', flavours: ['chocolatey', 'fruity'] }))).toEqual(['Chocolatey']);
    });
  });

  describe('3 — their sweetness label, only when the item lands in the SAME band as what they chose', () => {
    type Pref = 'none' | 'light' | 'medium' | 'sweet' | 'very';
    const label: Record<Pref, string> = { none: 'Not sweet', light: 'Lightly sweet', medium: 'Medium sweet', sweet: 'Sweet', very: 'Very sweet' };
    // The bands the reasons' descriptors use, on the customer's scale (targets 0 / 3 / 5 / 7 / 10).
    const bandLevels: Record<Pref, number[]> = { none: [0, 1], light: [2, 3], medium: [4, 5], sweet: [6, 7, 8], very: [9, 10] };
    const tagAt = (level: number, sweetness: Pref, sugarAdjustable = false) =>
      matchTagsFor(subject(plain({ sweetness_level: level }), { sugarAdjustable }), makeInputs({ mood: 'surprise', sweetness }));

    it('is the customer\'s label — Not sweet / Lightly sweet / Medium sweet / Sweet / Very sweet', () => {
      const atTarget: Record<Pref, number> = { none: 0, light: 3, medium: 5, sweet: 7, very: 10 };
      for (const pref of Object.keys(atTarget) as Pref[]) {
        expect(tagAt(atTarget[pref], pref), pref).toEqual([label[pref]]);
      }
    });

    it('is absent for "any"', () => {
      expect(matchTagsFor(subject(plain({ sweetness_level: 5 })), neutral())).toEqual([]);
    });

    it('needs the item in the SAME band as the target: none 0–1, light 2–3, medium 4–5, sweet 6–8, very 9–10 — and nowhere else', () => {
      for (const pref of Object.keys(bandLevels) as Pref[]) {
        for (let level = 0; level <= 10; level++) {
          expect(tagAt(level, pref), `${pref} @ level ${level}`).toEqual(bandLevels[pref].includes(level) ? [label[pref]] : []);
        }
      }
    });

    it('being near is not enough: one band over gets no tag (it would read as the neighbouring word)', () => {
      expect(tagAt(4, 'light')).toEqual([]); // 1 away, but "medium-sweet"
      expect(tagAt(2, 'none')).toEqual([]); // 2 away: "lightly sweet"
      expect(tagAt(6, 'medium')).toEqual([]); // "sweet"
      expect(tagAt(8, 'very')).toEqual([]); // 2 away: still "sweet"
    });

    it('the fixture matcha at level 4 with "lightly sweet" asked gets no "Lightly sweet" tag', () => {
      const tags = matchTagsFor(
        { name: 'Matcha Latte', traits: MATCHA_LATTE_TRAITS, sugarAdjustable: false },
        makeInputs({ mood: 'focus', sweetness: 'light' }),
      );
      expect(tags).toEqual(['Good for focus']);
      // …and its reason says "medium-sweet", not "lightly sweet", so the two agree.
      expect(templateReason(MATCHA_LATTE_TRAITS, makeInputs({ mood: 'focus', sweetness: 'light' }), 'focus', 'Matcha Latte').startsWith('Medium-sweet')).toBe(true);
    });

    it('counts a sugar choice: the band is judged on what they can get — up to (base + 3)', () => {
      const ask = makeInputs({ mood: 'surprise', sweetness: 'medium' }); // target 5
      // A cold brew at 1: stuck at 1 without sugar; "Normal" reaches 4 — the medium band.
      expect(matchTagsFor(subject(plain({ sweetness_level: 1 }), { sugarAdjustable: false }), ask)).toEqual([]);
      expect(matchTagsFor(subject(plain({ sweetness_level: 1 }), { sugarAdjustable: true }), ask)).toEqual(['Medium sweet']);
      // At 0, "Normal" only reaches 3 — the lightly-sweet band — so "Medium" earns no tag, "Lightly sweet" does.
      expect(matchTagsFor(subject(plain({ sweetness_level: 0 }), { sugarAdjustable: true }), ask)).toEqual([]);
      expect(tagAt(0, 'light', true)).toEqual(['Lightly sweet']);
      // …but sugar can never take it below what it is.
      expect(tagAt(6, 'none', true)).toEqual([]);
      expect(tagAt(6, 'light', true)).toEqual([]);
    });

    it('reads a legacy row through the 0–10 scale', () => {
      // Legacy 1 → level 3, which is exactly "lightly sweet".
      expect(matchTagsFor(subject(legacyTraits({ sweetness: 1, moods: [] })), makeInputs({ mood: 'surprise', sweetness: 'light' }))).toEqual([
        'Lightly sweet',
      ]);
      // Legacy 2 → level 6: a "sweet" item is not "medium".
      expect(matchTagsFor(subject(legacyTraits({ sweetness: 2, moods: [] })), makeInputs({ mood: 'surprise', sweetness: 'medium' }))).toEqual([]);
    });
  });

  describe('4 — Strong / Smooth & milky, when asked for and the coffee is that', () => {
    const coffee = (intensity: number | null, over: Partial<MenuItemTraits> = {}) =>
      plain({ kind: 'drink', is_coffee: true, intensity, ...over });

    it('Strong for a bold or full-flavoured coffee', () => {
      const ask = makeInputs({ mood: 'surprise', strength: 'strong' });
      expect(matchTagsFor(subject(coffee(3)), ask)).toEqual(['Strong']);
      expect(matchTagsFor(subject(coffee(2)), ask)).toEqual(['Strong']);
      expect(matchTagsFor(subject(coffee(1)), ask)).toEqual([]);
      expect(matchTagsFor(subject(coffee(0)), ask)).toEqual([]);
    });

    it('Smooth & milky for a mellow or gentle coffee', () => {
      const ask = makeInputs({ mood: 'surprise', strength: 'mild' });
      expect(matchTagsFor(subject(coffee(0)), ask)).toEqual(['Smooth & milky']);
      expect(matchTagsFor(subject(coffee(1)), ask)).toEqual(['Smooth & milky']);
      expect(matchTagsFor(subject(coffee(2)), ask)).toEqual([]);
      expect(matchTagsFor(subject(coffee(3)), ask)).toEqual([]);
    });

    it('reads intensity from caffeine on a legacy row', () => {
      const ask = makeInputs({ mood: 'surprise', strength: 'strong' });
      expect(matchTagsFor(subject(coffee(null, { caffeine: 'high' })), ask)).toEqual(['Strong']);
      expect(matchTagsFor(subject(coffee(null, { caffeine: 'low' })), ask)).toEqual([]);
    });

    it('is not a tag when nothing was asked, or for "balanced" (no such label)', () => {
      expect(matchTagsFor(subject(coffee(3)), neutral())).toEqual([]);
      expect(matchTagsFor(subject(coffee(1)), makeInputs({ mood: 'surprise', strength: 'balanced' }))).toEqual([]);
    });

    it('is only ever for coffee DRINKS', () => {
      const ask = makeInputs({ mood: 'surprise', strength: 'strong' });
      expect(matchTagsFor(subject(coffee(3, { is_coffee: false })), ask)).toEqual([]);
      expect(matchTagsFor(subject(coffee(3, { kind: 'dessert' })), ask)).toEqual([]);
    });
  });

  describe('5 — Iced / Hot, when asked for', () => {
    it('Iced for an iced drink, Hot for a hot one', () => {
      expect(matchTagsFor(subject(plain({ temperature: 'iced' })), makeInputs({ mood: 'surprise', temperature: 'iced' }))).toEqual(['Iced']);
      expect(matchTagsFor(subject(plain({ temperature: 'hot' })), makeInputs({ mood: 'surprise', temperature: 'hot' }))).toEqual(['Hot']);
    });

    it('a drink served either way qualifies for both', () => {
      const either = plain({ temperature: 'either' });
      expect(matchTagsFor(subject(either), makeInputs({ mood: 'surprise', temperature: 'iced' }))).toEqual(['Iced']);
      expect(matchTagsFor(subject(either), makeInputs({ mood: 'surprise', temperature: 'hot' }))).toEqual(['Hot']);
    });

    it('is absent for "either", and never for food or dessert (temperature never applies to them)', () => {
      expect(matchTagsFor(subject(plain({ temperature: 'iced' })), neutral())).toEqual([]);
      const garlicBread = plain({ kind: 'food', temperature: 'hot' });
      expect(matchTagsFor(subject(garlicBread), makeInputs({ mood: 'surprise', temperature: 'hot' }))).toEqual([]);
    });
  });

  describe('6 — Light & refreshing / Rich & filling, when asked for and the item is that', () => {
    it('Light & refreshing for a light, refreshing item', () => {
      const ask = makeInputs({ mood: 'surprise', body: 'light' });
      expect(matchTagsFor(subject(plain({ body: 'light', refreshment: 3 })), ask)).toEqual(['Light & refreshing']);
      // A light body that is not refreshing is only half of it.
      expect(matchTagsFor(subject(plain({ body: 'light', refreshment: 0 })), ask)).toEqual([]);
      expect(matchTagsFor(subject(plain({ body: 'rich', refreshment: 3 })), ask)).toEqual([]);
      // A legacy row has no refreshment: the body alone decides.
      expect(matchTagsFor(subject(legacyTraits({ body: 'light', moods: [] })), ask)).toEqual(['Light & refreshing']);
      expect(matchTagsFor(subject(legacyTraits({ body: 'medium', moods: [] })), ask)).toEqual([]);
    });

    it('Rich & filling for a rich item — the label keeps a hunger cue (COFFEY-SPEC §1)', () => {
      const ask = makeInputs({ mood: 'surprise', body: 'rich' });
      expect(matchTagsFor(subject(plain({ body: 'rich' })), ask)).toEqual(['Rich & filling']);
      expect(matchTagsFor(subject(plain({ body: 'medium' })), ask)).toEqual([]);
      expect(matchTagsFor(subject(plain({ body: 'light' })), ask)).toEqual([]);
    });

    it('is absent when no body was asked for', () => {
      expect(matchTagsFor(subject(plain({ body: 'rich' })), neutral())).toEqual([]);
    });
  });

  describe('7 — their budget ceiling', () => {
    it('is the ceiling label: Up to ₹100 / Up to ₹150 / Up to ₹200', () => {
      const tag = (budget: SuggestInputs['budget']) => matchTagsFor(subject(plain()), makeInputs({ mood: 'surprise', budget }));
      expect(tag('under_100')).toEqual(['Up to ₹100']);
      expect(tag('under_150')).toEqual(['Up to ₹150']);
      expect(tag('under_200')).toEqual(['Up to ₹200']);
      expect(tag('any')).toEqual([]);
    });

    it('has a label for every ceiling', () => {
      for (const budget of BUDGETS.filter((b) => b !== 'any')) {
        expect(matchTagsFor(subject(plain()), makeInputs({ mood: 'surprise', budget })), budget).toHaveLength(1);
      }
    });
  });

  describe('8 — Caffeine-free, when asked for', () => {
    it('is present for a caffeine-free item when "no caffeine" was asked for', () => {
      const ask = makeInputs({ mood: 'surprise', needs: ['no_caffeine'] });
      expect(matchTagsFor(subject(plain({ caffeine: 'none' })), ask)).toEqual(['Caffeine-free']);
      expect(matchTagsFor(subject(plain({ caffeine: 'none' })), neutral())).toEqual([]);
      // (The hard filter never lets a caffeinated item through this ask; the tag would not claim it anyway.)
      expect(matchTagsFor(subject(plain({ caffeine: 'high' })), ask)).toEqual([]);
    });
  });

  describe('priority and the cap of 3', () => {
    /** Everything on: a graded, iced, caramel, light, refreshing, bold, sugar-adjustable coffee. */
    const everything = plain({
      kind: 'drink',
      is_coffee: true,
      temperature: 'iced',
      caffeine: 'none',
      body: 'light',
      refreshment: 3,
      intensity: 3,
      sweetness_level: 4,
      mood_fit: { boost: 3 },
      flavor_notes: ['caramel'],
    });
    const allAsks = makeInputs({
      mood: 'boost',
      flavours: ['caramel'],
      sweetness: 'medium',
      strength: 'strong',
      temperature: 'iced',
      body: 'light',
      budget: 'under_150',
      needs: ['no_caffeine'],
    });

    it('never returns more than three, and MAX_MATCH_TAGS says so', () => {
      expect(MAX_MATCH_TAGS).toBe(3);
      expect(matchTagsFor(subject(everything, { sugarAdjustable: true }), allAsks)).toHaveLength(3);
    });

    it('takes them in priority order: feeling, flavour, sweetness…', () => {
      expect(matchTagsFor(subject(everything, { sugarAdjustable: true, name: 'Caramel Latte' }), allAsks)).toEqual([
        'A proper lift',
        'Caramel',
        'Medium sweet',
      ]);
    });

    it('…and the rest surface, in order, as the earlier ones fall away', () => {
      const asks = (over: Partial<SuggestInputs>) => makeInputs({ ...allAsks, ...over });
      const tags = (traits: MenuItemTraits, inputs: SuggestInputs) => matchTagsFor(subject(traits, { sugarAdjustable: true }), inputs);

      // No feeling that fits: flavour, sweetness, strength.
      expect(tags({ ...everything, mood_fit: { boost: 0 } }, allAsks)).toEqual(['Caramel', 'Medium sweet', 'Strong']);
      // …and no flavour asked: sweetness, strength, temperature.
      expect(tags({ ...everything, mood_fit: { boost: 0 } }, asks({ flavours: [] }))).toEqual(['Medium sweet', 'Strong', 'Iced']);
      // …and no sweetness: strength, temperature, body.
      expect(tags({ ...everything, mood_fit: { boost: 0 } }, asks({ flavours: [], sweetness: 'any' }))).toEqual([
        'Strong',
        'Iced',
        'Light & refreshing',
      ]);
      // …and no strength: temperature, body, budget.
      expect(
        tags({ ...everything, mood_fit: { boost: 0 } }, asks({ flavours: [], sweetness: 'any', strength: 'any' })),
      ).toEqual(['Iced', 'Light & refreshing', 'Up to ₹150']);
      // …and no temperature: body, budget, caffeine-free.
      expect(
        tags(
          { ...everything, mood_fit: { boost: 0 } },
          asks({ flavours: [], sweetness: 'any', strength: 'any', temperature: 'either' }),
        ),
      ).toEqual(['Light & refreshing', 'Up to ₹150', 'Caffeine-free']);
    });

    it('a tag is never repeated', () => {
      const tags = matchTagsFor(subject(everything, { sugarAdjustable: true }), allAsks);
      expect(new Set(tags).size).toBe(tags.length);
    });
  });

  it('works for the "usual", which is a menu row and not a Candidate: a name, a traits row and a flag are all it needs', () => {
    const usual = { name: 'Rose Latte', traits: plain({ mood_fit: { cosy: 3 } }), sugarAdjustable: false };
    expect(matchTagsFor(usual, makeInputs({ mood: 'cosy', flavours: ['floral'] }))).toEqual(['Cosy', 'Floral & tea']);
  });

  it('accepts a Candidate as it is', () => {
    const c = candidate({ menuItemId: 'x', category: 'Coffee', score: 0.5, name: 'Mocha', traits: legacyTraits({ moods: ['comfort'] }) });
    expect(matchTagsFor(c, makeInputs({ mood: 'comfort', flavours: ['chocolatey'] }))).toEqual(['Comforting', 'Chocolatey']);
  });

  it('only ever uses the fixed vocabulary', () => {
    const vocabulary = new Set<string>([
      ...MOODS.map((m) => MOOD_INFO[m].tag),
      ...FLAVOUR_FAMILIES.map((f) => FLAVOUR_FAMILY_INFO[f].tag),
      'Not sweet',
      'Lightly sweet',
      'Medium sweet',
      'Sweet',
      'Very sweet',
      'Strong',
      'Smooth & milky',
      'Iced',
      'Hot',
      'Light & refreshing',
      'Rich & filling',
      'Up to ₹100',
      'Up to ₹150',
      'Up to ₹200',
      'Caffeine-free',
    ]);
    const menu = buildFixtureMenu();
    const traitsById = buildFixtureTraitsById();
    const asks: SuggestInputs[] = [
      makeInputs({ mood: 'boost', secondaryMood: 'cool', kinds: [...KINDS], sweetness: 'light', strength: 'strong', body: 'light', flavours: [...FLAVOUR_FAMILIES], temperature: 'iced', budget: 'under_200', needs: ['no_caffeine'] }),
      makeInputs({ mood: 'unwind', kinds: ['drink'], sweetness: 'none', strength: 'mild', body: 'rich', temperature: 'hot', budget: 'under_100' }),
      makeInputs({ mood: 'celebrate', kinds: ['dessert'], sweetness: 'very', flavours: ['chocolatey', 'biscuit'] }),
    ];
    for (const inputs of asks) {
      for (const item of menu) {
        const traits = traitsById.get(item.id);
        if (!traits) continue;
        const tags = matchTagsFor({ name: item.name, traits, sugarAdjustable: Boolean(item.addon_groups.length) }, inputs);
        expect(tags.length).toBeLessThanOrEqual(3);
        for (const tag of tags) expect(vocabulary.has(tag), `${item.id}: ${tag}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The sweetness tag and the reason speak the same words (COFFEY-SPEC §4.6): the
// tag appears only when the sweetness the customer can get is in the SAME band
// as what they chose, and the reason's descriptor is drawn from that same band,
// so the two can never contradict each other on a card.
// ---------------------------------------------------------------------------

describe('the sweetness tag never contradicts the reason\'s sweetness descriptor', () => {
  type Pref = 'none' | 'light' | 'medium' | 'sweet' | 'very';
  const PREFS: Pref[] = ['none', 'light', 'medium', 'sweet', 'very'];
  /** The tag for each choice, and the descriptor word for the same band. */
  const WORD_OF_TAG = new Map<string, string>([
    ['Not sweet', 'unsweetened'],
    ['Lightly sweet', 'lightly sweet'],
    ['Medium sweet', 'medium-sweet'],
    ['Sweet', 'sweet'],
    ['Very sweet', 'dessert-sweet'],
  ]);
  const WORD_OF_PREF: Record<Pref, string> = {
    none: 'unsweetened',
    light: 'lightly sweet',
    medium: 'medium-sweet',
    sweet: 'sweet',
    very: 'dessert-sweet',
  };
  const SWEETNESS_WORDS = new Set(WORD_OF_TAG.values());

  /** The sweetness word a reason leads with, or null when it has none (a legacy row's reason has no descriptors). */
  function sweetnessDescriptorOf(reason: string): string | null {
    const lead = reason.split(' — ')[0].split(', with ')[0].toLowerCase();
    return lead.split(' and ').find((word) => SWEETNESS_WORDS.has(word)) ?? null;
  }

  const menu = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();

  it('across the fixture menu × every sweetness choice: whenever a sweetness tag appears, the reason\'s descriptor (when present) is the same band', () => {
    let tagged = 0;
    let described = 0;
    let checkedBoth = 0;
    for (const sweetness of PREFS) {
      // A neutral ask, so nothing else crowds the sweetness tag out of the three.
      const inputs = makeInputs({ mood: 'surprise', kinds: [...KINDS], sweetness });
      for (const item of menu) {
        const traits = traitsById.get(item.id);
        if (!traits) continue;
        // Each item both as the kitchen makes it and with a sugar choice, so every band is reachable.
        for (const sugarAdjustable of [false, true]) {
          const tags = matchTagsFor({ name: item.name, traits, sugarAdjustable }, inputs);
          const reason = templateReason(traits, inputs, reasonCodeFor(traits, inputs), item.name, sugarAdjustable);
          const tag = tags.find((t) => WORD_OF_TAG.has(t));
          const descriptor = sweetnessDescriptorOf(reason);
          const label = `${item.id} / ${sweetness} / sugar=${sugarAdjustable}: tags ${JSON.stringify(tags)}, reason "${reason}"`;
          if (descriptor) described++;
          if (tag) tagged++;
          if (tag && descriptor) {
            checkedBoth++;
            expect(descriptor, label).toBe(WORD_OF_TAG.get(tag));
          }
          // And the other way: a descriptor that IS the customer's own word comes with the tag.
          if (descriptor === WORD_OF_PREF[sweetness]) expect(tag, label).toBeDefined();
          if (tag) expect(tag, label).toBe(
            { none: 'Not sweet', light: 'Lightly sweet', medium: 'Medium sweet', sweet: 'Sweet', very: 'Very sweet' }[sweetness],
          );
        }
      }
    }
    // Not vacuous: the fixture really does produce tags, descriptors and both at once.
    expect(tagged).toBeGreaterThan(20);
    expect(described).toBeGreaterThan(20);
    expect(checkedBoth).toBeGreaterThan(5);
  });

  it('for every level × sugar choice × sweetness choice (restating the formulas): the tag appears exactly when the reason says the customer\'s own word', () => {
    const bandOf = (level: number) => (level <= 1 ? 'unsweetened' : level <= 3 ? 'lightly sweet' : level <= 5 ? 'medium-sweet' : level <= 8 ? 'sweet' : 'dessert-sweet');
    const target: Record<Pref, number> = { none: 0, light: 3, medium: 5, sweet: 7, very: 10 };
    for (const sweetness of PREFS) {
      const inputs = makeInputs({ mood: 'surprise', sweetness });
      for (let level = 0; level <= 10; level++) {
        for (const sugarAdjustable of [false, true]) {
          // What they can get: the item's level, or — with sugar — the point of [level, level+3] nearest the target.
          const achievable = sugarAdjustable ? Math.min(Math.min(10, level + 3), Math.max(level, target[sweetness])) : level;
          const traits = v2Traits({ kind: 'drink', intensity: null, refreshment: 0, textures: [], flavor_notes: [], sweetness_level: level, mood_fit: {}, moods: [] });
          const label = `${sweetness} / level ${level} / sugar=${sugarAdjustable} (achievable ${achievable})`;

          const reason = templateReason(traits, inputs, 'trait', 'X', sugarAdjustable);
          expect(sweetnessDescriptorOf(reason), label).toBe(bandOf(achievable));

          const tags = matchTagsFor({ name: 'X', traits, sugarAdjustable }, inputs);
          const sameBand = bandOf(achievable) === bandOf(target[sweetness]);
          expect(tags.some((t) => WORD_OF_TAG.has(t)), label).toBe(sameBand);
          if (sameBand) expect(sweetnessDescriptorOf(reason), label).toBe(WORD_OF_PREF[sweetness]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// deterministic picks
// ---------------------------------------------------------------------------

describe('deterministicPicks — three different picks (MMR, COFFEY-SPEC §4.4)', () => {
  it('pulls a different category in when the next candidate is a near-twin of a pick', () => {
    // Top 3 by raw score are all 'Coffee' and close together; a 'Tea' item sits just
    // below. MMR marks the twin down (0.12 × its similarity to the pick) enough for
    // the Tea to take a slot.
    const shortlist: Candidate[] = [
      candidate({ menuItemId: 'a-coffee', category: 'Coffee', score: 0.9 }),
      candidate({ menuItemId: 'b-coffee', category: 'Coffee', score: 0.89 }),
      candidate({ menuItemId: 'c-coffee', category: 'Coffee', score: 0.87 }),
      candidate({ menuItemId: 'd-tea', category: 'Tea', score: 0.86 }),
    ];
    const picks = deterministicPicks(shortlist, makeInputs());
    expect(picks).toHaveLength(SUGGEST_LIMITS.picks);
    // Best score first — the answer is ordered by score, not by the order MMR chose.
    expect(picks.map((p) => p.menuItemId)).toEqual(['a-coffee', 'b-coffee', 'd-tea']);
    // c-coffee (a third Coffee, most similar to the two already picked) is squeezed out.
    expect(picks.some((p) => p.menuItemId === 'c-coffee')).toBe(false);
  });

  it('never demotes a clearly better-scored item just for variety (score wins outside a tie)', () => {
    const shortlist: Candidate[] = [
      candidate({ menuItemId: 'best-coffee', category: 'Coffee', score: 0.9 }),
      candidate({ menuItemId: 'mid-tea', category: 'Tea', score: 0.6 }),
      candidate({ menuItemId: 'far-worse-coffee', category: 'Coffee', score: 0.5 }),
    ];
    const picks = deterministicPicks(shortlist, makeInputs());
    expect(picks.map((p) => p.menuItemId)).toEqual(['best-coffee', 'mid-tea', 'far-worse-coffee']);
  });

  it('every reason still lints clean and reasonCode follows the customer\'s mood when tagged', () => {
    const shortlist: Candidate[] = [
      candidate({ menuItemId: 'boost-item', category: 'Coffee', score: 0.9, traits: legacyTraits({ menu_item_id: 'boost-item', moods: ['boost'] }) }),
      candidate({ menuItemId: 'other-item', category: 'Tea', score: 0.5 }),
    ];
    const picks = deterministicPicks(shortlist, makeInputs({ mood: 'boost' }));
    for (const p of picks) expect(lintReason(p.reason).ok).toBe(true);
    expect(picks.find((p) => p.menuItemId === 'boost-item')?.reasonCode).toBe('boost');
    expect(picks.find((p) => p.menuItemId === 'other-item')?.reasonCode).toBe('trait');
  });

  it("with two feelings, a pick's reasonCode is the first of them it fits", () => {
    const shortlist: Candidate[] = [
      candidate({ menuItemId: 'cool-only', category: 'Iced', score: 0.9, traits: legacyTraits({ menu_item_id: 'cool-only', moods: ['cool'] }) }),
      candidate({ menuItemId: 'both', category: 'Cold Brew', score: 0.8, traits: legacyTraits({ menu_item_id: 'both', moods: ['boost', 'cool'] }) }),
    ];
    const picks = deterministicPicks(shortlist, makeInputs({ mood: 'boost', secondaryMood: 'cool' }));
    expect(picks.find((p) => p.menuItemId === 'cool-only')?.reasonCode).toBe('cool');
    expect(picks.find((p) => p.menuItemId === 'both')?.reasonCode).toBe('boost');
  });

  it("asked for a drink AND something sweet: the picks pair them, however the scores run", () => {
    const drink = (id: string, score: number, category: string) =>
      candidate({ menuItemId: id, category, score, traits: legacyTraits({ menu_item_id: id, kind: 'drink' }) });
    const shortlist: Candidate[] = [
      drink('d1', 0.95, 'Coffee'),
      drink('d2', 0.94, 'Iced Coffee'),
      drink('d3', 0.93, 'Cold Brew'),
      candidate({ menuItemId: 'cake', category: 'Cheesecakes', score: 0.3, traits: legacyTraits({ menu_item_id: 'cake', kind: 'dessert' }) }),
    ];
    const picks = deterministicPicks(shortlist, makeInputs({ kinds: ['drink', 'dessert'] }));
    expect(picks.map((p) => p.menuItemId)).toContain('cake');
    expect(picks.map((p) => p.menuItemId)).toContain('d1');
    expect(deterministicPicks(shortlist, makeInputs({ kinds: ['drink'] })).map((p) => p.menuItemId)).not.toContain('cake');
  });

  it('uses each candidate\'s own score, gives at most three, and gives what it has when there are fewer', () => {
    const one = deterministicPicks([candidate({ menuItemId: 'only', category: 'Coffee', score: 0.5 })], makeInputs());
    expect(one.map((p) => p.menuItemId)).toEqual(['only']);
    expect(deterministicPicks([], makeInputs())).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) =>
      candidate({ menuItemId: `i${i}`, category: `C${i}`, score: 0.9 - i * 0.05 }),
    );
    expect(deterministicPicks(many, makeInputs())).toHaveLength(SUGGEST_LIMITS.picks);
  });

  it('gives the sugar-aware sentence for a Candidate with a sugar choice', () => {
    const cold = candidate({
      menuItemId: 'cold',
      category: 'Cold Brew',
      score: 0.9,
      name: 'Cold Brew',
      sugarAdjustable: true,
      traits: v2Traits({ menu_item_id: 'cold', intensity: 3, sweetness_level: 0, mood_fit: { boost: 3 }, flavor_notes: [], refreshment: 0 }),
    });
    const [pick] = deterministicPicks([cold], makeInputs({ sweetness: 'light' }));
    // Adjustable + "lightly sweet" ⇒ described as they'll get it (level 3: lightly sweet), not "unsweetened".
    expect(pick.reason.startsWith('Lightly sweet')).toBe(true);
    expect(buildSugarGroup().name).toBe('Sugar'); // (fixture sanity: the live group's name)
  });
});
