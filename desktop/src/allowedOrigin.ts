// SHL-2 / PRN-5 — single source of truth for "is this a URL/origin the shell
// trusts". Used to gate window navigation, IPC senders (every handler in
// main.ts checks `event.senderFrame.url` through this) and system+driver
// print URLs alike, so the allowlist can never drift between call sites.
//
// Allowed:
//  - https://hioc.in and any https://*.hioc.in subdomain, always.
//  - http://localhost:3001, but ONLY when the shell itself was launched
//    pointed at a localhost HIOC_POS_URL (i.e. a developer running the app
//    against `next dev`). A packaged build pointed at the real site never
//    allows localhost, even if some page tried to link there.

const HIOC_SUFFIX = '.hioc.in';
const DEV_HOST = 'localhost';
const DEV_PORT = '3001';

function hostnameIsLocalDev(u: URL): boolean {
  return u.hostname === DEV_HOST;
}

export type OriginAllowlist = (rawUrl: string) => boolean;

/**
 * Builds the allowlist predicate for a given `HIOC_POS_URL` (the URL the
 * shell was configured to load — `process.env.HIOC_POS_URL` in both the main
 * process and, per Electron, the preload script).
 */
export function createOriginAllowlist(hiocPosUrl: string): OriginAllowlist {
  let devLocalhostAllowed = false;
  try {
    devLocalhostAllowed = hostnameIsLocalDev(new URL(hiocPosUrl));
  } catch {
    devLocalhostAllowed = false;
  }

  return function isAllowedOrigin(rawUrl: string): boolean {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return false;
    }

    if (devLocalhostAllowed && u.protocol === 'http:' && u.hostname === DEV_HOST && u.port === DEV_PORT) {
      return true;
    }

    if (u.protocol !== 'https:') return false;
    return u.hostname === 'hioc.in' || u.hostname.endsWith(HIOC_SUFFIX);
  };
}
