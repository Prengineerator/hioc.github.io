// SET-1 — pure status-summary strings for the /staff/settings overview cards
// (one card per section: Printers & cash drawer, Store, This counter). Kept
// separate from the client component that fetches the data (which talks to
// the desktop bridge and /api/store-settings — both best-effort, never
// blocking) so the actual "how do I phrase this status" logic is
// unit-testable without a browser or a mocked bridge.

import type { PrinterConfig, PrinterRole } from '@/lib/desktop/bridge';
import type { StoreOpenState } from '@/lib/store/hours';

const RECEIPT_ROLE: PrinterRole = 'receipt';

/**
 * `printers === null` means "still loading, or not in the desktop app" —
 * callers outside the app pass a fixed copy instead of calling this at all
 * (see SettingsOverview), so `null` here only ever means "checking…".
 */
export function summarizePrinters(printers: PrinterConfig[] | null): string {
  if (printers === null) return 'Checking…';
  if (printers.length === 0) return 'No printers configured yet.';
  const count = `${printers.length} printer${printers.length === 1 ? '' : 's'}`;
  const receiptPrinters = printers.filter((p) => p.roles.includes(RECEIPT_ROLE)).map((p) => p.name);
  if (receiptPrinters.length === 0) return `${count}, no receipt printer assigned`;
  return `${count}, receipt → ${receiptPrinters.join(', ')}`;
}

export function summarizeStore(openState: StoreOpenState | null): string {
  if (!openState) return 'Checking…';
  if (openState.acceptingOrders) return 'Accepting orders';
  return `Not accepting orders (${openState.reason.replace(/_/g, ' ')})`;
}

export function summarizeDevice(device: { name: string } | null): string {
  return device ? `Enrolled as ${device.name}` : 'Not enrolled';
}

const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

/** The "App" card on /staff/settings/counter — desktop app version/platform,
 * or the browser fallback copy when there's no bridge at all. */
export function summarizeDesktopApp(info: { version: string; platform: string } | null): string {
  if (!info) return 'Browser — install HIOC POS for printing';
  const platform = PLATFORM_LABELS[info.platform] ?? info.platform;
  return `HIOC POS ${info.version} · ${platform}`;
}
