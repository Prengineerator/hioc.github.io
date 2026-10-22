import { describe, expect, it } from 'vitest';
import { MENU_CACHE_MAX_AGE_MS, parseMenuCache } from '@/lib/pos/menuCache';

// The POS draws the last menu it saw while /api/menu answers. What comes back
// out of storage must be a menu, and a recent one, or nothing.

const items = [{ id: 'a', name: 'Latte', category: 'coffee' }];
const now = 1_800_000_000_000;

describe('parseMenuCache', () => {
  it('returns a recent kept menu', () => {
    const raw = JSON.stringify({ savedAt: now - 60_000, items });
    expect(parseMenuCache(raw, now)).toEqual({ savedAt: now - 60_000, items });
  });

  it('ignores nothing, junk and the wrong shape', () => {
    expect(parseMenuCache(null, now)).toBeNull();
    expect(parseMenuCache('', now)).toBeNull();
    expect(parseMenuCache('{not json', now)).toBeNull();
    expect(parseMenuCache('null', now)).toBeNull();
    expect(parseMenuCache(JSON.stringify({ savedAt: now, items: 'x' }), now)).toBeNull();
    expect(parseMenuCache(JSON.stringify({ savedAt: 'today', items }), now)).toBeNull();
    expect(parseMenuCache(JSON.stringify(items), now)).toBeNull();
  });

  it('refuses a menu older than the limit — better a spinner than old prices', () => {
    const raw = JSON.stringify({ savedAt: now - MENU_CACHE_MAX_AGE_MS - 1, items });
    expect(parseMenuCache(raw, now)).toBeNull();
    const edge = JSON.stringify({ savedAt: now - MENU_CACHE_MAX_AGE_MS, items });
    expect(parseMenuCache(edge, now)).not.toBeNull();
  });

  it('refuses a menu stamped in the future (a wrong clock)', () => {
    expect(parseMenuCache(JSON.stringify({ savedAt: now + 60_000, items }), now)).toBeNull();
  });
});
