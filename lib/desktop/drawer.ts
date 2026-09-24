// PRN-6 — the cash drawer. Opens on a cash (or cash-part) settle, never on
// card/UPI, and only when this machine actually has a drawer printer
// configured. Deliberately tiny and defensive: this runs inside a payment
// flow, and a drawer that fails to open must never be the reason a paid order
// looks like it failed. Every path returns instead of throwing; the caller
// decides how (or whether) to surface the string.

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

/**
 * Fires the drawer kick for a settle that included cash. No-op — and no error
 * — outside the desktop app, or on a machine with no drawer printer assigned;
 * neither is a fault, just nothing to do. Returns a staff-readable message
 * only when the shell reported the drawer itself did not open; NEVER throws,
 * so a bad printer can't turn a successful cash sale into an error screen.
 */
export async function openDrawerIfCash(parts: DrawerPart[]): Promise<string | null> {
  try {
    if (!parts.some((p) => p.method === 'cash')) return null;

    const bridge = getDesktopBridge();
    if (!bridge) return null;

    const printers = await bridge.printers.list();
    const printer = drawerPrinter(printers);
    if (!printer) return null;

    await bridge.openDrawer(printer.id);
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Cash drawer didn’t open — ${detail}`;
  }
}
