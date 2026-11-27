import { describe, expect, it } from 'vitest';
import { sameOpenState, STORE_BADGE_FETCH_MS, STORE_BADGE_TICK_MS, storeBadgeTick } from '@/lib/staff/storeBadge';
import type { StoreOpenState } from '@/lib/store/hours';

// The staff header's store pill asks the server for the settings every few
// minutes and re-reads the clock in between (lib/staff/storeBadge.ts).

const open: StoreOpenState = { isOpen: true, acceptingOrders: true, reason: 'open', nextOpenLabel: null };

describe('storeBadgeTick', () => {
  it('fetches while it has no settings yet (first load failed)', () => {
    expect(storeBadgeTick({ now: 60_000, lastLoad: 0, hasSettings: false })).toBe('fetch');
  });

  it('re-reads the clock on the ticks in between, without a request', () => {
    for (let n = 1; n < STORE_BADGE_FETCH_MS / STORE_BADGE_TICK_MS; n += 1) {
      expect(storeBadgeTick({ now: n * STORE_BADGE_TICK_MS, lastLoad: 0, hasSettings: true })).toBe('recompute');
    }
  });

  it('fetches on the fifth one-minute tick, even if the timer fires a little early', () => {
    expect(storeBadgeTick({ now: STORE_BADGE_FETCH_MS - 20, lastLoad: 0, hasSettings: true })).toBe('fetch');
  });

  it('asks the server at most 12 times an hour, down from 60', () => {
    let lastLoad = 0;
    let fetches = 0;
    for (let now = STORE_BADGE_TICK_MS; now <= 60 * 60_000; now += STORE_BADGE_TICK_MS) {
      if (storeBadgeTick({ now, lastLoad, hasSettings: true }) === 'fetch') {
        fetches += 1;
        lastLoad = now;
      }
    }
    expect(fetches).toBe(12);
  });
});

describe('sameOpenState', () => {
  it('treats an equal state as the same pill, so the header does not re-render', () => {
    expect(sameOpenState(open, { ...open })).toBe(true);
  });

  it('sees a pause, a closing and a missing state as changes', () => {
    expect(sameOpenState(open, { ...open, acceptingOrders: false, reason: 'paused' })).toBe(false);
    expect(sameOpenState(open, { ...open, isOpen: false, reason: 'closed_hours' })).toBe(false);
    expect(sameOpenState(open, null)).toBe(false);
    expect(sameOpenState(null, null)).toBe(true);
  });
});
