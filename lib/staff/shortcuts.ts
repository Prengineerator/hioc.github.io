// POS keyboard shortcuts — the pure half (components/staff/PosShortcuts.tsx
// listens and acts). One letter per screen, the same letter everywhere:
//
//   Ctrl+N  New order        Ctrl+T  Tables        Ctrl+L  Live orders
//   Ctrl+O  Orders (today)   Ctrl+S  Settle
//   Ctrl+F  Search the menu (also Ctrl+K, or / outside a text field)
//   Ctrl+Enter  Charge (New order)
//   F5      Refresh the data on screen (no page reload)
//   F1      Show the shortcuts (also Ctrl+/, or ? outside a text field)
//
// Alt + the same letter does the same thing. That is for a plain browser tab:
// Chrome keeps Ctrl+N and Ctrl+T for itself and never hands them to a page.
// The HIOC POS desktop app has no browser menu, so Ctrl works there as listed.
//
// Matched on `code` (the physical key), not `key`, so Caps Lock, a Hindi
// keyboard layout or Alt producing a symbol on a Mac all still read as the
// letter printed on the key.

export type ShortcutAction =
  | { type: 'navigate'; href: string }
  | { type: 'refresh' }
  | { type: 'focus-search' }
  | { type: 'charge' }
  | { type: 'help' };

export interface ShortcutKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  /** Focus is in a text field (input, textarea, select, contenteditable). */
  inEditable: boolean;
}

export interface NavShortcut {
  code: string;
  letter: string;
  href: string;
  label: string;
}

export const NAV_SHORTCUTS: readonly NavShortcut[] = [
  { code: 'KeyN', letter: 'N', href: '/staff/orders/new', label: 'New order' },
  { code: 'KeyT', letter: 'T', href: '/staff/tables', label: 'Tables' },
  { code: 'KeyL', letter: 'L', href: '/staff', label: 'Live orders' },
  { code: 'KeyO', letter: 'O', href: '/staff/orders', label: 'Orders' },
  { code: 'KeyS', letter: 'S', href: '/staff/settle', label: 'Settle' },
];

/** What a key press should do, or null to leave it to the browser. */
export function shortcutFor(k: ShortcutKey): ShortcutAction | null {
  if (k.repeat) return null; // a held key fires once
  const ctrl = k.ctrlKey || k.metaKey;
  const noMods = !ctrl && !k.altKey && !k.shiftKey;

  // Function keys. Shift/Ctrl+F5 are left to the browser: that is the hard reload.
  if (k.key === 'F5' && noMods) return { type: 'refresh' };
  if (k.key === 'F1' && noMods) return { type: 'help' };

  if (ctrl && !k.altKey && !k.shiftKey) {
    if (k.code === 'Enter' || k.code === 'NumpadEnter' || k.key === 'Enter') return { type: 'charge' };
    if (k.code === 'KeyF' || k.code === 'KeyK') return { type: 'focus-search' };
    if (k.code === 'Slash') return { type: 'help' };
  }

  // Ctrl+letter (the desktop app) or Alt+letter (any browser), never both at
  // once and never with Shift — Ctrl+Shift+T is the browser's "reopen tab".
  const ctrlOnly = ctrl && !k.altKey && !k.shiftKey;
  const altOnly = k.altKey && !ctrl && !k.shiftKey;
  if (ctrlOnly || altOnly) {
    const nav = NAV_SHORTCUTS.find((s) => s.code === k.code);
    if (nav) return { type: 'navigate', href: nav.href };
  }

  // Bare keys only where they can't be typing.
  if (!k.inEditable && !ctrl && !k.altKey) {
    if (k.key === '?') return { type: 'help' };
    if (k.key === '/' && !k.shiftKey) return { type: 'focus-search' };
  }
  return null;
}

/**
 * For the help sheet: the rows, in reading order. `navModifier` is what the
 * screen keys use HERE — 'Ctrl' in the desktop app, 'Alt' in a browser tab
 * (where Ctrl+N and Ctrl+T belong to the browser).
 */
export function shortcutHelpRows(
  available: (href: string) => boolean,
  navModifier: 'Ctrl' | 'Alt' = 'Ctrl',
): { keys: string; label: string }[] {
  return [
    ...NAV_SHORTCUTS.filter((s) => available(s.href)).map((s) => ({
      keys: `${navModifier}+${s.letter}`,
      label: s.label,
    })),
    { keys: 'Ctrl+F', label: 'Search the menu' },
    { keys: 'Ctrl+Enter', label: 'Charge (New order)' },
    { keys: 'Esc', label: 'Close a dialog · clear the search' },
    { keys: 'F5', label: 'Refresh the data on screen' },
    { keys: 'Ctrl+R', label: 'Reload the whole app (if a screen is stuck)' },
    { keys: 'F1', label: 'Show these shortcuts' },
  ];
}
