// One answer for several staff screens asking the same question at once.
//
// The header, the order board and the counter (via useCounterDefaults) each
// read GET /api/store-settings, and two of them do it in the same moment the
// POS mounts. Every read is a Vercel function call, so for a short while they
// share one: the first caller's request, or its answer if it is recent enough.
//
// Only for reads where a few seconds of staleness is harmless. A screen that
// edits the settings must still read them fresh (fetch directly), and a write
// announces itself with 'hioc:store-changed', which drops the shared answer.

import { fetchWithTimeout } from '@/lib/pos/fetchWithTimeout';

export const STORE_SETTINGS_URL = '/api/store-settings';
/** How long a store-settings answer is shared before the next caller asks again. */
export const STORE_SETTINGS_MAX_AGE_MS = 30_000;
/** The same 'hioc:store-changed' event StoreControls fires after a save. */
export const STORE_CHANGED_EVENT = 'hioc:store-changed';

interface Entry {
  at: number;
  promise: Promise<unknown>;
}

const entries = new Map<string, Entry>();
let listening = false;

function listenForStoreChanges(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(STORE_CHANGED_EVENT, () => entries.delete(STORE_SETTINGS_URL));
}

/**
 * GET `url` as JSON, shared with any other caller within `maxAgeMs`. Resolves
 * null when the request fails or answers non-2xx, and a failed answer is never
 * shared: the next caller asks again.
 */
export function sharedJson<T>(url: string, maxAgeMs: number, now: number = Date.now()): Promise<T | null> {
  listenForStoreChanges();
  const hit = entries.get(url);
  if (hit && now - hit.at < maxAgeMs) return hit.promise as Promise<T | null>;

  // With a timeout: a stalled request would otherwise be shared, unanswered,
  // with every screen that asks in the next 30 s.
  const promise: Promise<T | null> = fetchWithTimeout(url, { cache: 'no-store' })
    .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
    .catch(() => null);
  const entry = { at: now, promise };
  entries.set(url, entry);
  void promise.then((value) => {
    if (value === null && entries.get(url) === entry) entries.delete(url);
  });
  return promise;
}

/** Drop the shared answer for `url` (or every url), so the next caller asks the server. */
export function invalidateSharedJson(url?: string): void {
  if (url === undefined) entries.clear();
  else entries.delete(url);
}
