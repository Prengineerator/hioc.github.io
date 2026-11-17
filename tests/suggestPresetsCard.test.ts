import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PresetsCard } from '@/components/owner/suggestions/OverviewWidgets';
import type { SuggestionStats } from '@/lib/suggest/types';

const render = (presets?: { shown: number; removed: number; kept: number }) =>
  renderToStaticMarkup(createElement(PresetsCard, { stats: { presets } as unknown as SuggestionStats }));

const EMPTY = 'No picks with a preselected add-on in this period yet.';
const NOTE = 'Each pick counts once.';

describe('PresetsCard', () => {
  it('shows the empty text, with the SQL pointer, and no throw when stats has no presets', () => {
    const html = render(undefined);
    expect(html).toContain(EMPTY);
    expect(html).toContain('2026-11-coffey-preset-events.sql');
    expect(html).not.toContain(NOTE);
  });

  it('shows the empty text when all three numbers are 0', () => {
    const html = render({ shown: 0, removed: 0, kept: 0 });
    expect(html).toContain(EMPTY);
    expect(html).not.toContain(NOTE);
  });

  it('shows the tiles with no percentage when shown is 0 but removed is above 0', () => {
    const html = render({ shown: 0, removed: 2, kept: 0 });
    expect(html).not.toContain(EMPTY);
    expect(html).toContain('Customer removed it');
    expect(html).not.toContain('%');
    expect(html).toContain(NOTE);
  });

  it('shows the shares of picks sent', () => {
    const html = render({ shown: 4, removed: 1, kept: 2 });
    expect(html).toContain('25%');
    expect(html).toContain('50%');
    expect(html).toContain(NOTE);
    expect(html).toContain('un-ticked and never added');
    expect(html).not.toContain(EMPTY);
  });
});
