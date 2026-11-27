// Which page a notification may open. Pure, so it is tested (tests/webPush.test.ts)
// and mirrored line for line in public/sw.js, which cannot import modules; the
// test runs both against the same cases.
//
// The rule in both: RESOLVE the value against our origin first, and judge what it
// resolved to, never the text that was typed. A raw check alone is fooled by
// '/.//evil.com', '/a/..//evil.com' or a tab inside the value, all of which
// resolve to a path starting '//' (which a browser reads as another site).

export const PUSH_URL_MAX = 300;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A resolved path is only safe if it cannot be read as a scheme-relative URL. */
function resolvedPathIsSafe(path: string, origin: string): boolean {
  if (path.startsWith('//') || path.startsWith('/\\')) return false;
  if (path.includes('\\') || CONTROL.test(path)) return false;
  try {
    // Re-resolve what we are about to hand out: it must still be ours.
    return new URL(path, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/**
 * The same-origin path a tap should open, or '/' for anything else.
 *
 * Only a path on OUR origin is ever opened: a push payload is data from a
 * server, and a notification that opens another site would be a phishing tool.
 * An absolute URL on our own origin is accepted and reduced to its path.
 */
export function safeOpenPath(raw: unknown, origin: string): string {
  if (typeof raw !== 'string') return '/';
  const value = raw.trim();
  if (value === '' || value.length > PUSH_URL_MAX) return '/';
  if (value.includes('\\') || CONTROL.test(value)) return '/';
  try {
    const url = new URL(value, origin);
    if (url.origin !== new URL(origin).origin) return '/';
    const path = url.pathname + url.search + url.hash;
    return resolvedPathIsSafe(path, origin) ? path : '/';
  } catch {
    return '/';
  }
}

/** Areas that are not the customer site; a customer notification never opens them. */
const NON_CUSTOMER = ['staff', 'owner', 'api', 'staff-print'];
const OWN_ORIGIN = 'https://hioc.in';

/**
 * The owner's "opens" choice, as the path to STORE: '/menu', '/shop' or another
 * customer page on hioc.in. Returns the RESOLVED path, or null when it is not a
 * plain customer page (other site, '.'/'..' segments, backslashes, control
 * characters, /staff, /owner, /api, /staff-print and their sub-paths).
 */
export function normalizeOwnerPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value === '' || value.length > PUSH_URL_MAX) return null;
  const abs = /^https?:\/\/(?:www\.)?hioc\.in(?=[/?#]|$)(.*)$/i.exec(value);
  if (abs) value = abs[1] === '' ? '/' : abs[1];
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\') || CONTROL.test(value) || /\s/.test(value)) return null;

  // No dot segments, plain or percent-encoded (%2e is a dot to a URL parser).
  const pathOnly = value.split(/[?#]/, 1)[0];
  for (const seg of pathOnly.split('/')) {
    if (/^(\.|%2e){1,2}$/i.test(seg)) return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(value, OWN_ORIGIN);
  } catch {
    return null;
  }
  if (resolved.origin !== OWN_ORIGIN) return null;
  const path = resolved.pathname + resolved.search + resolved.hash;
  if (path.length > PUSH_URL_MAX || !resolvedPathIsSafe(path, OWN_ORIGIN)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(resolved.pathname);
  } catch {
    return null;
  }
  const first = decoded.split('/')[1]?.toLowerCase() ?? '';
  if (NON_CUSTOMER.includes(first)) return null;
  return path;
}
