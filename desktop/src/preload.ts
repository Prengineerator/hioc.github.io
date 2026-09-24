// SHL-2 — the bridge. Exposes `window.hiocDesktop` via contextBridge, but ONLY
// when the loaded document's own origin is allowlisted — a compromised or
// mis-navigated page never gets printer/IPC access just because it happened to
// load inside this shell. `lib/desktop/bridge.ts` (HiocDesktopBridge,
// DESKTOP_IPC) is the exact contract implemented here; do not diverge from it.

import { contextBridge, ipcRenderer } from 'electron';
import { DESKTOP_IPC, type HiocDesktopBridge, type PrinterConfig } from '@/lib/desktop/bridge';
import { createOriginAllowlist } from './allowedOrigin';

const HIOC_POS_URL = process.env.HIOC_POS_URL ?? 'https://staff.hioc.in';
const isAllowedOrigin = createOriginAllowlist(HIOC_POS_URL);

const VERSION_ARG_PREFIX = '--hioc-app-version=';

/** Reads the shell version passed in via `additionalArguments` in main.ts —
 * synchronous, no IPC round-trip needed for a value this static. */
function readAppVersion(): string {
  const arg = process.argv.find((a) => a.startsWith(VERSION_ARG_PREFIX));
  return arg ? arg.slice(VERSION_ARG_PREFIX.length) : '0.0.0';
}

function readPlatform(): HiocDesktopBridge['platform'] {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
    return process.platform;
  }
  return 'linux';
}

const bridge: HiocDesktopBridge = {
  version: readAppVersion(),
  platform: readPlatform(),
  printers: {
    list: () => ipcRenderer.invoke(DESKTOP_IPC.printersList),
    save: (printers: PrinterConfig[]) => ipcRenderer.invoke(DESKTOP_IPC.printersSave, printers),
    detect: () => ipcRenderer.invoke(DESKTOP_IPC.printersDetect),
    status: (printerId: string) => ipcRenderer.invoke(DESKTOP_IPC.printersStatus, printerId),
  },
  printRaw: (printerId: string, bytes: Uint8Array) => ipcRenderer.invoke(DESKTOP_IPC.printRaw, printerId, bytes),
  printUrl: (printerId: string, url: string) => ipcRenderer.invoke(DESKTOP_IPC.printUrl, printerId, url),
  openDrawer: (printerId: string) => ipcRenderer.invoke(DESKTOP_IPC.openDrawer, printerId),
};

if (isAllowedOrigin(window.location.href)) {
  contextBridge.exposeInMainWorld('hiocDesktop', bridge);
}
