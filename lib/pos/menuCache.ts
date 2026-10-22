// The POS menu, kept on this machine.
//
// The New order screen used to start empty and wait for GET /api/menu every
// time it mounted. With the last menu kept in localStorage it draws at once
// and refreshes behind it, and a slow or failed request leaves the counter
// with the last menu it saw rather than an empty grid. The server stays the
// authority: every order is priced and checked there.
//
// The key carries the build, so a deploy that changes the shape of a menu item
// never feeds the new code an old shape; the first mount after a deploy simply
// waits for the network as it always did. Same SSR guard and failure posture as
// recents.ts: storage that throws (private mode, quota) just means no cache.

import type { MenuItem } from '@/lib/types';

const BUILD = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || 'dev';
export const MENU_CACHE_KEY = `hioc.pos.menu.v1.${BUILD}`;
const KEY_PREFIX = 'hioc.pos.menu.';
/** Older than this, a kept menu is not drawn: better a spinner than last week's prices. */
export const MENU_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface CachedMenu {
  savedAt: number;
  items: MenuItem[];
}

/** Pure: a stored value back into a menu, or null if it is missing, malformed or too old. */
export function parseMenuCache(raw: string | null, now: number): CachedMenu | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedMenu> | null;
    if (!parsed || typeof parsed.savedAt !== 'number' || !Array.isArray(parsed.items)) return null;
    if (now - parsed.savedAt > MENU_CACHE_MAX_AGE_MS || parsed.savedAt > now) return null;
    return { savedAt: parsed.savedAt, items: parsed.items };
  } catch {
    return null;
  }
}

export function readMenuCache(now: number = Date.now()): CachedMenu | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseMenuCache(window.localStorage.getItem(MENU_CACHE_KEY), now);
  } catch {
    return null;
  }
}

export function writeMenuCache(items: MenuItem[], now: number = Date.now()): void {
  if (typeof window === 'undefined') return;
  try {
    // Menus kept by earlier builds are dead weight; clear them as we go.
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(KEY_PREFIX) && key !== MENU_CACHE_KEY) window.localStorage.removeItem(key);
    }
    window.localStorage.setItem(MENU_CACHE_KEY, JSON.stringify({ savedAt: now, items } satisfies CachedMenu));
  } catch {
    // Quota or private mode: the screen still works, it just fetches on mount.
  }
}
