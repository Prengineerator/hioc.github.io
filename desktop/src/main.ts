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

// A dedicated, persistent partition (SHL-1, owner request: "totally an
// isolated interface for POS"). Cookies/localStorage/IndexedDB here are
// separate from every other Electron/Chrome profile on the machine, so
// signing in or out in Chrome never touches the POS app's session, and the
// reverse. Persistent (not in-memory) so the staffer stays signed in across
// restarts, same as before. On Windows, Chromium/Electron encrypts this
// partition's cookies at rest with DPAPI, tied to the machine's OS user
// account — see desktop/README.md.
const POS_PARTITION = 'persist:hioc-pos';

let mainWindow: BrowserWindow | null = null;

const printerService = new PrinterService({
  getWebContents: () => mainWindow?.webContents ?? null,
  isAllowedOrigin,
  getSession: () => mainWindow?.webContents.session ?? null,
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

/** https only — file:, javascript: and any custom scheme are refused outright
 * and never handed to shell.openExternal, which would otherwise happily open
 * a local file or, on Windows, a registered custom-protocol handler. */
function isSafeToOpenExternally(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function guardExternalNavigation(contents: WebContents): void {
  const allowOrSendExternal = (url: string): boolean => {
    if (isAllowedOrigin(url)) return true;
    // Anything outside the POS allowlist (the customer site, owner.hioc.in,
    // a stray link, or — via drag-and-drop — a local file://) is refused in
    // this window. An https link still goes to the OS's default browser so a
    // staffer isn't stuck; a non-https URL (file:, javascript:, a custom
    // scheme) is just dropped.
    if (isSafeToOpenExternally(url)) {
      shell.openExternal(url).catch(() => undefined);
    }
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
  // browser — this shell never spawns an uncontrolled child window, so there
  // is no popup path for a same-origin print flow to (mis)use either: PRN-5's
  // driver print window is opened directly in the main process, never via a
  // renderer's window.open.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) {
      contents.loadURL(url).catch(() => undefined);
    } else if (isSafeToOpenExternally(url)) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });
}

/** Reload stays available (Ctrl+R / F5) so a frozen POS screen can be
 * recovered without giving access to anything else; devtools shortcuts are
 * blocked outright in a packaged build — belt-and-suspenders alongside
 * `webPreferences.devTools: false`, which already stops them from doing
 * anything. */
function guardKeyboardShortcuts(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();

    const isReload = ((input.control || input.meta) && key === 'r' && !input.shift && !input.alt) || key === 'f5';
    if (isReload) {
      contents.reload();
      event.preventDefault();
      return;
    }

    const isDevToolsCombo = key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i');
    if (isDevToolsCombo && app.isPackaged) {
      event.preventDefault();
    }
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // SHL-1: the dedicated, persistent session — see POS_PARTITION above.
      partition: POS_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // No inspector in a packaged build — a counter machine has no reason to
      // ever show DevTools, and it also stops F12/Ctrl+Shift+I from doing
      // anything (guardKeyboardShortcuts below is belt-and-suspenders on top
      // of this, not the primary control).
      devTools: !app.isPackaged,
      // Lets preload.ts read the shell version synchronously with no IPC
      // round-trip — see readAppVersion() there.
      additionalArguments: [`--hioc-app-version=${app.getVersion()}`],
    },
  });

  // UI-hint only, never a trust boundary — server-side trust comes from the
  // enrolled-device cookie (lib/api/device.ts), not this. Useful for reading
  // logs/analytics and telling the app apart from a plain browser tab at a
  // glance; lib/desktop/isDesktopApp.ts is the reliable in-page signal.
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} HIOCPOS/${app.getVersion()}`);

  guardExternalNavigation(win.webContents);
  guardKeyboardShortcuts(win.webContents);

  // A dropped file (or any other drag-and-drop navigation attempt) fires
  // will-navigate with a file:// URL, which the guard above already refuses
  // — and, being non-https, guardExternalNavigation never hands it to
  // shell.openExternal either.

  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  // Top-level loadURL guard: HIOC_POS_URL is operator/env-set, not
  // attacker-controlled, but a misconfigured value (a typo, a stray
  // owner.hioc.in) must not silently open a non-POS surface as this window's
  // very first page — refuse it the same way a mid-session navigation would
  // be refused, rather than trusting it just because it's the start URL.
  if (!isAllowedOrigin(HIOC_POS_URL)) {
    console.error('[hioc-pos] HIOC_POS_URL is not an allowed POS origin, refusing to load:', HIOC_POS_URL);
  } else {
    win.loadURL(HIOC_POS_URL).catch((err) => {
      console.error('[hioc-pos] failed to load', HIOC_POS_URL, err);
    });
  }

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
