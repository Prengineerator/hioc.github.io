import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The header, the board and the counter share one GET /api/store-settings
// for a short while instead of each asking the server.

const win = new EventTarget();
vi.stubGlobal('window', win);

const { invalidateSharedJson, sharedJson, STORE_CHANGED_EVENT, STORE_SETTINGS_URL } = await import(
  '@/lib/pos/sharedJson'
);

const fetchMock = vi.fn();

beforeEach(() => {
  invalidateSharedJson();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ settings: { n: fetchMock.mock.calls.length } }) }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', win);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sharedJson', () => {
  it('gives callers in the same moment one request', async () => {
    const [a, b, c] = await Promise.all([
      sharedJson(STORE_SETTINGS_URL, 30_000, 1_000),
      sharedJson(STORE_SETTINGS_URL, 30_000, 1_001),
      sharedJson(STORE_SETTINGS_URL, 30_000, 1_002),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('asks again once the answer is older than maxAge', async () => {
    await sharedJson(STORE_SETTINGS_URL, 30_000, 1_000);
    await sharedJson(STORE_SETTINGS_URL, 30_000, 30_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await sharedJson(STORE_SETTINGS_URL, 30_000, 31_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps answers per url', async () => {
    await sharedJson('/api/store-settings', 30_000, 1_000);
    await sharedJson('/api/device/context', 30_000, 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never shares a failure', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({}) }));
    expect(await sharedJson(STORE_SETTINGS_URL, 30_000, 1_000)).toBeNull();
    expect(await sharedJson(STORE_SETTINGS_URL, 30_000, 1_001)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    invalidateSharedJson();
    expect(await sharedJson(STORE_SETTINGS_URL, 30_000, 2_000)).toBeNull();
    expect(await sharedJson(STORE_SETTINGS_URL, 30_000, 2_001)).not.toBeNull();
  });

  it("drops the store answer on 'hioc:store-changed'", async () => {
    await sharedJson(STORE_SETTINGS_URL, 30_000, 1_000);
    win.dispatchEvent(new Event(STORE_CHANGED_EVENT));
    await sharedJson(STORE_SETTINGS_URL, 30_000, 1_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates one url or all', async () => {
    await sharedJson('/a', 30_000, 1_000);
    await sharedJson('/b', 30_000, 1_000);
    invalidateSharedJson('/a');
    await sharedJson('/a', 30_000, 1_001);
    await sharedJson('/b', 30_000, 1_001);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    invalidateSharedJson();
    await sharedJson('/b', 30_000, 1_002);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
