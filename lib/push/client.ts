// Browser-side helpers for phone notifications. No server imports.

/** The VAPID public key in the form PushManager.subscribe() wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushEnv = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: 'default' | 'granted' | 'denied' | 'unknown';
};

export type PushAvailability = 'ok' | 'ios_install' | 'unsupported' | 'denied';

export function isIos(env: Pick<PushEnv, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  if (/iPhone|iPad|iPod/i.test(env.userAgent)) return true;
  // iPadOS asks for the desktop site and reports as a Mac with a touch screen.
  return env.platform === 'MacIntel' && (env.maxTouchPoints ?? 0) > 1;
}

/**
 * Can this browser take notifications right now? On iOS, Safari delivers push only
 * to a site added to the Home Screen, so an iPhone in a normal tab gets the how-to
 * rather than a button that cannot work.
 */
export function pushAvailability(env: PushEnv): PushAvailability {
  if (isIos(env) && !env.standalone) return 'ios_install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'ok';
}

export function readPushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    standalone: nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'unknown',
  };
}
