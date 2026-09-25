// PRN/SHL — the contract between the web app and the HIOC desktop shell.
//
// The desktop app (desktop/, Electron) loads the live staff site and exposes
// `window.hiocDesktop` from its preload script. This file is the ONLY shape
// either side may assume: the preload implements it, the web app consumes it,
// and a plain browser has no bridge at all — every caller must handle `null`.
//
// Deliberately low-level. Ticket layout (lib/print/escpos.ts) and routing
// (lib/desktop/routing.ts) live in the web app, so they ship with every Vercel
// deploy; the shell, which updates far less often, only moves bytes to a
// printer and reports what the printer says.

import type { PrintType } from '@/lib/staff/autoPrint';
import type { CutMode } from '@/lib/print/escpos';

export type PrinterRole = PrintType;
export type { CutMode };

/**
 * How the machine reaches the printer.
 * - network: raw ESC/POS over TCP (port 9100). Status readable.
 * - usb:     raw ESC/POS over libusb. Status readable. On Windows this needs the
 *            WinUSB driver; the OS-printer route below is the easy path there.
 * - system:  a printer installed in the OS. `raw` sends ESC/POS bytes through
 *            the spooler (CUPS `lp -o raw` / Windows RAW datatype); `driver`
 *            prints the HTML ticket through the printer's driver. Neither can
 *            read paper status.
 */
export type PrinterConnection =
  | { kind: 'network'; host: string; port: number }
  | { kind: 'usb'; vendorId: number; productId: number; serialNumber?: string }
  | { kind: 'system'; deviceName: string; mode: 'raw' | 'driver' };

export interface PrinterConfig {
  /** Stable local id (uuid), never reused. */
  id: string;
  /** Owner's name for it: "Kitchen", "Counter". */
  name: string;
  connection: PrinterConnection;
  paperWidthMm: 58 | 80;
  /** Which tickets go here. A role may be on several printers. */
  roles: PrinterRole[];
  /** Copies per role; missing means 1. */
  copies: Partial<Record<PrinterRole, number>>;
  /** Send a paper cut after each ticket (raw connections only). */
  cut: boolean;
  /**
   * Which ESC/POS cut command to send when `cut` is true (see `CutMode` in
   * lib/print/escpos.ts — many cheaper printers only support one of these).
   * Optional so printer configs saved before this field existed keep
   * loading; treat a missing value as `'standard'`.
   */
  cutMode?: CutMode;
  /** This printer drives the cash drawer (RJ11 kick port). */
  drawer: boolean;
}

export type PrinterHealth =
  | 'ok'
  | 'paper_near_end'
  | 'paper_out'
  | 'cover_open'
  | 'offline'
  | 'error'
  /** The connection can't report status (system printers). */
  | 'unknown';

export interface PrinterStatus {
  printerId: string;
  health: PrinterHealth;
  /** Human-readable detail for the settings screen / failure chip. */
  detail?: string;
  checkedAt: string;
}

/** A printer the machine can see but that hasn't been configured yet. */
export interface DetectedPrinter {
  connection: PrinterConnection;
  label: string;
}

export interface PrintResult {
  /**
   * true  — the printer itself reported healthy after the job (network / usb).
   * false — the job was handed to a spooler/driver that cannot see paper; the
   *         caller must keep PRT-3's "Didn't print" affordance for it.
   */
  confirmed: boolean;
}

export interface HiocDesktopBridge {
  /** Shell version, e.g. "0.1.0". */
  version: string;
  platform: 'win32' | 'darwin' | 'linux';
  printers: {
    list(): Promise<PrinterConfig[]>;
    /** Replaces the whole local list. Validated in the main process. */
    save(printers: PrinterConfig[]): Promise<void>;
    detect(): Promise<DetectedPrinter[]>;
    status(printerId: string): Promise<PrinterStatus>;
  };
  /**
   * Raw ESC/POS bytes to one printer. Rejects (Error.message is staff-readable)
   * when the printer is unreachable or reports paper-out / cover-open, before
   * or after the job. Only valid for network, usb and system+raw printers.
   */
  printRaw(printerId: string, bytes: Uint8Array): Promise<PrintResult>;
  /**
   * Silent driver print of a same-origin /staff-print/ page, for system+driver
   * printers. The shell loads the URL off-screen with the staffer's session and
   * prints it to that device with no dialog.
   */
  printUrl(printerId: string, url: string): Promise<PrintResult>;
  /** Pulse the cash-drawer kick port of a drawer printer. */
  openDrawer(printerId: string): Promise<void>;
}

declare global {
  interface Window {
    hiocDesktop?: HiocDesktopBridge;
  }
}

/** The bridge when running inside the desktop app, else null. */
export function getDesktopBridge(): HiocDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return window.hiocDesktop ?? null;
}

/** IPC channel names — shared so main, preload and tests can't disagree. */
export const DESKTOP_IPC = {
  printersList: 'hioc:printers:list',
  printersSave: 'hioc:printers:save',
  printersDetect: 'hioc:printers:detect',
  printersStatus: 'hioc:printers:status',
  printRaw: 'hioc:print:raw',
  printUrl: 'hioc:print:url',
  openDrawer: 'hioc:drawer:open',
} as const;
