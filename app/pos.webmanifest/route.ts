import { NextResponse } from 'next/server';
import { POS_MANIFEST } from '@/lib/pos/manifest';

// DEV-1 — the POS installs as an app.
//
// One URL, installed per machine, and deploys ARE the updates: this is the whole
// answer to "is there an easy desktop application, usable at several places"
// (F7) without a packaged app, a distribution channel or an update problem.
// Installed, the counter runs in its own window with no tabs and no address bar,
// which is also what makes PRT-2's kiosk-printing profile and PIN-2's lock
// screen feel like an appliance rather than a browser page.
//
// WHY THIS IS A ROUTE AND NOT app/manifest.ts. The spec names Next's
// `app/manifest.ts` file convention, and that convention links the manifest from
// EVERY page in the app — including hioc.in/menu. A customer browsing the menu
// would be offered "Install HIOC POS", and installing it would drop them on the
// staff login screen. Cancelling that link in the root layout with
// `manifest: null` does not work: mergeStaticMetadata() applies the file
// convention AFTER a layout's own metadata, so the file always wins (verified
// against next 14.2 — the link was still emitted on /menu). Served from a
// non-convention URL instead and declared in app/staff/layout.tsx's metadata,
// so the install offer exists exactly where it makes sense.
//
// A dotted path is host-agnostic via isHostAgnostic()'s file-extension rule
// (lib/routing/surface.ts, which also names this URL explicitly), so it is
// served identically on hioc.in and staff.hioc.in rather than being rewritten
// to /staff/pos.webmanifest.
//
// DELIBERATELY NO SERVICE WORKER (D6-5, spec §13). Chrome dropped the SW
// requirement for installability years ago, and a caching worker is precisely
// the stale-POS foot-gun that offline mode has to introduce carefully and on
// purpose — not as a side-effect of making the thing installable. Every request
// still goes to the network, so a POS window that is open during a deploy shows
// the new code on its next navigation instead of serving yesterday's bundle.

// Prerendered at build time and served as a static asset: this document changes
// with a deploy, never with a request.
export const dynamic = 'force-static';

export function GET() {
  // application/manifest+json is the registered type. Chrome accepts
  // application/json too, but Lighthouse's installability audit and some
  // Android launchers check the header.
  return NextResponse.json(POS_MANIFEST, {
    headers: { 'content-type': 'application/manifest+json' },
  });
}
