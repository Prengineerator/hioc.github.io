'use client';

// "I tapped it, and it heard me." A staff screen change waits on the server
// (the sign-in check, then the page), and with nothing on screen in the
// meantime a tap read as ignored, so people tapped again and again and the POS
// looked hung. The header shows a progress bar and marks the tab from the
// moment of the tap until the new screen is there.
//
// A tiny external store so the header links, the keyboard shortcuts and any
// router.push() can all report the same thing.

import { useSyncExternalStore } from 'react';

/** If a navigation never lands (offline, a redirect), stop claiming it's coming. */
const PENDING_MAX_MS = 15_000;

let pendingHref: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** A navigation to `href` (canonical, e.g. '/staff/tables') has started. */
export function startNavigation(href: string): void {
  pendingHref = href;
  if (timer) clearTimeout(timer);
  timer = setTimeout(finishNavigation, PENDING_MAX_MS);
  emit();
}

/** The new screen is up (or the navigation was abandoned). */
export function finishNavigation(): void {
  if (pendingHref === null) return;
  pendingHref = null;
  if (timer) clearTimeout(timer);
  timer = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The canonical href being navigated to, or null when nothing is pending. */
export function usePendingNavigation(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => pendingHref,
    () => null,
  );
}
