'use client';

// Staff shell — state that has to outlive a page change inside /staff/**.
// Mounted once by app/staff/layout.tsx, so switching between Orders, New
// order and Tables no longer resets it.
//
// 1. Order-alert sound, universally on. It used to be a button on the Orders
//    page whose state died with the page: switch to New order and the sound
//    was off again, and no alarm played anywhere but Orders. Now:
//    - the preference is stored per device (on unless turned off);
//    - browsers only allow audio after a user gesture, so the FIRST tap or
//      key press anywhere on a staff page unlocks it — no special button;
//    - the new-order watch runs here, on every staff page.
// 2. Counter mode. It was a full-screen cover over the Orders page that hid
//    the navigation, so the counter couldn't reach New order or Tables. It is
//    now shell state: full screen + screen kept awake on every page, with the
//    header trimmed to Orders / Settle / New order / Tables (StaffHeader).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ORDERS_COALESCE_MS, usePostgresChangesRefresh } from '@/lib/realtime/hooks';
import { isChimeUnlocked, playChime, unlockChime } from '@/lib/staff/chime';
import { COUNTER_MODE_KEY, SOUND_PREF_KEY, nextNewOrderIds, readSoundPref } from '@/lib/staff/newOrderWatch';
import { canEditMenu, canTakeOrders, type StaffSurface } from '@/lib/staff/surfaceRules';
import { usePosRefresh } from '@/lib/staff/posRefresh';
import {
  ensureOrdersFeedLoaded,
  fetchOrdersFeed,
  setOrdersFeedConnection,
  useOrdersFeed,
} from '@/lib/staff/ordersFeed';
import type { UserRole } from '@/lib/types';

const CHIME_INTERVAL_MS = 5000;

export interface StaffShellValue {
  /** The device's preference: alerts should sound. */
  soundOn: boolean;
  /** The browser has actually allowed audio (after the first tap). */
  soundReady: boolean;
  /** Button action: turns sound off, or on (unlocking + a test chime). */
  toggleSound: () => void;
  counterMode: boolean;
  setCounterMode: (on: boolean) => void;
  /** New orders waiting to be accepted, as seen by the shell's watch. */
  newOrderCount: number;
  /** Re-check at once (e.g. right after accepting an order) instead of
   * waiting for the next realtime event, so the alarm stops immediately. */
  refreshNewOrders: () => void;
  /** 'pos' on an enrolled counter device, else 'web' (lib/staff/surfaceRules). */
  surface: StaffSurface;
  /** This screen may take orders (POS, or the staff website when allowed). */
  canTakeOrders: boolean;
  /** This screen may change the menu (POS only). */
  canEditMenu: boolean;
  /**
   * The signed-in staffer's role (the PIN operator's on an enrolled device),
   * from the server; it follows a PIN switch (the layout re-renders on
   * router.refresh). For what to OFFER only — every API route re-checks it.
   */
  role: UserRole | null;
}

const NOOP_SHELL: StaffShellValue = {
  soundOn: false,
  soundReady: false,
  toggleSound: () => {},
  counterMode: false,
  setCounterMode: () => {},
  newOrderCount: 0,
  refreshNewOrders: () => {},
  surface: 'web',
  canTakeOrders: false,
  canEditMenu: false,
  role: null,
};

const StaffShellContext = createContext<StaffShellValue | null>(null);

/** The shell's state; a harmless no-op outside the provider (tests, previews). */
export function useStaffShell(): StaffShellValue {
  return useContext(StaffShellContext) ?? NOOP_SHELL;
}

function readStorage(storage: 'local' | 'session', key: string): string | null {
  try {
    return (storage === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: 'local' | 'session', key: string, value: string | null): void {
  try {
    const s = storage === 'local' ? window.localStorage : window.sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Private mode / blocked storage: the setting just won't persist.
  }
}

type WakeLockSentinel = { release: () => Promise<void> };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinel> } };

export function StaffShell({
  children,
  surface,
  staffWebOrdering,
  role = null,
}: {
  children: React.ReactNode;
  /** Resolved on the server by app/staff/layout.tsx (lib/staff/surface.ts). */
  surface: StaffSurface;
  staffWebOrdering: boolean;
  /** The counter actor's role, resolved on the server by app/staff/layout.tsx. */
  role?: UserRole | null;
}) {
  const [soundOn, setSoundOn] = useState(true);
  const [soundReady, setSoundReady] = useState(false);
  const [counterMode, setCounterModeState] = useState(false);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const previousReceived = useRef<ReadonlySet<string> | null>(null);

  // Restore the device's settings after mount (storage isn't available during
  // server rendering).
  useEffect(() => {
    setSoundOn(readSoundPref(readStorage('local', SOUND_PREF_KEY)));
    setSoundReady(isChimeUnlocked());
    setCounterModeState(readStorage('session', COUNTER_MODE_KEY) === 'on');
  }, []);

  // Unlock audio on the first gesture anywhere, and again whenever the tab
  // comes back into view (some browsers suspend audio in a background tab).
  useEffect(() => {
    if (!soundOn) return;
    const unlock = () => {
      void unlockChime().then((ok) => setSoundReady(ok));
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && isChimeUnlocked()) unlock();
    };
    const events: (keyof DocumentEventMap)[] = ['pointerdown', 'keydown', 'touchstart'];
    for (const e of events) document.addEventListener(e, unlock, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      for (const e of events) document.removeEventListener(e, unlock, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [soundOn]);

  const toggleSound = useCallback(() => {
    if (soundOn && soundReady) {
      setSoundOn(false);
      writeStorage('local', SOUND_PREF_KEY, 'off');
      return;
    }
    setSoundOn(true);
    writeStorage('local', SOUND_PREF_KEY, 'on');
    // This runs inside the click, so it can unlock audio; the test chime
    // confirms to the staffer that alerts will be heard.
    void unlockChime().then((ok) => {
      setSoundReady(ok);
      if (ok) playChime();
    });
  }, [soundOn, soundReady]);

  // New-order watch — every staff page — through the shared orders feed
  // (lib/staff/ordersFeed.ts): ONE realtime channel and ONE fetch per order
  // change for the alarm AND the board on screen (Live orders, Orders,
  // Tables), which used to fetch the same change again on a channel of their
  // own. With no board up, only the waiting orders are fetched.
  // 'run' while hidden: this is the alarm, and it must still ring for an
  // online order when the POS tab is in the background.
  const fetchFeed = useCallback(() => void fetchOrdersFeed(), []);
  const connection = usePostgresChangesRefresh({
    table: 'orders',
    channelName: 'staff-shell-new-orders',
    onChange: fetchFeed,
    requiresSession: true,
    whileHidden: 'run',
    coalesceMs: ORDERS_COALESCE_MS,
  });
  useEffect(() => setOrdersFeedConnection(connection), [connection]);

  useEffect(() => {
    ensureOrdersFeedLoaded();
  }, []);
  usePosRefresh(fetchFeed);

  // A HIOC Ritual sale is never a kitchen order, so it never rings the alarm
  // (the feed's `received` already leaves those out).
  const { received } = useOrdersFeed();
  useEffect(() => {
    if (!received) return;
    setNewIds((current) => nextNewOrderIds(previousReceived.current, received, current));
    previousReceived.current = received;
  }, [received]);

  const newOrderCount = newIds.size;
  const previousCount = useRef(0);
  useEffect(() => {
    const before = previousCount.current;
    previousCount.current = newOrderCount;
    if (newOrderCount <= 0 || !soundOn) return undefined;
    if (newOrderCount > before) playChime();
    const interval = setInterval(playChime, CHIME_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [newOrderCount, soundOn]);

  // Counter mode: full screen (entered from the button's click) and the
  // screen kept awake. A wake lock is dropped whenever the page is hidden,
  // so it is re-requested when the page is visible again.
  const setCounterMode = useCallback((on: boolean) => {
    setCounterModeState(on);
    writeStorage('session', COUNTER_MODE_KEY, on ? 'on' : null);
    try {
      if (on && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
      if (!on && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    } catch {
      // Full screen unsupported (some kiosk shells) — counter mode still works.
    }
  }, []);

  useEffect(() => {
    if (!counterMode) return;
    let lock: WakeLockSentinel | null = null;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      (navigator as WakeLockNavigator).wakeLock
        ?.request('screen')
        .then((l) => {
          lock = l;
        })
        .catch(() => {});
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      document.removeEventListener('visibilitychange', acquire);
      lock?.release().catch(() => {});
    };
  }, [counterMode]);

  const refreshNewOrders = fetchFeed;
  const value = useMemo<StaffShellValue>(
    () => ({
      soundOn,
      soundReady,
      toggleSound,
      counterMode,
      setCounterMode,
      newOrderCount,
      refreshNewOrders,
      surface,
      canTakeOrders: canTakeOrders(surface, staffWebOrdering),
      canEditMenu: canEditMenu(surface),
      role,
    }),
    [soundOn, soundReady, toggleSound, counterMode, setCounterMode, newOrderCount, refreshNewOrders, surface, staffWebOrdering, role],
  );

  return <StaffShellContext.Provider value={value}>{children}</StaffShellContext.Provider>;
}
