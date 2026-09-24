// SHL-1/SHL-2 — the Electron shell. A single always-maximized window pinned to
// the live staff site (or a local dev server via HIOC_POS_URL), a preload
// bridge restricted to that same allowlist, and the printer IPC surface the
// web app drives through `window.hiocDesktop`.
//
// `lib/desktop/bridge.ts` is the ONE contract this file and preload.ts both
// implement — read it before changing either.

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import * as path from 'node:path';
import { autoUpdater } from 'electron-updater';
import { DESKTOP_IPC, type PrinterConfig } from '@/lib/desktop/bridge';
import { createOriginAllowlist } from './allowedOrigin';
import { PrinterService } from './printers';

const HIOC_POS_URL = process.env.HIOC_POS_URL ?? 'https://staff.hioc.in';
const isAllowedOrigin = createOriginAllowlist(HIOC_POS_URL);

let mainWindow: BrowserWindow | null = null;

const printerService = new PrinterService({
  getWebContents: () => mainWindow?.webContents ?? null,
  isAllowedOrigin,
});

/** Every ipcMain.handle callback calls this first (SHL-2): a renderer running
 * anything outside the allowlist gets nothing, not even an error that leaks
 * printer state. */
function assertAllowedSender(event: IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl || !isAllowedOrigin(frameUrl)) {
    throw new Error('Blocked: request came from an origin outside the HIOC allowlist');
  }
}

function guardExternalNavigation(contents: WebContents): void {
  const allowOrSendExternal = (url: string): boolean => {
    if (isAllowedOrigin(url)) return true;
    shell.openExternal(url).catch(() => undefined);
    return false;
  };

  contents.on('will-navigate', (event, url) => {
    if (!allowOrSendExternal(url)) event.preventDefault();
  });

  contents.on('will-redirect', (event, url) => {
    if (!allowOrSendExternal(url)) event.preventDefault();
  });

  // Anything trying to open a new window/tab (target=_blank, window.open)
  // either navigates this same window (allowed origin) or goes to the OS
  // browser — this shell never spawns an uncontrolled child window.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) {
      contents.loadURL(url).catch(() => undefined);
    } else {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Lets preload.ts read the shell version synchronously with no IPC
      // round-trip — see readAppVersion() there.
      additionalArguments: [`--hioc-app-version=${app.getVersion()}`],
    },
  });

  guardExternalNavigation(win.webContents);

  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  win.loadURL(HIOC_POS_URL).catch((err) => {
    console.error('[hioc-pos] failed to load', HIOC_POS_URL, err);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

function registerIpcHandlers(): void {
  ipcMain.handle(DESKTOP_IPC.printersList, async (event) => {
    assertAllowedSender(event);
    return printerService.list();
  });

  ipcMain.handle(DESKTOP_IPC.printersSave, async (event, printers: PrinterConfig[]) => {
    assertAllowedSender(event);
    return printerService.save(printers);
  });

  ipcMain.handle(DESKTOP_IPC.printersDetect, async (event) => {
    assertAllowedSender(event);
    return printerService.detect();
  });

  ipcMain.handle(DESKTOP_IPC.printersStatus, async (event, printerId: string) => {
    assertAllowedSender(event);
    return printerService.status(printerId);
  });

  ipcMain.handle(DESKTOP_IPC.printRaw, async (event, printerId: string, bytes: Uint8Array) => {
    assertAllowedSender(event);
    return printerService.printRaw(printerId, bytes);
  });

  ipcMain.handle(DESKTOP_IPC.printUrl, async (event, printerId: string, url: string) => {
    assertAllowedSender(event);
    return printerService.printUrl(printerId, url);
  });

  ipcMain.handle(DESKTOP_IPC.openDrawer, async (event, printerId: string) => {
    assertAllowedSender(event);
    return printerService.openDrawer(printerId);
  });
}

function configureLoginItem(): void {
  // Default on in packaged builds only — a dev checkout must never install
  // itself into a developer's login items.
  // Calling it at all from an unpackaged app makes macOS log "Operation not
  // permitted", so dev skips the call entirely.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: true });
}

function checkForUpdates(): void {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[hioc-pos] update check failed:', err);
  });
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpcHandlers();
    configureLoginItem();
    mainWindow = createWindow();
    checkForUpdates();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
