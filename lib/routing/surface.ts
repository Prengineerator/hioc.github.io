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

/** The printed ticket page: outside /staff in the app tree, staff surface all the same. */
const STAFF_PRINT_ROOT = '/staff-print';

const DEFAULT_ORIGIN: Record<Surface, string> = {
  main: 'https://hioc.in',
  staff: 'https://staff.hioc.in',
  owner: 'https://owner.hioc.in',
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
  if (isUnder(pathname, prefix)) return null;

  // The printed ticket page lives outside app/staff/** (see its own comment)
  // but belongs to the POS. The desktop shell prints
  // staff.hioc.in/staff-print/<id>/<type>, which used to become
  // /staff/staff-print/... and print a 404 page.
  if (surface === 'staff' && isUnder(pathname, STAFF_PRINT_ROOT)) return null;

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
    // The POS's web app manifest (DEV-1). Named explicitly even though the
    // extension rule below already covers it: an installed app resolves
    // start_url and icons against the manifest's own URL, so a rewrite here
    // would silently change what the installed POS opens.
    pathname === '/pos.webmanifest' ||
    /\.[a-z0-9]+$/i.test(pathname) // any file extension
  );
}

/**
 * Which surface a canonical path belongs to, or null for a host-agnostic path
 * (API routes, Next internals, static files), which belongs to none.
 */
export function surfaceOfPath(pathname: string): Surface | null {
  if (isHostAgnostic(pathname)) return null;
  if (isUnder(pathname, SURFACE_PREFIX.staff) || isUnder(pathname, STAFF_PRINT_ROOT)) {
    return 'staff';
  }
  if (isUnder(pathname, SURFACE_PREFIX.owner)) return 'owner';
  return 'main';
}

/**
 * The public origin of a surface, without a trailing slash.
 *
 * Each variable is read by its literal name because Next inlines a
 * NEXT_PUBLIC_ value into client bundles only where the code spells it out.
 * The overrides exist for running the subdomains locally; production uses the
 * defaults.
 */
export function surfaceOrigin(surface: Surface): string {
  const raw =
    surface === 'staff'
      ? process.env.NEXT_PUBLIC_STAFF_ORIGIN
      : surface === 'owner'
        ? process.env.NEXT_PUBLIC_OWNER_ORIGIN
        : process.env.NEXT_PUBLIC_MAIN_ORIGIN;
  return (raw || DEFAULT_ORIGIN[surface]).replace(/\/+$/, '');
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
 * A cross-surface link becomes an absolute URL on the other surface's host. A
 * relative one resolves on the CURRENT host, where middleware prefixes it with
 * this surface: owner.hioc.in/staff opened the owner Team page (/owner/staff)
 * and owner.hioc.in/staff/login was a 404. On the main domain every surface is
 * reachable by path, so links there are left alone.
 */
export function hrefForSurface(surface: Surface, href: string): string {
  if (surface === 'main') return href;
  // Only app-absolute paths are ours: '#top', '?tab=x', 'https://…' and the
  // protocol-relative '//host' pass through untouched.
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const target = surfaceOfPath(href.split(/[?#]/, 1)[0]);
  if (target === null) return href;
  if (target === surface) return stripPrefix(surface, href);
  const local = target === 'main' ? href : stripPrefix(target, href);
  return `${surfaceOrigin(target)}${local}`;
}

/** `/staff/orders` → `/orders` and `/staff` → `/`; anything else unchanged. */
function stripPrefix(surface: Exclude<Surface, 'main'>, href: string): string {
  const prefix = SURFACE_PREFIX[surface];
  if (href === prefix) return '/';
  if (href.startsWith(`${prefix}/`)) return href.slice(prefix.length) || '/';
  return href;
}

function isUnder(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}
