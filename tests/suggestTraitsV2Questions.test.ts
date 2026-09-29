import { describe, expect, it } from 'vitest';

// Coffey v2 (docs/COFFEY-SPEC.md §3.2) — the question set Jev answers about
// every menu item, and the state it is shown. Pure: nothing here calls Jev.
// The wording is part of the spec (the examples are what teach Jev this menu),
// so it is pinned here word for word: an accidental edit should be a red test,
// a deliberate one a reviewed diff.

import { buildJevTraitQuestions, buildJevTraitState, type MenuItemForTagging } from '@/lib/suggest/traitsPrompt';
import { FLAVOR_VOCABULARY, MOOD_INFO, SCALAR_TRAIT_QUESTION_COUNT, TEXTURES, TEXTURE_HINTS, TRAIT_QUESTION_COUNT } from '@/lib/suggest/traitVocabulary';
import { DAYPARTS, MOODS } from '@/lib/suggest/types';

const questions = buildJevTraitQuestions();
const q = (key: string) => questions[key] as unknown as Record<string, unknown>;

describe('buildJevTraitQuestions — the set', () => {
  it('asks exactly TRAIT_QUESTION_COUNT questions', () => {
    expect(Object.keys(questions)).toHaveLength(TRAIT_QUESTION_COUNT);
  });

  it('is 10 single-answer questions plus a fit per mood, a daypart, a texture and a note each', () => {
    expect(TRAIT_QUESTION_COUNT).toBe(SCALAR_TRAIT_QUESTION_COUNT + MOODS.length + DAYPARTS.length + TEXTURES.length + FLAVOR_VOCABULARY.length);
    expect(SCALAR_TRAIT_QUESTION_COUNT).toBe(10);
  });

  it('uses the documented keys — flavours by INDEX, since notes contain spaces', () => {
    const expected = [
      'temperature', 'caffeine', 'is_coffee', 'kind', 'body', 'sweetness', 'intensity', 'refreshment', 'indulgence', 'novelty',
      ...MOODS.map((m) => `mood_${m}`),
      ...DAYPARTS.map((d) => `daypart_${d}`),
      ...TEXTURES.map((t) => `texture_${t}`),
      ...FLAVOR_VOCABULARY.map((_, i) => `flavor_${i}`),
    ];
    expect(Object.keys(questions).sort()).toEqual([...expected].sort());
    for (const key of Object.keys(questions)) expect(key).not.toMatch(/\s/);
  });

  it('asks each field with the right kind of question', () => {
    for (const key of ['temperature', 'caffeine', 'kind', 'body']) expect(q(key).type).toBe('choice');
    for (const key of ['sweetness', 'intensity', 'refreshment', 'indulgence', 'novelty', ...MOODS.map((m) => `mood_${m}`)]) {
      expect(q(key).type).toBe('score');
    }
    for (const key of ['is_coffee', ...DAYPARTS.map((d) => `daypart_${d}`), ...TEXTURES.map((t) => `texture_${t}`), ...FLAVOR_VOCABULARY.map((_, i) => `flavor_${i}`)]) {
      expect(q(key).type).toBe('noul');
    }
  });

  it('is plain JSON (it goes over the wire) and is rebuilt fresh on every call', () => {
    expect(JSON.parse(JSON.stringify(questions))).toEqual(questions);
    const other = buildJevTraitQuestions();
    expect(other).toEqual(questions);
    expect(other).not.toBe(questions);
  });
});

describe('buildJevTraitQuestions — choice questions', () => {
  it('temperature', () => {
    expect(q('temperature').criteria).toEqual({
      hot: 'Served hot.',
      iced: 'Served cold or over ice — iced coffees, cold brews, cremes and shakes.',
      either: 'A drink the café offers both hot and iced.',
      ambient: 'Food or a dessert — no drink serving temperature applies.',
    });
  });

  it('caffeine — chocolate, cocoa, Nutella, Oreo and KitKat are ALWAYS none', () => {
    expect(q('caffeine').criteria).toEqual({
      none: 'No caffeine at all — no coffee, tea or matcha. This ALWAYS includes chocolate, cocoa, Nutella, Oreo, KitKat and hot chocolate, which contain no caffeine however rich they taste; also fruit coolers and food or desserts made without coffee.',
      low: 'A little caffeine — a milky tea, chai or matcha drink, or a dessert made with coffee such as tiramisu.',
      medium: 'A moderate amount — a milky coffee (latte, cappuccino, flat white, mocha, a coffee creme or frappé), or a strong tea or matcha.',
      high: 'A lot — espresso-forward coffee: espresso, americano, long black, macchiato, espresso on the rocks, cold brew.',
    });
  });

  it('kind', () => {
    expect(q('kind').criteria).toEqual({
      drink: 'Anything you drink, including thick shakes and cremes; an affogato counts as a drink.',
      dessert: 'A sweet food — waffles, crepes, cupcakes, cheesecakes, sundaes, brownies, sweet croissants.',
      food: 'A savoury food — sandwiches, nachos, garlic bread, a plain butter croissant.',
    });
  });

  it('body keeps the v1 criteria', () => {
    expect(q('body').criteria).toEqual({
      light: 'Light-bodied — or, for food/dessert, a light portion.',
      medium: 'Medium-bodied — or, for food/dessert, a medium portion.',
      rich: 'Rich, heavy-bodied — or, for food/dessert, a hearty, filling portion.',
    });
  });

  it('every choice label is a value the validators accept', () => {
    expect(Object.keys(q('temperature').criteria as object)).toEqual(['hot', 'iced', 'either', 'ambient']);
    expect(Object.keys(q('caffeine').criteria as object)).toEqual(['none', 'low', 'medium', 'high']);
    expect(Object.keys(q('kind').criteria as object).sort()).toEqual(['dessert', 'drink', 'food']);
    expect(Object.keys(q('body').criteria as object)).toEqual(['light', 'medium', 'rich']);
  });
});

describe('buildJevTraitQuestions — is_coffee', () => {
  it('is a noul with what "yes" and "no" mean', () => {
    expect(questions.is_coffee).toEqual({
      type: 'noul',
      instructions: 'Is this item coffee-based (made with espresso or coffee)?',
      criteria: {
        true: 'Made with espresso, cold brew or coffee — including mochas, coffee cremes, tiramisu and affogato.',
        false: 'No coffee at all — chocolate, tea, matcha, fruit, plain dairy, or food without coffee.',
      },
    });
  });
});

describe('buildJevTraitQuestions — score questions', () => {
  it('sweetness has six anchors and is "as the kitchen makes it — NOT counting optional table sugar"', () => {
    expect(q('sweetness').instructions).toBe(
      'How sweet is this item as the kitchen makes it — NOT counting any optional table sugar the customer can choose to add?',
    );
    expect(q('sweetness').criteria).toEqual([
      'Not sweet at all — e.g. espresso, americano, long black, black cold brew, garlic bread, nachos, a savoury sandwich.',
      'Barely sweet — only the natural sweetness of milk; e.g. an unsweetened cappuccino, latte or flat white.',
      'Lightly sweet — e.g. a matcha or chai latte, a plain butter croissant, a lightly flavoured latte.',
      'Moderately sweet — e.g. a mocha, a caramel or hazelnut latte, a fruit iced tea or lemonade.',
      'Sweet — e.g. a creamy blended cold coffee, a hot chocolate, a cupcake, a fruit cheesecake.',
      'Very sweet, dessert-level — e.g. Nutella, Oreo or KitKat shakes, loaded chocolate waffles, brownies, sundaes.',
    ]);
  });

  it('intensity', () => {
    expect(q('intensity').instructions).toBe('How bold or strong is its flavour?');
    expect(q('intensity').criteria).toEqual([
      'Gentle and mild — e.g. a plain milky drink, vanilla, a soft sponge.',
      'Mellow — e.g. a latte, a creamy vanilla shake.',
      'Full-flavoured — e.g. a cappuccino, a mocha, a chai latte, a chocolate waffle.',
      'Bold and intense — e.g. an espresso, an americano, a cold brew, dark chocolate, garlic.',
    ]);
  });

  it('refreshment', () => {
    expect(q('refreshment').instructions).toBe('How refreshing and thirst-quenching is it?');
    expect(q('refreshment').criteria).toEqual([
      'Not refreshing — heavy, warm or filling (a hot chocolate, a loaded waffle).',
      'A little refreshing — cold but rich and creamy (a thick cold-coffee shake).',
      'Refreshing — cold and fairly light (an iced latte, a cold brew).',
      'Very refreshing — cold, light, often fruity or fizzy (an iced americano, a lemonade, an espresso tonic).',
    ]);
  });

  it('indulgence', () => {
    expect(q('indulgence').instructions).toBe('How much of a treat is it?');
    expect(q('indulgence').criteria).toEqual([
      'Everyday and simple — an espresso, an americano, a plain croissant.',
      'A small comfort — a latte, a cappuccino, a chai latte.',
      'A treat — a mocha, a flavoured creme, a cupcake.',
      'A real indulgence — a loaded waffle, a Nutella or Oreo shake, a brownie sundae, a cheesecake.',
    ]);
  });

  it('novelty', () => {
    expect(q('novelty').instructions).toBe('How unusual would this feel to a typical café-goer in India?');
    expect(q('novelty').criteria).toEqual([
      'An everyday classic — a cappuccino, a latte, a hot chocolate, garlic bread.',
      'Familiar with a twist — a hazelnut latte, a caramel creme, a Nutella waffle.',
      'Distinctive — a Biscoff latte, a rose latte, a matcha drink, a Vietnamese latte.',
      'Adventurous — an unusual pairing like cranberry coffee, orange espresso, blueberry matcha or a spiced orange cooler.',
    ]);
  });

  it('asks each mood as "A customer who <need>. How well does this item suit them?" with a four-step rubric', () => {
    for (const mood of MOODS) {
      const question = q(`mood_${mood}`);
      expect(question.instructions).toBe(`A customer who ${MOOD_INFO[mood].need}. How well does this item suit them?`);
      expect(question.criteria).toEqual([
        'Not a fit for this feeling.',
        'Could work for this feeling.',
        'A good fit for this feeling.',
        'An ideal pick for this feeling.',
      ]);
    }
    expect(q('mood_focus').instructions).toContain('working or studying');
    expect(q('mood_unwind').instructions).toBe(
      `A customer who ${MOOD_INFO.unwind.need}. How well does this item suit them?`,
    );
    expect(q('mood_unwind').instructions).toContain('stressed');
  });
});

describe('buildJevTraitQuestions — yes/no questions', () => {
  it('dayparts carry their hour ranges', () => {
    expect(questions.daypart_morning).toEqual({
      type: 'noul',
      instructions: 'Would a customer naturally order this in the morning (6am–noon), e.g. with breakfast or to start the day?',
    });
    expect(q('daypart_afternoon').instructions).toBe('Would a customer naturally order this in the afternoon (noon–5pm)?');
    expect(q('daypart_evening').instructions).toBe(
      'Would a customer naturally order this in the evening (5pm–9pm), e.g. an after-work treat or a hangout with friends?',
    );
    expect(q('daypart_late').instructions).toBe(
      'Would a customer naturally order this late at night (after 9pm)? Late-night picks usually have little or no caffeine, or are a dessert.',
    );
  });

  it('textures use their hint where the bare word is ambiguous', () => {
    for (const texture of TEXTURES) {
      expect(q(`texture_${texture}`).instructions).toBe(`Is this item's texture noticeably ${TEXTURE_HINTS[texture] ?? texture}?`);
    }
    expect(q('texture_icy').instructions).toBe("Is this item's texture noticeably icy or slushy, served over lots of ice?");
    expect(q('texture_silky').instructions).toBe("Is this item's texture noticeably silky?");
  });

  it('flavour notes use their hint where the note alone is ambiguous, keyed by vocabulary index', () => {
    FLAVOR_VOCABULARY.forEach((flavor, i) => {
      expect(q(`flavor_${i}`).instructions).toBe(`Does this item noticeably taste of ${flavor.hint ?? flavor.note}?`);
    });
    const hazelnut = FLAVOR_VOCABULARY.findIndex((f) => f.note === 'hazelnut');
    expect(q(`flavor_${hazelnut}`).instructions).toBe('Does this item noticeably taste of hazelnut, including Nutella?');
    const chai = FLAVOR_VOCABULARY.findIndex((f) => f.note === 'chai spice');
    expect(q(`flavor_${chai}`).instructions).toContain('masala chai spices');
  });
});

describe('buildJevTraitState', () => {
  const item: MenuItemForTagging = {
    id: 'i1',
    name: 'Cappucino Iced',
    description: 'Iced Cappuccino blends velvety espresso with frothy milk.',
    category: 'Coffee',
    parent_category: 'Iced Drinks',
    sizes: [{ label: 'Regular', price_inr: 180 }],
    customisations: [
      { group: 'Choice of Sugar', options: ['Stevia (sugarfree)', 'Brown Sugar', 'No Sugar', 'Normal'] },
      { group: 'Choose Milk', options: ['Almond', 'Oat'] },
    ],
  };

  it('is the café plus the item, in the documented shape', () => {
    expect(buildJevTraitState(item)).toEqual({
      cafe: 'HIOC. — a pure-vegetarian coffee and waffle café in Agra, India.',
      item: {
        name: 'Cappucino Iced',
        category: 'Coffee',
        parent_category: 'Iced Drinks',
        description: 'Iced Cappuccino blends velvety espresso with frothy milk.',
        sizes: ['Regular ₹180'],
        customisations: ['Choice of Sugar: Stevia (sugarfree), Brown Sugar, No Sugar, Normal', 'Choose Milk: Almond, Oat'],
      },
    });
  });

  it('keeps the key order name, category, parent_category, description, related_description, sizes, customisations', () => {
    const state = buildJevTraitState({ ...item, description: '', related_description: 'From the related menu item "Nutella": Borrowed.' }) as { item: Record<string, unknown> };
    expect(Object.keys(state.item)).toEqual(['name', 'category', 'parent_category', 'description', 'related_description', 'sizes', 'customisations']);
  });

  it('omits related_description when it is absent or blank', () => {
    expect(buildJevTraitState(item)).not.toHaveProperty('item.related_description');
    expect(buildJevTraitState({ ...item, related_description: '   ' })).not.toHaveProperty('item.related_description');
  });

  it('lists every size with its price, and tolerates an item with none', () => {
    const many = buildJevTraitState({ ...item, sizes: [{ label: 'Large', price_inr: 70 }, { label: 'Extra Large', price_inr: 105 }] }) as { item: { sizes: string[] } };
    expect(many.item.sizes).toEqual(['Large ₹70', 'Extra Large ₹105']);
    const none = buildJevTraitState({ ...item, sizes: [], customisations: [] }) as { item: { sizes: string[]; customisations: string[] } };
    expect(none.item.sizes).toEqual([]);
    expect(none.item.customisations).toEqual([]);
  });

  it('leaves a customisation group with no options out', () => {
    const state = buildJevTraitState({ ...item, customisations: [{ group: 'Empty', options: [] }, { group: 'Ice Level', options: ['No Ice', 'Less Ice'] }] }) as {
      item: { customisations: string[] };
    };
    expect(state.item.customisations).toEqual(['Ice Level: No Ice, Less Ice']);
  });

  it('is plain JSON', () => {
    const state = buildJevTraitState(item);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
