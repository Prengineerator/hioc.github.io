import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FULL_LIST_FRESH_MS, feedUrl, isFullListFresh, receivedKitchenIds } from '@/lib/staff/ordersFeedRules';

// The shared orders feed: one fetch per order change for the alarm and every
// board, instead of one each. Today's whole list only while a board needs it.

describe('ordersFeedRules', () => {
  it('asks for the whole day only while a board is up', () => {
    expect(feedUrl(true)).toBe('/api/orders');
    expect(feedUrl(false)).toBe('/api/orders?status=received');
  });

  it('a list fetched moments ago is shown without fetching again', () => {
    const t = 1_800_000_000_000;
    expect(isFullListFresh(0, t)).toBe(false); // never fetched
    expect(isFullListFresh(t - 1000, t)).toBe(true);
    expect(isFullListFresh(t - FULL_LIST_FRESH_MS, t)).toBe(false);
    expect(isFullListFresh(t + 5000, t)).toBe(false); // a wrong clock
  });

  it('reads the waiting orders out of either kind of list', () => {
    const ids = receivedKitchenIds([
      { id: 'a', status: 'received' },
      { id: 'b', status: 'preparing' },
      { id: 'c', status: 'received' },
    ]);
    expect([...ids]).toEqual(['a', 'c']);
  });
});

describe('fetchOrdersFeed', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  const answer = (orders: unknown[]) => ({ ok: true, json: async () => ({ orders }) });

  it('with no board up, asks only for the waiting orders, and a Ritual sale never rings', async () => {
    fetchMock.mockResolvedValue(
      answer([
        { id: 'o1', status: 'received', order_kind: 'menu' },
        { id: 'p1', status: 'received', order_kind: 'coffee_pass' },
      ]),
    );
    const feed = await import('@/lib/staff/ordersFeed');
    await feed.fetchOrdersFeed();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/orders?status=received');
    // No board: the whole-day list is untouched (nothing downloaded for it).
    const { received, orders } = feed.getOrdersFeedState();
    expect([...(received ?? [])]).toEqual(['o1']);
    expect(orders).toBeNull();
  });

  it('keeps the last good data and says so when a fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(answer([{ id: 'o1', status: 'received' }]));
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const feed = await import('@/lib/staff/ordersFeed');
    await feed.fetchOrdersFeed();
    await feed.fetchOrdersFeed();
    const s = feed.getOrdersFeedState();
    expect(s.failed).toBe(true);
    expect([...(s.received ?? [])]).toEqual(['o1']);
  });

  it('an older answer landing late never overwrites a newer one', async () => {
    let releaseSlow: (v: unknown) => void = () => {};
    fetchMock
      .mockImplementationOnce(() => new Promise((r) => (releaseSlow = r)))
      .mockResolvedValueOnce(answer([{ id: 'new', status: 'received' }]));
    const feed = await import('@/lib/staff/ordersFeed');
    const slow = feed.fetchOrdersFeed();
    await feed.fetchOrdersFeed();
    releaseSlow(answer([{ id: 'old', status: 'received' }]));
    await slow;
    expect([...(feed.getOrdersFeedState().received ?? [])]).toEqual(['new']);
  });

  it('ensureOrdersFeedLoaded never starts a second first-fetch', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // stays in flight
    const feed = await import('@/lib/staff/ordersFeed');
    void feed.fetchOrdersFeed();
    feed.ensureOrdersFeedLoaded();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
