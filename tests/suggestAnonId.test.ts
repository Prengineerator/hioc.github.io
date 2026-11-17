import { afterEach, describe, expect, it, vi } from 'vitest';

// The Coffey guest id, browser side (components/suggest/api.ts getAnonId): one
// id per browser while storage works, and one id per page when it does not. A
// request for picks and its "Show me something different" must carry the same
// id, or /api/suggest answers 404 for a signed-out customer. The browser globals
// are stubbed by hand.

const KEY = 'hioc.suggest.anon';

function storage() {
  const m = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      writes.push(v);
      m.set(k, v);
    },
  };
}

async function freshModule() {
  vi.resetModules();
  return import('@/components/suggest/api');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the guest id while storage works', () => {
  it('is created once, kept in storage, and returned on every call', async () => {
    const local = storage();
    vi.stubGlobal('window', { localStorage: local });
    const api = await freshModule();

    const first = api.getAnonId();
    expect(first).toBeTruthy();
    expect(api.getAnonId()).toBe(first);
    expect(api.getAnonId()).toBe(first);
    expect(local.getItem(KEY)).toBe(first);
    expect(local.writes).toEqual([first]);
  });

  it('is read from storage each time, never from memory', async () => {
    const local = storage();
    local.setItem(KEY, 'stored-before-this-page');
    vi.stubGlobal('window', { localStorage: local });
    const api = await freshModule();
    expect(api.getAnonId()).toBe('stored-before-this-page');

    // Another tab wrote a different id: this page follows storage.
    local.setItem(KEY, 'written-by-another-tab');
    expect(api.getAnonId()).toBe('written-by-another-tab');
    expect(local.writes).toEqual(['stored-before-this-page', 'written-by-another-tab']);
  });
});

describe('the guest id while storage is unavailable', () => {
  it('stays the same for the page when reaching localStorage throws', async () => {
    vi.stubGlobal('window', {
      get localStorage(): never {
        throw new Error('storage is blocked');
      },
    });
    const api = await freshModule();

    const first = api.getAnonId();
    expect(first).toBeTruthy();
    expect(api.getAnonId()).toBe(first);
    expect(api.getAnonId()).toBe(first);
  });

  it('stays the same for the page when there is no localStorage at all', async () => {
    vi.stubGlobal('window', { localStorage: null });
    const api = await freshModule();

    const first = api.getAnonId();
    expect(api.getAnonId()).toBe(first);
  });

  it('stays the same for the page when reading works but writing throws', async () => {
    const attempts: string[] = [];
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: (_k: string, v: string) => {
          attempts.push(v);
          throw new Error('quota exceeded');
        },
      },
    });
    const api = await freshModule();

    const first = api.getAnonId();
    expect(first).toBeTruthy();
    expect(api.getAnonId()).toBe(first);
    expect(api.getAnonId()).toBe(first);
    // The id handed out is the one it tried to store, each time.
    expect(attempts).toEqual([first, first, first]);
  });

  it('stores the id already handed out once writing starts to work', async () => {
    const local = storage();
    let blocked = true;
    vi.stubGlobal('window', {
      localStorage: {
        getItem: local.getItem,
        setItem: (k: string, v: string) => {
          if (blocked) throw new Error('quota exceeded');
          local.setItem(k, v);
        },
      },
    });
    const api = await freshModule();

    const first = api.getAnonId();
    blocked = false;
    expect(api.getAnonId()).toBe(first);
    expect(local.getItem(KEY)).toBe(first);
  });

  it('is a new id on the next page', async () => {
    vi.stubGlobal('window', { localStorage: null });
    const first = (await freshModule()).getAnonId();
    const second = (await freshModule()).getAnonId();
    expect(second).not.toBe(first);
  });
});

describe('the guest id on the server (no window)', () => {
  it('is not remembered, so no two calls and no two visitors share one', async () => {
    expect(typeof window).toBe('undefined');
    const api = await freshModule();

    const a = api.getAnonId();
    const b = api.getAnonId();
    expect(a).toBeTruthy();
    expect(b).not.toBe(a);

    // Nothing was kept from those calls: a browser with storage blocked, on the
    // same module, gets an id of its own.
    vi.stubGlobal('window', { localStorage: null });
    const c = api.getAnonId();
    expect([a, b]).not.toContain(c);
    expect(api.getAnonId()).toBe(c);
  });
});
