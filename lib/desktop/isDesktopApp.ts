// SHL — "is this page running inside the HIOC POS desktop app?"
//
// UI hint only — never a trust boundary. `window.hiocDesktop` is the reliable
// in-page signal (preload.ts only exposes it on an allowlisted POS origin,
// desktop/src/allowedOrigin.ts), which is why this is built on
// getDesktopBridge() rather than the user-agent suffix main.ts appends
// (" HIOCPOS/<version>", for logs only). Server-side trust for anything that
// matters — enrolling a counter, printing, the cash drawer — comes from the
// enrolled-device cookie (lib/api/device.ts), never from this or from any
// client-reported header.

import { getDesktopBridge } from '@/lib/desktop/bridge';

/** True only when rendered inside the desktop app's own window. */
export function isDesktopApp(): boolean {
  return getDesktopBridge() !== null;
}
