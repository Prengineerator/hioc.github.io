import { describe, expect, it } from 'vitest';
import { collectSuggestionSessionIds } from '@/lib/cart/suggestionIds';

// SUG-8: cart → order attribution. Pure logic only (the repo's vitest
// environment is node-only), covering the AC in the spec directly:
// "distinct, max 5, omitted when empty".
describe('collectSuggestionSessionIds', () => {
  it('is undefined when no line carries a suggestion session id', () => {
    expect(collectSuggestionSessionIds([])).toBeUndefined();
    expect(
      collectSuggestionSessionIds([{ suggestionSessionId: undefined }, {}]),
    ).toBeUndefined();
  });

  it('returns distinct ids in first-seen order', () => {
    const items = [
      { suggestionSessionId: 'a' },
      { suggestionSessionId: 'b' },
      { suggestionSessionId: 'a' },
      { suggestionSessionId: undefined },
      { suggestionSessionId: 'c' },
    ];
    expect(collectSuggestionSessionIds(items)).toEqual(['a', 'b', 'c']);
  });

  it('caps at the default max (SUGGEST_LIMITS.orderSessionIdsMax = 5)', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ suggestionSessionId: `s${i}` }));
    const result = collectSuggestionSessionIds(items);
    expect(result).toHaveLength(5);
    expect(result).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  it('honours a caller-supplied max', () => {
    const items = [
      { suggestionSessionId: 'a' },
      { suggestionSessionId: 'b' },
      { suggestionSessionId: 'c' },
    ];
    expect(collectSuggestionSessionIds(items, 2)).toEqual(['a', 'b']);
  });

  it('ignores lines with no suggestion session id mixed with ones that have it', () => {
    const items = [
      { suggestionSessionId: undefined },
      { suggestionSessionId: 'x' },
      {},
    ];
    expect(collectSuggestionSessionIds(items)).toEqual(['x']);
  });
});
