// Keeping the counter usable when the page isn't — the pure half (main.ts
// wires it to Electron). Unit-tested in tests/desktop/recovery.test.ts.
//
// Three ways the POS window used to end up "hung" with nothing to do about it:
//  - the network was down when the app opened (or dropped on a reload): the
//    window showed Chromium's error page and stayed on it, forever;
//  - the page's renderer crashed: a white window, forever;
//  - the page stopped responding: the window looked frozen, with no prompt.
// And one way recovering was slower than it had to be: F5 always reloaded the
// whole app (sign-in check, every screen's data, and the order being punched)
// when the counter only wanted fresh data.

export type ShellKeyAction =
  /** Reload the whole page (Ctrl+R; Ctrl+Shift+R also skips the cache). */
  | { type: 'reload'; ignoreCache: boolean }
  /** Let the page have it (F5 → the web app's own soft refresh). */
  | { type: 'page' }
  | { type: 'quit' }
  | { type: 'block' };

export interface ShellKeyInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * What the shell does with a key before the page sees it, or null to pass it on.
 *
 * `pageHealthy`: the window is showing the POS (its last load succeeded and the
 * renderer is alive). F5 then goes to the page, which refreshes its data in
 * place (lib/staff/shortcuts.ts). On an error page there is no POS to do that,
 * so F5 falls back to a real reload, the only thing that can help there.
 */
export function shellKeyAction(
  input: ShellKeyInput,
  opts: { packaged: boolean; pageHealthy: boolean },
): ShellKeyAction | null {
  if (input.type !== 'keyDown') return null;
  const key = input.key.toLowerCase();
  const mod = input.control || input.meta;

  // Ctrl+R / Ctrl+Shift+R — always a real reload, always handled here, so a
  // frozen page (which can't answer a key at all) can still be recovered.
  if (mod && key === 'r' && !input.alt) return { type: 'reload', ignoreCache: input.shift };

  if (key === 'f5' && !mod && !input.alt) {
    if (input.shift) return { type: 'reload', ignoreCache: true };
    return opts.pageHealthy ? { type: 'page' } : { type: 'reload', ignoreCache: false };
  }

  // Devtools stay shut in a packaged build (webPreferences.devTools: false is
  // the real control; this is belt-and-braces).
  const isDevToolsCombo = key === 'f12' || (mod && input.shift && key === 'i');
  if (isDevToolsCombo && opts.packaged) return { type: 'block' };

  // Ctrl+Q — an explicit, always-available quit (Alt+F4 already quits).
  if (mod && key === 'q' && !input.shift && !input.alt) return { type: 'quit' };

  return null;
}

/** How long to wait before retrying a failed page load: 2 s, 4 s, 8 s … capped at 30 s. */
export function loadRetryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(30_000, 2_000 * 2 ** n);
}

/**
 * Whether a did-fail-load is worth retrying. -3 (ERR_ABORTED) is a navigation
 * the page itself replaced (a redirect, a second click) — not a failure. Only
 * the main frame matters: a failed iframe (a print job) is the print queue's
 * business.
 */
export function shouldRetryLoad(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== -3;
}

/** A renderer that stopped responding this long gets a "Reload / Wait" prompt. */
export const UNRESPONSIVE_PROMPT_MS = 8_000;
