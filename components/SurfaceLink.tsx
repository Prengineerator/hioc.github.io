'use client';

import { createContext, useContext, useMemo } from 'react';
import Link from 'next/link';
import { hrefForSurface, prefetchByDefault, type Surface } from '@/lib/routing/surface';

// Lets the whole app keep writing canonical hrefs — `/staff/orders`, always —
// while the address bar reads `staff.hioc.in/orders` on the subdomain.
//
// The surface comes from the SERVER (middleware sets x-surface, the root layout
// reads it and provides it here) rather than from window.location. That is the
// whole point: deriving it on the client would render `/staff/orders` on the
// server and `/orders` on the client, and React would throw a hydration
// mismatch on every page that has a nav bar.

const SurfaceContext = createContext<Surface>('main');

export function SurfaceProvider({
  surface,
  children,
}: {
  surface: Surface;
  children: React.ReactNode;
}) {
  return <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>;
}

export function useSurface(): Surface {
  return useContext(SurfaceContext);
}

/**
 * Converts a canonical app path for the current surface.
 *
 * Use for `router.push()` and anywhere an href is computed rather than written.
 */
export function useSurfaceHref(): (href: string) => string {
  const surface = useSurface();
  return useMemo(() => (href: string) => hrefForSurface(surface, href), [surface]);
}

/**
 * Drop-in for `next/link` that rewrites its href for the current surface.
 *
 * A cross-surface link becomes an absolute URL on the other surface's host
 * (see hrefForSurface): on owner.hioc.in a relative /staff/login would resolve
 * to owner.hioc.in/staff/login and 404.
 *
 * Links into the staff and owner surfaces don't prefetch unless asked to
 * (prefetchByDefault): there, each prefetch is a server render.
 */
export function SurfaceLink({
  href,
  children,
  prefetch,
  ...rest
}: React.ComponentProps<typeof Link>) {
  const surface = useSurface();
  const resolved = typeof href === 'string' ? hrefForSurface(surface, href) : href;
  const prefetchProp =
    prefetch !== undefined ? prefetch : typeof href === 'string' && !prefetchByDefault(href) ? false : undefined;
  return (
    <Link href={resolved} prefetch={prefetchProp} {...rest}>
      {children}
    </Link>
  );
}
