'use client';

// First-party traffic tracking (docs/TRAFFIC-TRACKING.md). Mounted once in the
// root layout, on the customer site only. On every page load it picks up where
// the visit came from (lib/traffic/client.ts), so a visit that lands on the
// home page from Instagram and then opens the menu is still counted as
// Instagram. It sends a page view only for the ordering and Shop pages
// (lib/traffic/classify.ts routeForPath), and for each of those once per
// navigation. Renders nothing.

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { routeForPath } from '@/lib/traffic/classify';
import { beginPageLoad, sendTrafficView, trackingDeclined } from '@/lib/traffic/client';

export function TrafficTracker() {
  const pathname = usePathname();
  const started = useRef(false);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname) return;
    try {
      if (trackingDeclined()) return;
      if (!started.current) {
        started.current = true;
        beginPageLoad();
      }
      if (lastPath.current === pathname) return;
      lastPath.current = pathname;
      const tracked = routeForPath(pathname);
      if (tracked) sendTrafficView(tracked.route);
    } catch {
      // tracking must never touch the page
    }
  }, [pathname]);

  return null;
}
