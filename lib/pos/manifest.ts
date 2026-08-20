// DEV-1 — the POS's web app manifest, as data.
//
// The document itself is served by app/pos.webmanifest/route.ts. It lives here
// rather than in that file because a Next route module may only export the
// handlers and route config — an exported constant is a build error — and
// because the invariants below are worth a test (tests/posManifest.test.ts)
// rather than a hope: a renamed icon file or a start_url that drifts to '/'
// breaks an installed counter machine, and neither shows up as a type error.

import type { MetadataRoute } from 'next';

export const POS_MANIFEST: MetadataRoute.Manifest = {
  // `id` pins the app's identity independently of start_url: change start_url
  // later and an installed POS updates in place instead of the OS treating it
  // as a second, different app sitting next to the first.
  id: '/staff',
  name: 'HIOC POS',
  short_name: 'HIOC POS',
  description: 'The counter app for High on Coffee — take orders, settle bills, print tickets.',

  // Where a fresh launch lands: the staff board, not the customer site. Safe on
  // both hosts — rewriteForSurface() serves an already-prefixed /staff on
  // staff.hioc.in rather than producing /staff/staff.
  start_url: '/staff',
  // Scope is the WHOLE origin, not '/staff', because on staff.hioc.in the staff
  // nav's hrefs are prefix-free ('/orders', '/tables') — anything narrower would
  // treat every tap in the installed window as a navigation out of the app and
  // kick it into a browser tab.
  scope: '/',

  display: 'standalone',
  background_color: '#ffffff', // tailwind `cream`
  theme_color: '#232325', // tailwind `charcoal`, matching app/layout.tsx's viewport

  // Two entries per size on purpose. A `maskable` icon is drawn edge-to-edge and
  // cropped to the platform's shape, so it must carry its own background; an
  // `any` icon is drawn as-is. Chrome warns about "any maskable" on a single
  // entry because one bitmap cannot be ideal for both — these are charcoal-backed
  // with the wordmark inside the 80%-diameter safe zone, so they crop cleanly and
  // merely look a little inset when used unmasked. Generated from
  // public/images/logo-light.png composited on #232325 at 62% width.
  icons: [
    { src: '/pos-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/pos-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/pos-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/pos-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],

  // Right-click the dock icon → straight into the two things the counter
  // actually does. Costs nothing when the OS ignores them.
  shortcuts: [
    { name: 'New order', short_name: 'New order', url: '/staff/orders/new' },
    { name: 'Order board', short_name: 'Board', url: '/staff/orders' },
  ],
};
