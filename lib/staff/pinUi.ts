// PIN-2 — pure UI-logic helpers for the staff PIN lock screen and the staff
// header's logout control, pulled out of LockScreen.tsx / StaffHeader.tsx /
// app/staff/login/page.tsx so the keyboard mapping, the logout destination,
// and the classic-login redirect rule are unit-testable without a DOM
// harness (tests/**/*.test.ts is vitest + node env only — see vitest.config.ts).

/** What a keydown on the PIN pad should do. Deliberately narrow: anything
 * this doesn't recognise (letters, function keys, arrows while a PIN is
 * being entered, …) maps to `ignore` rather than guessing. */
export type PinKeyAction =
  | { type: 'digit'; digit: string }
  | { type: 'backspace' }
  | { type: 'back' }
  | { type: 'ignore' };

export interface KeyModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * Maps a keydown's `event.key` (+ whatever modifier flags rode along with
 * it) to a `PinKeyAction`. Any ctrl/meta/alt combo is left alone — copy,
 * refresh, devtools, browser shortcuts — this only ever claims a plain
 * keystroke.
 *
 * `event.key` reports the same '0'-'9' character for the numpad digits as it
 * does for the row of digits above the letters, so top-row and numpad both
 * fall through the same `/^[0-9]$/` case with no separate branch needed.
 *
 * Enter is claimed (not left to fall through to whatever's behind the
 * overlay) but maps to `ignore`: submission already happens automatically
 * the instant the 4th digit lands, so there is nothing left for Enter to do.
 */
export function pinKeyAction(key: string, modifiers: KeyModifiers = {}): PinKeyAction {
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) return { type: 'ignore' };
  if (/^[0-9]$/.test(key)) return { type: 'digit', digit: key };
  if (key === 'Backspace') return { type: 'backspace' };
  if (key === 'Escape') return { type: 'back' };
  return { type: 'ignore' };
}

/** Appends a digit to a PIN, functional-update style (the caller passes this
 * the PREVIOUS pin, e.g. from a `setPin(prev => ...)` updater) so a fast
 * typist mashing keys can never lose a keystroke to a stale closure, and
 * clamped to `maxLength` so it can't grow past it either. */
export function appendPinDigit(prevPin: string, digit: string, maxLength: number): string {
  return (prevPin + digit).slice(0, maxLength);
}

export type LogoutTarget = '/staff' | '/staff/login';

export interface LogoutDestination {
  href: LogoutTarget;
  /**
   * true → the caller must do a full navigation (`window.location.assign`),
   * not `router.push`: only a fresh request to the server re-runs
   * getCounterActor()/getEnrolledDevice() in app/staff/layout.tsx and renders
   * the full-screen LockScreen. A client-side push would land on whatever
   * the router already has cached for `/staff`.
   */
  hardReload: boolean;
}

/**
 * Where "Log out" sends the staffer, decided AFTER both the operator cookie
 * and any classic session have already been cleared (see StaffHeader's
 * handleLogout — clearing always happens first, regardless of this).
 *
 * `pinCapable` is "this is a PIN-switching counter" — inside the desktop
 * app, on an enrolled device, with the flag on. The caller derives it from
 * whatever it already has on hand (StaffPinOverlay only ever hands
 * StaffHeader a `pinControls` prop under exactly those three conditions, so
 * `Boolean(pinControls)` already IS this check — no separate client fetch
 * needed).
 */
export function logoutDestination(pinCapable: boolean): LogoutDestination {
  return pinCapable ? { href: '/staff', hardReload: true } : { href: '/staff/login', hardReload: false };
}

/** The logout button's label. Deliberately stays "Log out" on a PIN counter
 * too, rather than "Lock" — StaffHeader already has a separate Switch/Lock
 * button (pinControls) for a quick re-lock that keeps the operator signed
 * in; reusing "Lock" here for a button that also tears down any classic
 * session would read as the same action when it isn't. */
export function logoutButtonLabel(_pinCapable: boolean): 'Log out' {
  return 'Log out';
}

export interface ClassicLoginRedirectInput {
  /** flags.pinSwitch && operatorFeatureConfigured() — the same gate
   * app/staff/layout.tsx computes before it will even look up a device. */
  pinEligible: boolean;
  /** getEnrolledDevice() resolved to a real, unrevoked device for this
   * request. */
  deviceEnrolled: boolean;
  /** The `classic` search param exactly as Next hands it to the page
   * (`undefined`/`null` when absent). Any non-empty value opts out — the
   * link this drives is `/staff/login?classic=1`, but the check itself
   * isn't picky about the value. */
  classicParam: string | string[] | null | undefined;
}

/**
 * /staff/login must not hijack a PIN-capable counter (the owner's report:
 * "login... taking to the login interface rather than PIN"). True means the
 * page should redirect to `/staff` (the lock screen) instead of rendering
 * the classic sign-in form.
 *
 * Symmetric with app/staff/layout.tsx's own no-actor branch on purpose: that
 * branch shows the lock screen (and never redirects to /staff/login) exactly
 * when `pinEligible && device` — the same two facts this checks. Neither
 * side ever disagrees with the other, so there is no redirect loop: a device
 * this says "send to /staff" for is always a device the layout is about to
 * show a lock screen for, and a device the layout redirects to /staff/login
 * for (flag off, secret missing, not enrolled, revoked) is always a device
 * this returns `false` for.
 */
export function shouldRedirectClassicLogin(input: ClassicLoginRedirectInput): boolean {
  const hasClassicParam =
    input.classicParam !== null && input.classicParam !== undefined && input.classicParam !== '';
  if (hasClassicParam) return false;
  return input.pinEligible && input.deviceEnrolled;
}

/**
 * Typing the first letter of a name jumps to the next tile whose name starts
 * with it, wrapping around and cycling through same-letter names on repeat
 * presses — the standard `<select>`/file-list type-ahead convention. Returns
 * `null` when nothing matches (including an empty list).
 */
export function nextTileIndexForLetter(names: string[], letter: string, fromIndex: number): number | null {
  if (names.length === 0 || letter.length !== 1) return null;
  const target = letter.toLowerCase();
  for (let step = 1; step <= names.length; step++) {
    const idx = (fromIndex + step) % names.length;
    if (names[idx]?.trim().charAt(0).toLowerCase() === target) return idx;
  }
  return null;
}

export type TileArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/**
 * Grid arrow-key navigation over `count` tiles laid out `columns`-wide (the
 * last row may be short — this only clamps, it never lands on a
 * nonexistent index). Clamps at the edges rather than wrapping: this is a
 * quick tap-to-pick grid, not a carousel, so running off the end should stop,
 * not loop back to the other side.
 */
export function nextTileIndexForArrow(
  key: TileArrowKey,
  fromIndex: number,
  count: number,
  columns: number,
): number {
  if (count === 0) return fromIndex;
  const safeColumns = Math.max(1, columns);
  let next = fromIndex;
  if (key === 'ArrowRight') next = fromIndex + 1;
  else if (key === 'ArrowLeft') next = fromIndex - 1;
  else if (key === 'ArrowDown') next = fromIndex + safeColumns;
  else if (key === 'ArrowUp') next = fromIndex - safeColumns;
  return Math.min(Math.max(next, 0), count - 1);
}

/** The tile-screen name filter (shown only once there are enough operators
 * that scanning tiles beats typing a few letters). Case-insensitive
 * substring match; an empty/whitespace query matches everyone. */
export function filterOperatorsByName<T extends { name: string }>(operators: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return operators;
  return operators.filter((op) => op.name.toLowerCase().includes(q));
}
