'use client';

// "Refresh" on the POS — fetch everything again WITHOUT reloading the page.
//
// A full reload (Ctrl+R, or the old F5 in the desktop app) throws away the
// screen, waits for the sign-in check and the whole app again, and loses the
// order being punched. Most of the time the counter only wants fresh data: the
// menu after an 86, the tables after a seat, the queue after a missed ping.
// One window event does that: every POS screen listens and refetches its own
// data, and the shared store-settings answer is dropped so the next read asks
// the server.

import { useEffect, useRef } from 'react';
import { invalidateSharedJson } from '@/lib/pos/sharedJson';

export const POS_REFRESH_EVENT = 'hioc:pos-refresh';

/** Ask every mounted POS screen to refetch its data. */
export function requestPosRefresh(): void {
  if (typeof window === 'undefined') return;
  invalidateSharedJson();
  window.dispatchEvent(new Event(POS_REFRESH_EVENT));
}

/** Run `onRefresh` whenever a POS refresh is requested (the latest callback, no re-subscribe). */
export function usePosRefresh(onRefresh: () => void): void {
  const latest = useRef(onRefresh);
  latest.current = onRefresh;
  useEffect(() => {
    const handler = () => latest.current();
    window.addEventListener(POS_REFRESH_EVENT, handler);
    return () => window.removeEventListener(POS_REFRESH_EVENT, handler);
  }, []);
}
