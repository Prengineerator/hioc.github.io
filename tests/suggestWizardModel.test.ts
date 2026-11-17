import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// The /suggest wizard (COFFEY-SPEC §1): the pure model behind it, plus a render
// smoke test of the two question steps. There is no DOM in this suite, so the
// steps are server-rendered (they take no router or cart context).

import { SuggestionCard } from '@/components/suggest/SuggestionCard';
import { FeelingStep, WantsStep } from '@/components/suggest/WizardSteps';
import {
  buildInputs,
  initialState,
  disabledOptions,
  missLabel,
  moreOptionsSummary,
  selectedOptions,
  offeredFlavours,
  recapLabels,
  relaxState,
  selectMood,
  toggleBody,
  toggleBudget,
  toggleCaffeineFree,
  toggleCoffee,
  toggleFlavour,
  toggleKind,
  toggleSweetness,
  toggleTemperature,
  unmetLine,
  type WizardState,
} from '@/components/suggest/wizardModel';
import { FACET_OPTIONS } from '@/lib/suggest/facets';
import { validateSuggestInputs } from '@/lib/suggest/validate';
import { FLAVOUR_FAMILIES, FLAVOUR_OFFER_MIN, MOODS } from '@/lib/suggest/types';
import type { FlavourCounts } from '@/lib/suggest/types';
import { makeMenuItem } from './fixtures/suggestMenu';

const COUNTS: FlavourCounts = {
  drink: { chocolatey: 5, caramel: 2, nutty: 1, fruity: 3 },
  dessert: { chocolatey: 4, caramel: 1, biscuit: 3, floral: 2 },
  food: { spiced: 1 },
};

function state(over: Partial<WizardState> = {}): WizardState {
  return { ...initialState(), mood: 'boost', ...over };
}

describe('buildInputs', () => {
  it('sends neutral values for everything cleared, and a body the validator accepts as v2', () => {
    const inputs = buildInputs(state(), null);
    expect(inputs).toMatchObject({
      mood: 'boost',
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
    });
    expect(validateSuggestInputs(inputs)).toEqual(inputs);
  });

  it('is valid for every mood and a fully set state', () => {
    for (const mood of MOODS) {
      let s = state({ mood, note: '  studying  ' });
      s = toggleKind(s, 'dessert');
      s = toggleTemperature(s, 'iced');
      s = toggleCoffee(s, 'smooth');
      s = toggleSweetness(s, 'light');
      s = toggleFlavour(s, 'chocolatey');
      s = toggleBudget(s, 'under_150');
      s = toggleBody(s, 'rich');
      const inputs = buildInputs(s, COUNTS);
      expect(typeof validateSuggestInputs(inputs)).toBe('object');
      expect(inputs.secondaryMood).toBeNull();
      expect(inputs.note).toBe('studying');
    }
  });

  it('sends hot/iced and coffee as neutral while no drink is ticked', () => {
    let s = state();
    s = toggleTemperature(s, 'iced');
    s = toggleCoffee(s, 'strong');
    s = toggleKind(s, 'dessert');
    s = toggleKind(s, 'drink');
    expect(s.kinds).toEqual(['dessert']);
    const inputs = buildInputs(s, null);
    expect(inputs.temperature).toBe('either');
    expect(inputs.base).toBe('either');
    expect(inputs.strength).toBe('any');
    // They are kept, so ticking a drink again brings them back.
    expect(buildInputs(toggleKind(s, 'drink'), null).temperature).toBe('iced');
  });

  it('maps each coffee chip to base and strength', () => {
    const at = (c: 'strong' | 'smooth' | 'none') => {
      const i = buildInputs(toggleCoffee(state(), c), null);
      return [i.base, i.strength];
    };
    expect(at('strong')).toEqual(['coffee', 'strong']);
    expect(at('smooth')).toEqual(['coffee', 'mild']);
    expect(at('none')).toEqual(['no_coffee', 'any']);
  });

  it('maps the three sweetness chips', () => {
    expect(buildInputs(toggleSweetness(state(), 'none'), null).sweetness).toBe('none');
    expect(buildInputs(toggleSweetness(state(), 'light'), null).sweetness).toBe('light');
    expect(buildInputs(toggleSweetness(state(), 'sweet'), null).sweetness).toBe('sweet');
  });

  it('every chip is a toggle: tapping again clears it', () => {
    expect(toggleTemperature(toggleTemperature(state(), 'hot'), 'hot').temperature).toBeNull();
    expect(toggleCoffee(toggleCoffee(state(), 'none'), 'none').coffee).toBeNull();
    expect(toggleSweetness(toggleSweetness(state(), 'sweet'), 'sweet').sweetness).toBeNull();
    expect(toggleBudget(toggleBudget(state(), 'under_100'), 'under_100').budget).toBeNull();
    expect(toggleBody(toggleBody(state(), 'light'), 'light').body).toBeNull();
    expect(toggleFlavour(toggleFlavour(state(), 'fruity'), 'fruity').flavours).toEqual([]);
  });

  it('keeps at least one kind ticked', () => {
    expect(toggleKind(state(), 'drink').kinds).toEqual(['drink']);
  });

  it('caffeine-free sets needs and clears strong and smooth, but leaves No coffee', () => {
    const strong = toggleCoffee(state(), 'strong');
    const cf = toggleCaffeineFree(strong);
    expect(cf.coffee).toBeNull();
    expect(buildInputs(cf, null).needs).toEqual(['no_caffeine']);
    // Strong and smooth are disabled while it is on.
    expect(toggleCoffee(cf, 'strong').coffee).toBeNull();
    expect(toggleCoffee(cf, 'smooth').coffee).toBeNull();
    const none = toggleCoffee(cf, 'none');
    expect(none.coffee).toBe('none');
    expect(toggleCaffeineFree(none).coffee).toBe('none');
    expect(buildInputs(toggleCaffeineFree(cf), null).needs).toEqual([]);
  });

  it('drops a selected flavour that is no longer offered', () => {
    let s = toggleKind(state(), 'dessert');
    s = toggleFlavour(s, 'floral'); // only desserts carry floral (2, below the minimum)
    s = toggleFlavour(s, 'chocolatey');
    expect(buildInputs(s, COUNTS).flavours).toEqual(['chocolatey']);
    s = toggleKind(s, 'drink'); // drinks off
    s = toggleKind(s, 'food'); // food on, so dessert can go
    s = toggleKind(s, 'dessert');
    expect(s.kinds).toEqual(['food']);
    expect(buildInputs(s, COUNTS).flavours).toEqual([]);
  });
});

describe('offeredFlavours', () => {
  it('hides a family below the minimum and sums across ticked kinds', () => {
    expect(FLAVOUR_OFFER_MIN).toBe(3);
    expect(offeredFlavours(['drink'], COUNTS)).toEqual(['chocolatey', 'fruity']);
    expect(offeredFlavours(['dessert'], COUNTS)).toEqual(['chocolatey', 'biscuit']);
    // caramel 2 + 1, floral 2, nutty 1 + 0: caramel now qualifies.
    expect(offeredFlavours(['drink', 'dessert'], COUNTS)).toEqual(['chocolatey', 'caramel', 'biscuit', 'fruity']);
    expect(offeredFlavours(['drink', 'dessert', 'food'], COUNTS)).toEqual(['chocolatey', 'caramel', 'biscuit', 'fruity']);
  });

  it('offers none for savoury only, and all seven with null counts (except savoury only)', () => {
    expect(offeredFlavours(['food'], COUNTS)).toEqual([]);
    expect(offeredFlavours(['drink'], null)).toEqual([...FLAVOUR_FAMILIES]);
    expect(offeredFlavours(['dessert', 'food'], null)).toHaveLength(7);
    expect(offeredFlavours(['food'], null)).toEqual([]);
  });
});

describe('recapLabels', () => {
  it('lists the feeling first, then only what is set, in chip words', () => {
    let s = state({ mood: 'boost' });
    expect(recapLabels(s, COUNTS)).toEqual(['Tired — need a boost']);
    s = toggleTemperature(s, 'iced');
    s = toggleCoffee(s, 'strong');
    s = toggleSweetness(s, 'none');
    s = toggleFlavour(s, 'chocolatey');
    expect(recapLabels(s, COUNTS)).toEqual(['Tired — need a boost', 'Iced', 'Strong coffee', 'Not sweet', 'Chocolatey']);
  });

  it('names the kinds only when they are not just a drink, and drops hidden groups', () => {
    let s = toggleTemperature(state(), 'hot');
    s = toggleKind(s, 'dessert');
    expect(recapLabels(s, COUNTS)).toEqual(['Tired — need a boost', 'A drink', 'Something sweet to eat', 'Hot']);
    s = toggleKind(s, 'drink');
    expect(recapLabels(s, COUNTS)).toEqual(['Tired — need a boost', 'Something sweet to eat']);
  });

  it('includes the More options choices and leaves the note out', () => {
    let s = toggleCaffeineFree(state());
    s = toggleBudget(s, 'under_150');
    s = toggleBody(s, 'light');
    s = { ...s, note: 'late' };
    expect(recapLabels(s, null)).toEqual(['Tired — need a boost', 'Caffeine-free', 'Up to ₹150', 'Light & refreshing']);
  });
});

describe('unmetLine', () => {
  it('says once that some picks are the closest we have, without listing choices', () => {
    const s = toggleFlavour(state(), 'chocolatey');
    const line = "Some picks are the closest we have — each card says what's different.";
    expect(unmetLine(['flavours'], s, COUNTS)).toBe(line);
    expect(unmetLine(['flavours', 'strength'], s, COUNTS)).toBe(line);
  });

  it('is null when nothing is unmet', () => {
    expect(unmetLine(undefined, state())).toBeNull();
    expect(unmetLine([], state())).toBeNull();
  });
});

describe('missLabel', () => {
  it('names one choice in the current chip words', () => {
    const s = toggleFlavour(state(), 'chocolatey');
    expect(missLabel(['flavours'], s, COUNTS)).toBe('Closest we have: not Chocolatey');
  });

  it('joins several with "or", lower-case except flavours', () => {
    let s = toggleCoffee(state(), 'strong');
    s = toggleSweetness(s, 'light');
    expect(missLabel(['strength', 'sweetness'], s)).toBe('Closest we have: not strong coffee or lightly sweet');
    s = toggleFlavour(s, 'fruity');
    expect(missLabel(['flavours', 'body'], toggleBody(s, 'rich'), COUNTS)).toBe(
      'Closest we have: not Fruity or rich & filling',
    );
  });

  it('never reads "not not sweet"', () => {
    expect(missLabel(['sweetness'], toggleSweetness(state(), 'none'))).toBe('Closest we have: not unsweetened');
    expect(missLabel(['sweetness'], toggleSweetness(state(), 'sweet'))).toBe('Closest we have: not sweet');
  });

  it('is null with no misses or no set choice', () => {
    expect(missLabel(undefined, state())).toBeNull();
    expect(missLabel([], state())).toBeNull();
    expect(missLabel(['body'], state())).toBeNull();
  });
});

describe('SuggestionCard missLabel', () => {
  const item = makeMenuItem({ id: 'm1', name: 'Mocha', priceInr: 150 });
  const render = (extra: { missLabel?: string | null; isUsual?: boolean }) =>
    renderToStaticMarkup(
      createElement(SuggestionCard, {
        item,
        pick: { menuItemId: 'm1', reason: 'Rich and chocolatey.', reasonCode: 'cosy', matchTags: ['Chocolatey'] },
        onAddToCart: () => {},
        onFeedback: () => {},
        ...extra,
      }),
    );
  it('renders the line when given one, after the tags, and nothing otherwise', () => {
    const html = render({ missLabel: 'Closest we have: not strong coffee' });
    expect(html).toContain('Closest we have: not strong coffee');
    expect(html.indexOf('Why it matches')).toBeLessThan(html.indexOf('Closest we have'));
    expect(render({})).not.toContain('Closest we have');
    expect(render({ missLabel: null })).not.toContain('Closest we have');
    expect(render({ missLabel: 'Closest we have: not x', isUsual: true })).not.toContain('Closest we have');
  });
});

describe('disabledOptions / selectedOptions', () => {
  const facets = [{ kind: 'drink' as const, states: FACET_OPTIONS.map((o) => (o === 'temp:hot' ? 'k' : 'x')).join('') }];
  it('is empty without facets', () => {
    expect(disabledOptions(state(), null).size).toBe(0);
  });
  it('lists only what buildInputs would send', () => {
    let s = toggleTemperature(toggleFlavour(state(), 'fruity'), 'iced');
    s = toggleSweetness(s, 'none');
    expect(selectedOptions(s, null)).toEqual(['temp:iced', 'sweet:none', 'flavour:fruity']);
    s = toggleKind(toggleKind(s, 'dessert'), 'drink'); // drink off
    expect(selectedOptions(s, null)).toEqual(['sweet:none', 'flavour:fruity']);
    expect(selectedOptions(toggleKind(s, 'dessert'), COUNTS)).toEqual(['sweet:none']);
  });
  it('disables what the facets rule out and never a selected chip', () => {
    const off = disabledOptions(state(), facets);
    expect(off.has('temp:hot')).toBe(false);
    expect(off.has('temp:iced')).toBe(true);
    const picked = disabledOptions(toggleTemperature(state(), 'iced'), facets);
    expect(picked.has('temp:iced')).toBe(false);
  });
});

describe('moreOptionsSummary', () => {
  it('reads plain when nothing is set, and summarises what is', () => {
    expect(moreOptionsSummary(state())).toBe('More options');
    let s = toggleCaffeineFree(state());
    s = toggleBudget(s, 'under_150');
    expect(moreOptionsSummary(s)).toBe('Caffeine-free · Up to ₹150');
    expect(moreOptionsSummary(toggleBody(state(), 'rich'))).toBe('Rich & filling');
    expect(moreOptionsSummary({ ...state(), note: 'hi' })).toBe('Note added');
  });
});

describe('context defaults', () => {
  it('celebrate ticks dessert, once', () => {
    let s = selectMood(initialState(), 'celebrate');
    expect(s.kinds).toEqual(['drink', 'dessert']);
    s = toggleKind(s, 'dessert'); // the customer un-ticks it
    s = selectMood(selectMood(s, 'boost'), 'celebrate');
    expect(s.kinds).toEqual(['drink']);
  });

  it('cool selects Iced, once', () => {
    let s = selectMood(initialState(), 'cool');
    expect(s.temperature).toBe('iced');
    s = toggleTemperature(s, 'iced'); // cleared by the customer
    s = selectMood(selectMood(s, 'cosy'), 'cool');
    expect(s.temperature).toBeNull();
  });

  it('never overrides a touched group', () => {
    const kinds = selectMood(toggleKind(initialState(), 'food'), 'celebrate');
    expect(kinds.kinds).toEqual(['drink', 'food']);
    const temp = selectMood(toggleTemperature(initialState(), 'hot'), 'cool');
    expect(temp.temperature).toBe('hot');
  });

  it('picking a feeling again (same or different) just sets it', () => {
    const s = selectMood(selectMood(initialState(), 'focus'), 'focus');
    expect(s.mood).toBe('focus');
    expect(s.kinds).toEqual(['drink']);
  });
});

describe('relaxState', () => {
  const full = (): WizardState => {
    let s = state();
    s = toggleTemperature(s, 'iced');
    s = toggleCoffee(s, 'none');
    s = toggleSweetness(s, 'sweet');
    s = toggleBudget(s, 'under_100');
    s = toggleCaffeineFree(s);
    return s;
  };
  it('clears the right choice for each constraint', () => {
    expect(relaxState(full(), 'temperature').temperature).toBeNull();
    expect(relaxState(full(), 'sweetness').sweetness).toBeNull();
    expect(relaxState(full(), 'base').coffee).toBeNull();
    expect(relaxState(full(), 'needs').caffeineFree).toBe(false);
    expect(relaxState(full(), 'budget').budget).toBeNull();
    expect(relaxState(full(), 'extras')).toEqual(full());
  });
  it('touches nothing else', () => {
    const next = relaxState(full(), 'budget');
    expect(next).toEqual({ ...full(), budget: null });
  });
});

describe('step render smoke test', () => {
  const noop = () => {};
  const ref = { current: null };

  it('step 1 renders eight feeling buttons, no Next, and marks the chosen one', () => {
    const html = renderToStaticMarkup(createElement(FeelingStep, { selected: 'cool', headingRef: ref, onPick: noop }));
    expect((html.match(/<button/g) ?? []).length).toBe(8);
    expect(html).not.toContain('Next');
    expect(html).not.toContain('Pick one or two');
    expect(html).not.toContain('HIOC. menu');
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('disabled=""');
  });

  const wants = (s: WizardState, counts: FlavourCounts | null, cart = false) =>
    renderToStaticMarkup(
      createElement(WantsStep, {
        state: s,
        flavourCounts: counts,
        cartHasItems: cart,
        headingRef: ref,
        onChange: noop,
        onBack: noop,
        onSubmit: noop,
      }),
    );

  it('step 2 has no "Either" or "Any" chip and offers Show my picks', () => {
    const html = wants(state(), null);
    expect(html).not.toMatch(/>\s*(Either|Any)\s*</);
    expect(html).not.toContain('Skip whatever you like');
    expect(html).toContain('Show my picks');
    expect(html).toContain('Hot or iced?');
    expect(html).toContain('Smooth &amp; milky coffee');
    expect(html).toContain('More options');
  });

  it('hides drink-only groups without a drink and the flavour group without any family', () => {
    const noDrink = wants(toggleKind(toggleKind(state(), 'food'), 'drink'), COUNTS);
    expect(noDrink).not.toContain('Hot or iced?');
    expect(noDrink).not.toContain('Coffee?');
    expect(noDrink).not.toContain('Any flavour you fancy?');
    expect(wants(state(), COUNTS)).toContain('Any flavour you fancy?');
  });

  it('opens More options by itself and disables strong and smooth with a visible reason', () => {
    const closed = wants(state(), null);
    expect(closed).toContain('aria-expanded="false"');
    const open = wants(toggleCaffeineFree(state()), null);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('Strong and smooth coffee are off while Caffeine-free is on.');
    expect(open).toMatch(/disabled=""[^>]*>Strong coffee|aria-pressed="false" disabled=""[^>]*>Strong coffee/);
  });

  it('greys out chips the facets rule out and says why once, under the heading', () => {
    const onlyHot = [{ kind: 'drink' as const, states: FACET_OPTIONS.map((o) => (o === 'temp:hot' ? 'k' : 'x')).join('') }];
    const html = renderToStaticMarkup(
      createElement(WantsStep, {
        state: state(),
        flavourCounts: null,
        facets: onlyHot,
        cartHasItems: false,
        headingRef: ref,
        onChange: noop,
        onBack: noop,
        onSubmit: noop,
      }),
    );
    expect(html).toMatch(/disabled=""[^>]*>Iced/);
    // Said once for the whole step, not repeated under each group…
    expect(html.split('Greyed-out choices aren’t on the menu with what you’ve picked.')).toHaveLength(2);
    // …and not at all when there is nothing to grey out with (no facets loaded).
    expect(wants(state(), null)).not.toContain('Greyed-out');
    expect(html).not.toMatch(/disabled=""[^>]*>(<span[^>]*>[^<]*<\/span>)?(A drink|Something)/);
  });

  it('lifts the sticky button above the cart bar only when the cart has items', () => {
    expect(wants(state(), null, true)).toContain('3.75rem');
    expect(wants(state(), null, false)).not.toContain('3.75rem');
  });
});
