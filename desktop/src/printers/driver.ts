// PRN-5 (system+driver half) — for a printer with only a normal OS driver (no
// ESC/POS raw support), print the existing staff-print HTML page through that
// driver, silently, off-screen. The hidden window uses the app's DEFAULT
// session, so it shares cookies with the main window — the same-origin
// /staff-print/ page sees the staffer's login exactly as it would in a
// visible tab. Only ever loads a URL whose origin is allowlisted AND whose
// path starts with /staff-print/ — this is the one place in the shell that
// loads a URL supplied at call time rather than a fixed constant, so both
// checks are mandatory, not defense in depth.

import { BrowserWindow } from 'electron';

const PRINT_TIMEOUT_MS = 20_000;
const SETTLE_MS = 300;
const WINDOW_WIDTH = 302; // ~80mm ticket width for layout purposes only
const WINDOW_HEIGHT = 500;

export interface DriverPrintTarget {
  deviceName: string;
}

export type AllowedOriginCheck = (url: string) => boolean;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPrintableUrl(url: string, isAllowedOrigin: AllowedOriginCheck): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL`);
  }
  if (!isAllowedOrigin(url)) {
    throw new Error(`Refusing to print an untrusted URL: ${url}`);
  }
  if (!parsed.pathname.startsWith('/staff-print/')) {
    throw new Error(`Refusing to print a page outside /staff-print/: ${parsed.pathname}`);
  }
  return parsed;
}

/** Prints a same-origin /staff-print/ page through an installed OS driver.
 * Always destroys the hidden window, success, failure or timeout. Resolves
 * `confirmed: false` on success — this route can't see paper (PRN-4). */
export async function printUrlWithDriver(
  url: string,
  target: DriverPrintTarget,
  isAllowedOrigin: AllowedOriginCheck,
): Promise<{ confirmed: boolean }> {
  assertPrintableUrl(url, isAllowedOrigin);

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No `session` override — deliberately inherits the default session so
      // the staffer's cookies carry over to this same-origin page.
    },
  });

  const work = (async () => {
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_event, code, description) => {
        reject(new Error(`Failed to load the print page: ${description} (${code})`));
      });
      win.loadURL(url).catch(reject);
    });

    await delay(SETTLE_MS);

    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        { silent: true, deviceName: target.deviceName, margins: { marginType: 'none' } },
        (success, failureReason) => {
          if (success) resolve();
          else reject(new Error(`Print failed on ${target.deviceName}: ${failureReason}`));
        },
      );
    });
  })();

  const timeout = delay(PRINT_TIMEOUT_MS).then(() => {
    throw new Error(`Timed out printing on ${target.deviceName}`);
  });

  try {
    await Promise.race([work, timeout]);
    return { confirmed: false };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
