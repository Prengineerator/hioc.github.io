'use client';

import { createContext, useContext, useMemo } from 'react';
import Link from 'next/link';
import { hrefForSurface, type Surface } from '@/lib/routing/surface';

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
 * Cross-surface links keep their full path on purpose — a link from the owner
 * dashboard to /staff/login must stay absolute so it resolves on the main
 * domain instead of 404ing under owner.hioc.in.
 */
export function SurfaceLink({
  href,
  children,
  ...rest
}: React.ComponentProps<typeof Link>) {
  const surface = useSurface();
  const resolved = typeof href === 'string' ? hrefForSurface(surface, href) : href;
  return (
    <Link href={resolved} {...rest}>
      {children}
    </Link>
  );
}
