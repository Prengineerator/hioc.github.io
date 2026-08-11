// Which surface is this request for — and what should links look like on it?
//
// The three surfaces can be reached two ways:
//   hioc.in/staff/orders   (path-based, how it has always worked)
//   staff.hioc.in/orders   (subdomain)
//
// Both must keep working. DNS propagates slowly, a subdomain can be pointed
// away again, and links already sent to customers and staff must not rot — so
// this is deliberately not a migration with a flag day.
//
// Pure, because the whole scheme rests on classifying a Host header correctly
// and the failure modes are ugly: a mis-detected surface either double-prefixes
// every link or serves the customer site at a staff domain.

export type Surface = 'main' | 'staff' | 'owner';

/** The path prefix a surface lives under when reached via the main domain. */
export const SURFACE_PREFIX: Record<Exclude<Surface, 'main'>, string> = {
  staff: '/staff',
  owner: '/owner',
};

/**
 * Classify a Host header.
 *
 * Matches only the leftmost label, so `staff.hioc.in` is the staff surface
 * while `mystaff.hioc.in` or `hioc.in` are not. The port is stripped for local
 * work (`staff.localhost:3001`).
 */
export function surfaceForHost(host: string | null | undefined): Surface {
  const h = (host ?? '').toLowerCase().split(':')[0];
  const label = h.split('.')[0];
  if (label === 'staff') return 'staff';
  if (label === 'owner') return 'owner';
  return 'main';
}

/**
 * The internal path to render for an incoming subdomain request.
 *
 * `staff.hioc.in/orders` → `/staff/orders`, so every route, layout and auth
 * gate keeps matching on the pathnames it already knows. Nothing downstream
 * needs to learn about subdomains.
 *
 * Returns null when no rewrite applies, so the caller can pass the request
 * through untouched rather than rewriting to an identical path.
 */
export function rewriteForSurface(surface: Surface, pathname: string): string | null {
  if (surface === 'main') return null;
  const prefix = SURFACE_PREFIX[surface];

  // Already prefixed — a link written as /staff/orders and clicked while on
  // staff.hioc.in. Serve it rather than producing /staff/staff/orders.
  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return null;

  // API routes, Next internals and static files are host-agnostic and must
  // never be prefixed: /api/orders is /api/orders on every domain.
  if (isHostAgnostic(pathname)) return null;

  return pathname === '/' ? prefix : `${prefix}${pathname}`;
}

/** Paths that mean the same thing on every host and must never be rewritten. */
export function isHostAgnostic(pathname: string): boolean {
  return (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/images/') ||
    pathname.startsWith('/fonts/') ||
    pathname === '/favicon.ico' ||
    pathname === '/manifest.webmanifest' ||
    /\.[a-z0-9]+$/i.test(pathname) // any file extension
  );
}

/**
 * Rewrite an app-internal href for the surface it is being rendered on.
 *
 * Code keeps writing the canonical `/staff/orders` everywhere — that is the one
 * form that works on both hosts and the one a developer can reason about. This
 * strips the prefix only when the link already points at the surface we are on,
 * so the address bar reads `staff.hioc.in/orders` instead of
 * `staff.hioc.in/staff/orders`.
 *
 * A cross-surface link (staff → owner) keeps its full path and is served by the
 * main domain's routing, which is correct: those are different sites now.
 */
export function hrefForSurface(surface: Surface, href: string): string {
  if (surface === 'main') return href;
  const prefix = SURFACE_PREFIX[surface];
  if (href === prefix) return '/';
  if (href.startsWith(`${prefix}/`)) return href.slice(prefix.length) || '/';
  return href;
}
