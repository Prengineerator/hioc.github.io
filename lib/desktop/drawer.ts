// PRN-6 — the cash drawer. Opens the moment a staffer taps Cash to collect
// (DRW-1: the cash has to go in the drawer before the sale can be recorded, so
// waiting for the server to confirm the settle meant fumbling with a shut
// drawer and the customer's notes in hand). Never on card/UPI, and only when
// this machine actually has a drawer printer configured. Deliberately tiny and
// defensive: this runs inside a payment flow, and a drawer that fails to open
// must never be the reason a sale looks like it failed. Every path returns
// instead of throwing; the caller decides how (or whether) to surface the
// string.

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { drawerPrinter } from '@/lib/desktop/routing';

/**
 * `parts` is deliberately loose (`{ method: string }[]`) rather than importing
 * `PaymentPart` — callers on both the split-tender POS and the single-method
 * order-detail settle path can pass what they already have with no reshaping.
 */
export interface DrawerPart {
  method: string;
}

/** Why the drawer opened — the two values the DRW-2 log accepts. */
export type DrawerReason = 'cash_payment' | 'manual';

type KickResult = 'opened' | 'no_bridge' | 'no_drawer';

/** The kick itself. Throws only when the shell reports the drawer failed. */
async function kickDrawer(): Promise<KickResult> {
  const bridge = getDesktopBridge();
  if (!bridge) return 'no_bridge';
  const printer = drawerPrinter(await bridge.printers.list());
  if (!printer) return 'no_drawer';
  await bridge.openDrawer(printer.id);
  return 'opened';
}

/**
 * DRW-2 — records an opening that actually happened (POST /api/cash-drawer/
 * opens). Fire-and-forget: the drawer is already open, so a log that can't be
 * written (offline, migration pending) is reported to the console and never to
 * the staffer mid-sale. Who and which counter come from the server's own view
 * of the session and device, not from here.
 */
function logDrawerOpen(reason: DrawerReason, orderId: string | null | undefined): void {
  try {
    void fetch('/api/cash-drawer/opens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, ...(orderId ? { order_id: orderId } : {}) }),
      keepalive: true,
    })
      .then((res) => {
        if (!res.ok) console.error('Cash drawer opening was not logged', res.status);
      })
      .catch((err) => console.error('Cash drawer opening was not logged', err));
  } catch (err) {
    console.error('Cash drawer opening was not logged', err);
  }
}

/**
 * Fires the drawer kick for a payment that includes cash, and logs it. No-op —
 * and no error — outside the desktop app, or on a machine with no drawer
 * printer assigned; neither is a fault, just nothing to do (and nothing is
 * logged, since nothing opened). Returns a staff-readable message only when
 * the shell reported the drawer itself did not open; NEVER throws, so a bad
 * printer can't turn a cash sale into an error screen.
 *
 * `orderId` is the order the cash is for, when it exists yet — the POS opens
 * the drawer on the Cash tap, before the order is placed, so it has none.
 */
export async function openDrawerIfCash(
  parts: DrawerPart[],
  opts: { orderId?: string | null } = {},
): Promise<string | null> {
  try {
    if (!parts.some((p) => p.method === 'cash')) return null;
    if ((await kickDrawer()) === 'opened') logDrawerOpen('cash_payment', opts.orderId);
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Cash drawer didn’t open — ${detail}`;
  }
}

/**
 * DRW-2 — the POS's "Open drawer" button: opens with no sale behind it (change
 * for a note, a float top-up) and logs it as `manual`. Unlike the payment path,
 * "nothing happened" is worth saying here, because the staffer asked for it.
 * Returns null on success, otherwise a message; never throws.
 */
export async function openDrawerManually(): Promise<string | null> {
  try {
    const result = await kickDrawer();
    if (result === 'no_bridge') return 'The cash drawer opens only in the HIOC POS app.';
    if (result === 'no_drawer') return 'No drawer printer is set up on this counter (Settings → Printers).';
    logDrawerOpen('manual', null);
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Cash drawer didn’t open — ${detail}`;
  }
}
