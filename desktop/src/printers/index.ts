// PRN — PrinterService: the one thing main.ts talks to. Dispatches each call
// onto the right transport by the printer's configured connection kind, and
// serialises jobs per physical printer id so two tickets destined for the
// same device can never interleave their bytes (a KOT and a reprint racing
// for the same kitchen printer, say).

import type { Session, WebContents } from 'electron';
import type { DetectedPrinter, PrinterConfig, PrinterStatus, PrintResult } from '@/lib/desktop/bridge';
import { checkNetworkStatus, printOverNetwork } from './network';
import { printUrlWithDriver } from './driver';
import { printRawToSystemPrinter, listSystemPrinters } from './spooler';
import { loadPrinters, savePrinters } from './store';
import { checkUsbStatus, detectUsbPrinters, printOverUsb } from './usb';

// ESC p 0 25 250 — the standard ESC/POS cash-drawer kick-out pulse (RJ11 pin,
// ~25ms on-time / 250ms off-time in the printer's own units).
const DRAWER_KICK = new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa]);

function friendlyName(printer: PrinterConfig): string {
  return `${printer.name} printer`;
}

export interface PrinterServiceDeps {
  /** For system-printer listing (webContents.getPrintersAsync) — null when no
   * window exists yet. */
  getWebContents: () => WebContents | null;
  /** Reused from main.ts (SHL-2) so the /staff-print/ URL check in PRN-5's
   * driver route can never drift from the navigation/IPC allowlist. */
  isAllowedOrigin: (url: string) => boolean;
  /** The main POS window's session (the dedicated `persist:hioc-pos`
   * partition) — threaded into the hidden driver-print window so it shares
   * the staffer's login instead of falling back to Electron's default
   * session. Null when no window exists yet. */
  getSession: () => Session | null;
}

export class PrinterService {
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: PrinterServiceDeps) {}

  /** Runs `job` after any job already queued for this printer id finishes
   * (success or failure), so exactly one job is ever in flight per device.
   * The caller sees `job`'s real rejection; only the internal chain used to
   * order the NEXT job swallows it. */
  private serialize<T>(printerId: string, job: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(printerId) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(job);
    this.queues.set(
      printerId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async findPrinter(printerId: string): Promise<PrinterConfig> {
    const printers = await loadPrinters();
    const printer = printers.find((p) => p.id === printerId);
    if (!printer) throw new Error('Unknown printer');
    return printer;
  }

  async list(): Promise<PrinterConfig[]> {
    return loadPrinters();
  }

  async save(printers: PrinterConfig[]): Promise<void> {
    return savePrinters(printers);
  }

  async detect(): Promise<DetectedPrinter[]> {
    const detected: DetectedPrinter[] = [];

    try {
      for (const p of await detectUsbPrinters()) {
        detected.push({
          connection: {
            kind: 'usb',
            vendorId: p.vendorId,
            productId: p.productId,
            ...(p.serialNumber ? { serialNumber: p.serialNumber } : {}),
          },
          label: p.label,
        });
      }
    } catch (err) {
      console.error('[hioc-pos] USB detection unavailable:', err instanceof Error ? err.message : err);
    }

    try {
      const webContents = this.deps.getWebContents();
      if (webContents) {
        for (const p of await listSystemPrinters(webContents)) {
          detected.push({
            connection: { kind: 'system', deviceName: p.name, mode: 'raw' },
            label: p.displayName || p.name,
          });
        }
      }
    } catch (err) {
      console.error('[hioc-pos] OS printer detection failed:', err instanceof Error ? err.message : err);
    }

    return detected;
  }

  async status(printerId: string): Promise<PrinterStatus> {
    const checkedAt = new Date().toISOString();
    let printer: PrinterConfig;
    try {
      printer = await this.findPrinter(printerId);
    } catch {
      return { printerId, health: 'error', detail: 'Unknown printer', checkedAt };
    }

    try {
      if (printer.connection.kind === 'network') {
        const result = await checkNetworkStatus(printer.connection);
        return { printerId, health: result.health, detail: result.detail, checkedAt };
      }
      if (printer.connection.kind === 'usb') {
        const result = await checkUsbStatus(printer.connection);
        return { printerId, health: result.health, detail: result.detail, checkedAt };
      }
      return { printerId, health: 'unknown', detail: 'OS printers cannot report paper status', checkedAt };
    } catch (err) {
      return { printerId, health: 'error', detail: err instanceof Error ? err.message : String(err), checkedAt };
    }
  }

  async printRaw(printerId: string, bytes: Uint8Array): Promise<PrintResult> {
    const printer = await this.findPrinter(printerId);
    const name = friendlyName(printer);

    return this.serialize(printerId, async () => {
      if (printer.connection.kind === 'network') {
        return printOverNetwork(printer.connection, name, bytes);
      }
      if (printer.connection.kind === 'usb') {
        return printOverUsb(printer.connection, name, bytes);
      }
      if (printer.connection.kind === 'system' && printer.connection.mode === 'raw') {
        return printRawToSystemPrinter(printer.connection.deviceName, bytes);
      }
      throw new Error(`${name} is not configured for raw printing`);
    });
  }

  async printUrl(printerId: string, url: string): Promise<PrintResult> {
    const printer = await this.findPrinter(printerId);
    if (printer.connection.kind !== 'system' || printer.connection.mode !== 'driver') {
      throw new Error(`${friendlyName(printer)} is not configured for driver printing`);
    }
    const session = this.deps.getSession();
    if (!session) {
      throw new Error('The POS window is not ready yet — try again in a moment');
    }
    const deviceName = printer.connection.deviceName;
    return this.serialize(printerId, () =>
      printUrlWithDriver(url, { deviceName }, this.deps.isAllowedOrigin, session),
    );
  }

  async openDrawer(printerId: string): Promise<void> {
    const printer = await this.findPrinter(printerId);
    if (!printer.drawer) {
      throw new Error(`${friendlyName(printer)} is not wired to the cash drawer`);
    }
    const name = friendlyName(printer);

    await this.serialize(printerId, async () => {
      if (printer.connection.kind === 'network') {
        await printOverNetwork(printer.connection, name, DRAWER_KICK);
        return;
      }
      if (printer.connection.kind === 'usb') {
        await printOverUsb(printer.connection, name, DRAWER_KICK);
        return;
      }
      if (printer.connection.kind === 'system' && printer.connection.mode === 'raw') {
        await printRawToSystemPrinter(printer.connection.deviceName, DRAWER_KICK);
        return;
      }
      throw new Error(`${name} cannot open the drawer (system+driver printers have no raw byte access)`);
    });
  }
}
