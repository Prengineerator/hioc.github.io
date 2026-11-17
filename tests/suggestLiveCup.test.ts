import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// WO-LIVECUP: the live cup (CoffeyMascot `look`, LiveCup badges), the sweetness
// glass, the tiles on step 2, and the pure model pieces behind them
// (cupLook, summaryLine, reactionLine, glass maths). No DOM here, so components
// are server-rendered.

import { CoffeyMascot, type CoffeyLook } from '@/components/coffey/CoffeyMascot';
import { LiveCup } from '@/components/coffey/LiveCup';
import { SweetnessGlass } from '@/components/suggest/SweetnessGlass';
import { WantsStep } from '@/components/suggest/WizardSteps';
import {
  COFFEE_TILE_LABEL,
  DEFAULT_REACTION,
  SUMMARY_EMPTY,
  cupLook,
  glassFraction,
  glassLevel,
  initialState,
  reactionLine,
  setSweetness,
  summaryLine,
  toggleCaffeineFree,
  toggleCoffee,
  toggleFlavour,
  toggleKind,
  toggleSweetness,
  toggleTemperature,
  type WizardState,
} from '@/components/suggest/wizardModel';
import { menuFacets, type FacetOption, type MenuFacet } from '@/lib/suggest/facets';
import { CAPPUCCINO, CAPPUCCINO_TRAITS } from './fixtures/suggestMenu';
import type { FlavourCounts } from '@/lib/suggest/types';

// Markup of the mascot BEFORE the `look` prop existed (captured at HEAD 2f59247).
const MASCOT_64 =
  '<svg viewBox="0 0 120 120" width="64" height="64" focusable="false" aria-hidden="true" class="shrink-0"><g fill="none" stroke-width="3.5" stroke-linecap="round" class="stroke-tan"><path d="M38 29 C33 24 43 20 38 15" class="animate-steam opacity-80" style="animation-delay:-1.6s"></path><path d="M50 27 C44 21 56 16 50 9" class="animate-steam opacity-80" style="animation-delay:0s"></path><path d="M62 29 C57 24 67 20 62 15" class="animate-steam opacity-80" style="animation-delay:-0.8s"></path></g><path d="M79 58 C99 53 105 64 102 74 C99 84 91 88 77 86" fill="none" stroke-width="10" stroke-linecap="round" class="stroke-charcoal"></path><path d="M79 58 C99 53 105 64 102 74 C99 84 91 88 77 86" fill="none" stroke-width="4" stroke-linecap="round" class="stroke-tan-dark"></path><path d="M17 44 C17 78 24 108 42 108 L58 108 C76 108 83 78 83 44 Z" class="fill-cream"></path><clipPath id="coffey-body-R0"><path d="M17 44 C17 78 24 108 42 108 L58 108 C76 108 83 78 83 44 Z"></path></clipPath><g clip-path="url(#coffey-body-R0)"><rect x="10" y="40" width="80" height="72" class="fill-surface"></rect><path d="M17 44 C17 78 24 108 42 108 L58 108 C76 108 83 78 83 44 Z" transform="translate(-4.5 -3)" class="fill-cream"></path></g><path d="M17 44 C17 78 24 108 42 108 L58 108 C76 108 83 78 83 44 Z" fill="none" stroke-width="3" stroke-linejoin="round" class="stroke-charcoal"></path><ellipse cx="50" cy="44" rx="33" ry="9.5" stroke-width="3" class="fill-cream stroke-charcoal"></ellipse><ellipse cx="50" cy="45" rx="27" ry="5.5" class="fill-tan-dark"></ellipse><path d="M36 44 Q41 41.2 47 41.6" fill="none" stroke-width="2" stroke-linecap="round" class="stroke-tan opacity-90"></path><circle cx="31" cy="81" r="5.2" class="fill-tan opacity-40"></circle><circle cx="69" cy="81" r="5.2" class="fill-tan opacity-40"></circle><g><ellipse cx="39.5" cy="70" rx="4.3" ry="5.3" class="fill-charcoal"></ellipse><circle cx="41" cy="68.1" r="1.5" class="fill-cream"></circle><ellipse cx="60.5" cy="70" rx="4.3" ry="5.3" class="fill-charcoal"></ellipse><circle cx="62" cy="68.1" r="1.5" class="fill-cream"></circle><path d="M42.5 81.5 Q50 90 57.5 81.5" fill="none" stroke-width="3.2" stroke-linecap="round" class="stroke-charcoal"></path></g></svg>';
const MASCOT_40_WINK_STILL =
  '<svg viewBox="0 0 120 120" width="40" height="40" focusable="false" aria-hidden="true" class="shrink-0"><g fill="none" stroke-width="3.5" stroke-linecap="round" class="stroke-tan"><path d="M38 29 C33 24 43 20 38 15" class="opacity-80"></path><path d="M50 27 C44 21 56 16 50 9" class="opacity-80"></path><path d="M62 29 C57 24 67 20 62 15" class="opacity-80"></path></g><path d="M79 58 C99 53 105 64 102 74 C99 84 91 88 77 86" fill="none" stroke-width="10" stroke-linecap="round" class="stroke-charcoal"></path><path d="M79 58 C99 53 105 64 102 74 C99 84 91 88 77 86" fill="none" stroke-width="4" stroke-linecap="round" class="stroke-tan-dark"></path><path d="M17 44 C17 78 24 108 42 108 L58 108 C76 108 83 78 83 44 Z" class="fill-cream"></path><clipPath id="coffey-body-R0"><path d="M17 44 C17 78 24 108 42 108 L58 108 C76 108 83 78 83 44 Z"></path></clipPath><g clip-path="url(#coffey-body-R0)"><rect x="10" y="40" width="80" height="72" class="fill-surface"></rect><path d="M17 44 C17 78 24 108 42 108 L58 108 C76 108 83 78 83 44 Z" transform="translate(-4.5 -3)" class="fill-cream"></path></g><path d="M17 44 C17 78 24 108 42 108 L58 108 C76 108 83 78 83 44 Z" fill="none" stroke-width="3" stroke-linejoin="round" class="stroke-charcoal"></path><ellipse cx="50" cy="44" rx="33" ry="9.5" stroke-width="3" class="fill-cream stroke-charcoal"></ellipse><ellipse cx="50" cy="45" rx="27" ry="5.5" class="fill-tan-dark"></ellipse><path d="M36 44 Q41 41.2 47 41.6" fill="none" stroke-width="2" stroke-linecap="round" class="stroke-tan opacity-90"></path><circle cx="31" cy="81" r="5.2" class="fill-tan opacity-40"></circle><circle cx="69" cy="81" r="5.2" class="fill-tan opacity-40"></circle><g><ellipse cx="39.5" cy="70" rx="4.3" ry="5.3" class="fill-charcoal"></ellipse><circle cx="41" cy="68.1" r="1.5" class="fill-cream"></circle><path d="M55.5 71 Q60.5 64.5 65.5 71" fill="none" stroke-width="3.2" stroke-linecap="round" class="stroke-charcoal"></path><path d="M42.5 81.5 Q50 90 57.5 81.5" fill="none" stroke-width="3.2" stroke-linecap="round" class="stroke-charcoal"></path></g></svg>';

const COUNTS: FlavourCounts = {
  drink: { chocolatey: 5, fruity: 3 },
  dessert: { chocolatey: 4, biscuit: 3 },
  food: {},
};
const state = (over: Partial<WizardState> = {}): WizardState => ({ ...initialState(), mood: 'boost', ...over });
const mascot = (look?: CoffeyLook) => renderToStaticMarkup(createElement(CoffeyMascot, { size: 64, look }));
const count = (html: string, part: string) => (html.match(new RegExp(`data-part="${part}"`, 'g')) ?? []).length;

describe('CoffeyMascot', () => {
  it('without a look renders exactly as before', () => {
    expect(renderToStaticMarkup(createElement(CoffeyMascot, { size: 64 }))).toBe(MASCOT_64);
    expect(renderToStaticMarkup(createElement(CoffeyMascot, { size: 40, expression: 'wink', animated: false }))).toBe(
      MASCOT_40_WINK_STILL,
    );
    expect(mascot()).not.toContain('data-part');
  });

  it('colours the liquid by coffee choice', () => {
    expect(mascot({ coffee: 'strong' })).toContain('fill-charcoal transition-colors');
    const smooth = mascot({ coffee: 'smooth' });
    expect(smooth).toContain('fill-tan transition-colors');
    expect(count(smooth, 'swirl')).toBe(1);
    const none = mascot({ coffee: 'none' });
    expect(none).toContain('fill-surface stroke-tan-dark');
    expect(count(none, 'swirl')).toBe(0);
    expect(mascot({ coffee: null })).toContain('fill-tan-dark transition-colors');
    expect(count(mascot({ coffee: 'strong' }), 'swirl')).toBe(0);
  });

  it('iced drops the steam and adds two ice cubes and a straw; hot keeps the steam', () => {
    const iced = mascot({ temperature: 'iced' });
    expect(count(iced, 'ice-cube')).toBe(2);
    expect(count(iced, 'straw')).toBe(1);
    expect(iced).not.toContain('animate-steam');
    for (const look of [{ temperature: 'hot' as const }, { temperature: null }, {}]) {
      const html = mascot(look);
      expect(html).toContain('animate-steam');
      expect(count(html, 'ice-cube')).toBe(0);
      expect(count(html, 'straw')).toBe(0);
    }
  });

  it('draws no, one or two sugar cubes for the sweetness levels', () => {
    expect(count(mascot({ sweetness: null }), 'sugar-cube')).toBe(0);
    expect(count(mascot({ sweetness: 'none' }), 'sugar-cube')).toBe(0);
    expect(count(mascot({ sweetness: 'light' }), 'sugar-cube')).toBe(1);
    expect(count(mascot({ sweetness: 'sweet' }), 'sugar-cube')).toBe(2);
  });

  it('uses palette utility classes only (no hex colours)', () => {
    expect(mascot({ temperature: 'iced', coffee: 'smooth', sweetness: 'sweet' })).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});

describe('LiveCup badges', () => {
  const cup = (size: number, look: CoffeyLook) => renderToStaticMarkup(createElement(LiveCup, { size, look }));
  it('shows up to two flavour emoji and the bite badge on a big cup', () => {
    const html = cup(104, { flavours: ['chocolatey', 'fruity', 'nutty'], bite: 'dessert' });
    expect(html).toContain('🍫');
    expect(html).toContain('🍓');
    expect(html).not.toContain('🌰');
    expect(html).toContain('🧇');
    expect(cup(104, { bite: 'food' })).toContain('🥪');
  });
  it('shows no badges below 72px, and is aria-hidden', () => {
    const html = cup(44, { flavours: ['chocolatey'], bite: 'dessert' });
    expect(html).not.toContain('🍫');
    expect(html).not.toContain('🧇');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('cupLook', () => {
  it('maps the state and ignores hidden drink-only groups', () => {
    let s = toggleTemperature(state(), 'iced');
    s = toggleCoffee(s, 'strong');
    s = toggleSweetness(s, 'light');
    s = toggleFlavour(s, 'chocolatey');
    s = toggleKind(s, 'dessert');
    expect(cupLook(s, COUNTS)).toEqual({
      temperature: 'iced',
      coffee: 'strong',
      sweetness: 'light',
      flavours: ['chocolatey'],
      bite: 'dessert',
    });
    s = toggleKind(s, 'drink');
    const look = cupLook(s, COUNTS);
    expect(look.temperature).toBeNull();
    expect(look.coffee).toBeNull();
    expect(cupLook(toggleKind(toggleKind(state(), 'dessert'), 'food'), null).bite).toBe('both');
    expect(cupLook(state(), null).bite).toBeNull();
  });
  it('limits flavours to the ones still offered', () => {
    const s = toggleFlavour(toggleKind(toggleKind(state(), 'food'), 'drink'), 'fruity');
    expect(cupLook(s, COUNTS).flavours).toEqual([]);
  });
});

describe('summaryLine', () => {
  it('lists what is chosen in chip words, without the feeling', () => {
    let s = toggleTemperature(state(), 'iced');
    s = toggleCoffee(s, 'strong');
    s = toggleSweetness(s, 'none');
    expect(summaryLine(s, null)).toBe('Iced · Strong coffee · Not sweet');
  });
  it('invites a tap when nothing is chosen', () => {
    expect(summaryLine(state(), null)).toBe(SUMMARY_EMPTY);
    expect(summaryLine(state({ mood: null }), null)).toBe(SUMMARY_EMPTY);
  });
});

describe('reactionLine', () => {
  const set = (fn: (s: WizardState) => WizardState) => reactionLine(state(), fn(state()), COUNTS);
  it('has a line for each thing that can be set', () => {
    expect(set((s) => toggleTemperature(s, 'hot'))).toBe('Hot and steamy.');
    expect(set((s) => toggleTemperature(s, 'iced'))).toBe('Iced it is.');
    expect(set((s) => toggleCoffee(s, 'strong'))).toBe('Bold. I like it.');
    expect(set((s) => toggleCoffee(s, 'smooth'))).toBe('Smooth and milky.');
    expect(set((s) => toggleCoffee(s, 'none'))).toBe('No coffee, no problem.');
    expect(set((s) => toggleSweetness(s, 'none'))).toBe('Not sweet at all.');
    expect(set((s) => toggleSweetness(s, 'light'))).toBe('Just a touch of sweet.');
    expect(set((s) => toggleSweetness(s, 'sweet'))).toBe('Sweet tooth, noted.');
    expect(set((s) => toggleFlavour(s, 'chocolatey'))).toBe('Chocolatey. Good call.');
    expect(set((s) => toggleCaffeineFree(s))).toBe('Caffeine-free it is.');
  });
  it('goes back to the default when a choice is cleared', () => {
    const iced = toggleTemperature(state(), 'iced');
    expect(reactionLine(iced, toggleTemperature(iced, 'iced'), COUNTS)).toBe(DEFAULT_REACTION);
    const cf = toggleCaffeineFree(state());
    expect(reactionLine(cf, toggleCaffeineFree(cf), COUNTS)).toBe(DEFAULT_REACTION);
  });
  it('says caffeine-free (not the cleared coffee) when that clears the coffee too', () => {
    const strong = toggleCoffee(state(), 'strong');
    expect(reactionLine(strong, toggleCaffeineFree(strong), COUNTS)).toBe('Caffeine-free it is.');
  });
  it('is null when nothing the cup shows changed', () => {
    expect(reactionLine(state(), { ...state(), note: 'hello' }, COUNTS)).toBeNull();
    expect(reactionLine(state(), toggleKind(state(), 'dessert'), COUNTS)).toBeNull();
  });
});

describe('glass maths', () => {
  it('reads the fraction up the glass and clamps outside it', () => {
    expect(glassFraction(200, 100, 100)).toBe(0);
    expect(glassFraction(100, 100, 100)).toBe(1);
    expect(glassFraction(150, 100, 100)).toBe(0.5);
    expect(glassFraction(500, 100, 100)).toBe(0);
    expect(glassFraction(-50, 100, 100)).toBe(1);
    expect(glassFraction(10, 0, 0)).toBe(0);
  });
  it('maps thirds to levels', () => {
    expect(glassLevel(0)).toBe('none');
    expect(glassLevel(0.32)).toBe('none');
    expect(glassLevel(0.5)).toBe('light');
    expect(glassLevel(0.7)).toBe('sweet');
    expect(glassLevel(1)).toBe('sweet');
  });
  it('keeps the last allowed level when the one under the pointer is disabled', () => {
    const off = new Set(['sweet:sweet' as const]);
    expect(glassLevel(0.9, off, 'light')).toBe('light');
    expect(glassLevel(0.9, off, null)).toBeNull();
    expect(glassLevel(0.5, off, 'light')).toBe('light');
    expect(glassLevel(0.1, new Set(['sweet:none' as const]), 'light')).toBe('light');
  });
  it('setSweetness sets and never clears', () => {
    const s = setSweetness(state(), 'light');
    expect(s.sweetness).toBe('light');
    expect(setSweetness(s, 'light')).toBe(s);
  });
});

describe('SweetnessGlass', () => {
  const glass = (value: 'none' | 'light' | 'sweet' | null) =>
    renderToStaticMarkup(createElement(SweetnessGlass, { value, off: new Set<FacetOption>(), onChange: () => {} }));
  it('is aria-hidden, captures touch on the glass only, and invites a drag when empty', () => {
    const html = glass(null);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('touch-action:none');
    expect((html.match(/touch-action/g) ?? []).length).toBe(1);
    expect(html).toContain('Drag to fill');
    expect(count(html, 'fill-line')).toBe(1);
    expect(count(html, 'glass-cube')).toBe(0);
  });
  it('fills with one, two or three cubes and loses the hint', () => {
    for (const [level, cubes] of [
      ['none', 1],
      ['light', 2],
      ['sweet', 3],
    ] as const) {
      const html = glass(level);
      expect(count(html, 'glass-cube')).toBe(cubes);
      expect(html).not.toContain('Drag to fill');
      expect(count(html, 'fill-line')).toBe(0);
    }
    expect(glass('sweet')).toContain('translateY(18px)');
  });
});

describe('step 2 tiles', () => {
  const noop = () => {};
  const ref = { current: null };
  const wants = (s: WizardState, facets: MenuFacet[] | null = null) =>
    renderToStaticMarkup(
      createElement(WantsStep, {
        state: s,
        flavourCounts: null,
        facets,
        cartHasItems: false,
        headingRef: ref,
        onChange: noop,
        onBack: noop,
        onSubmit: noop,
      }),
    );

  it('renders the kind, temperature and coffee tiles, the glass and the sticky summary', () => {
    const html = wants(state());
    for (const label of ['A drink', 'A sweet bite', 'A savoury bite', 'Hot', 'Iced']) {
      expect(html).toContain(`>${label}</span></button>`);
    }
    for (const label of Object.values(COFFEE_TILE_LABEL)) {
      expect(html.replace(/&amp;/g, '&')).toContain(`>${label}</span></button>`);
    }
    expect(html).toContain('grid-cols-3');
    expect(html).toContain('grid-cols-2');
    expect(count(html, 'glass')).toBe(1);
    expect(html).toContain('data-part="summary"');
    expect(html).toContain(SUMMARY_EMPTY);
    expect(html).toContain('What sounds good right now?');
    expect(html).not.toContain('aria-live');
    expect(html).not.toMatch(/>\s*(Either|Any)\s*</);
  });

  it('lists the sweetness chips Sweet first, and the summary follows the choices', () => {
    const html = wants(toggleCoffee(toggleTemperature(state(), 'iced'), 'strong'));
    expect(html.indexOf('>Sweet<')).toBeLessThan(html.indexOf('>Lightly sweet<'));
    expect(html.indexOf('>Lightly sweet<')).toBeLessThan(html.indexOf('>Not sweet<'));
    expect(html).toContain('Iced · Strong coffee');
  });

  it('greys a facet-disabled tile', () => {
    const hotOnly = menuFacets([CAPPUCCINO], new Map([[CAPPUCCINO.id, CAPPUCCINO_TRAITS]]));
    const html = wants(state(), hotOnly);
    const iced = html.match(/<button(?:(?!<button)[\s\S])*?>Iced<\/span><\/button>/);
    expect(iced?.[0]).toContain('disabled=""');
    const hot = html.match(/<button(?:(?!<button)[\s\S])*?>Hot<\/span><\/button>/);
    expect(hot?.[0]).not.toContain('disabled=""');
  });
});
