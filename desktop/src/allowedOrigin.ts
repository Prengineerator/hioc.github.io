// SHL-2 / PRN-5 — single source of truth for "is this a URL the POS shell
// trusts". Used to gate window navigation (will-navigate/will-redirect/
// setWindowOpenHandler/loadURL), IPC senders (every handler in main.ts checks
// `event.senderFrame.url` through this), the `window.hiocDesktop` bridge gate
// in preload.ts, and system+driver print URLs alike, so the allowlist can
// never drift between call sites.
//
// Phase 7 (owner request: "totally an isolated interface for POS... more
// trusted") narrowed this from "any *.hioc.in subdomain" to the POS surface
// only — the app window must never be able to load the customer site or the
// owner dashboard, even via a redirect or a window.open.
//
// Allowed:
//  - https://staff.hioc.in/** — the staff surface host, wide open (it IS
//    the POS, nothing else lives there).
//  - https://hioc.in — but ONLY the specific paths the POS needs when
//    reached via the main domain (path-based routing, still live alongside
//    the subdomain): /staff/**, /staff-print/**, and /login (staff sign-in,
//    reachable as bare "/login" when the surface-aware links in the app
//    shorten /staff/login on a staff-surface host — see lib/routing/surface.ts
//    `hrefForSurface`). /staff/reset-password (password-email links) and any
//    ?next=/?error= query on the login pages are covered by these prefixes —
//    there is no separate /auth/callback or /auth/confirm route in this app.
//  - http://localhost:3001, but ONLY when the shell itself was launched
//    pointed at a localhost HIOC_POS_URL (i.e. a developer running the app
//    against `next dev`). A packaged build pointed at the real site never
//    allows localhost, even if some page tried to link there.
//
// Explicitly NOT allowed, however it's reached (direct load, redirect, or
// window.open): the customer site (https://hioc.in/, /menu, /account, …),
// https://owner.hioc.in and /owner/** on the main domain, any lookalike host
// (staff.hioc.in.evil.com, evilhioc.in), and non-TLS (http://) production
// hosts. Blocked URLs are handed to the OS's default browser instead — see
// guardExternalNavigation() in main.ts — except non-https schemes
// (file:, javascript:, custom schemes), which are refused outright and never
// passed to shell.openExternal.

const MAIN_HOST = 'hioc.in';
const STAFF_HOST = 'staff.hioc.in';
const DEV_HOST = 'localhost';
const DEV_PORT = '3001';

/** Path prefixes the POS needs when reached via the main domain (hioc.in). */
const MAIN_DOMAIN_ALLOWED_PREFIXES = ['/staff', '/staff-print'];
/** Exact paths (not prefixes) allowed on the main domain. */
const MAIN_DOMAIN_ALLOWED_EXACT = new Set(['/login']);

function isMainDomainPathAllowed(pathname: string): boolean {
  if (MAIN_DOMAIN_ALLOWED_EXACT.has(pathname)) return true;
  return MAIN_DOMAIN_ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export interface PosNavigationOptions {
  /** True only when the shell was launched with HIOC_POS_URL pointed at the
   * localhost dev server — never true against a packaged build's default. */
  devLocalhostAllowed: boolean;
}

/**
 * Pure predicate: is `rawUrl` somewhere the POS app window may load or
 * navigate to? Exported directly (not just via `createOriginAllowlist`) so
 * it's unit-testable without constructing a shell instance.
 */
export function isPosNavigationAllowed(rawUrl: string, opts: PosNavigationOptions): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }

  if (opts.devLocalhostAllowed && u.protocol === 'http:' && u.hostname === DEV_HOST && u.port === DEV_PORT) {
    return true;
  }

  // Everything else requires TLS — including the main/staff hosts below, so a
  // downgraded http://staff.hioc.in link (a stripped redirect, a typo) is
  // refused rather than silently followed.
  if (u.protocol !== 'https:') return false;

  // Exact-match hostnames only (never endsWith(".hioc.in")): that would also
  // match "evilhioc.in"-style lookalikes if a suffix check were ever written
  // without the leading dot, and would still admit owner.hioc.in, which must
  // never be reachable from inside the app window.
  if (u.hostname === STAFF_HOST) return true;
  if (u.hostname === MAIN_HOST) return isMainDomainPathAllowed(u.pathname);

  return false;
}

export type OriginAllowlist = (rawUrl: string) => boolean;

/**
 * Builds the allowlist predicate for a given `HIOC_POS_URL` (the URL the
 * shell was configured to load — `process.env.HIOC_POS_URL` in both the main
 * process and, per Electron, the preload script). Thin wrapper around
 * `isPosNavigationAllowed` that resolves the one piece of config it needs.
 */
export function createOriginAllowlist(hiocPosUrl: string): OriginAllowlist {
  let devLocalhostAllowed = false;
  try {
    devLocalhostAllowed = new URL(hiocPosUrl).hostname === DEV_HOST;
  } catch {
    devLocalhostAllowed = false;
  }

  return (rawUrl: string) => isPosNavigationAllowed(rawUrl, { devLocalhostAllowed });
}
