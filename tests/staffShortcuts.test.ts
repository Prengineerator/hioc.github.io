import { describe, expect, it } from 'vitest';
import { NAV_SHORTCUTS, shortcutFor, shortcutHelpRows, type ShortcutKey } from '@/lib/staff/shortcuts';

// The POS keyboard map. The same letter means the same screen everywhere;
// Ctrl in the desktop app, Alt in a browser tab (Chrome keeps Ctrl+N/T).

function key(over: Partial<ShortcutKey>): ShortcutKey {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    inEditable: false,
    ...over,
  };
}

describe('shortcutFor — screens', () => {
  it('Ctrl+N opens New order, and so does Alt+N', () => {
    expect(shortcutFor(key({ key: 'n', code: 'KeyN', ctrlKey: true }))).toEqual({
      type: 'navigate',
      href: '/staff/orders/new',
    });
    expect(shortcutFor(key({ key: 'n', code: 'KeyN', altKey: true }))).toEqual({
      type: 'navigate',
      href: '/staff/orders/new',
    });
  });

  it('maps every screen letter', () => {
    const got = NAV_SHORTCUTS.map((s) => shortcutFor(key({ code: s.code, ctrlKey: true })));
    expect(got).toEqual([
      { type: 'navigate', href: '/staff/orders/new' },
      { type: 'navigate', href: '/staff/tables' },
      { type: 'navigate', href: '/staff' },
      { type: 'navigate', href: '/staff/orders' },
      { type: 'navigate', href: '/staff/settle' },
    ]);
  });

  it('works from inside the search bar (Ctrl+N while typing)', () => {
    expect(shortcutFor(key({ code: 'KeyT', ctrlKey: true, inEditable: true }))?.type).toBe('navigate');
  });

  it('reads the physical key, so Caps Lock or another layout still works', () => {
    expect(shortcutFor(key({ key: 'N', code: 'KeyN', ctrlKey: true }))?.type).toBe('navigate');
    expect(shortcutFor(key({ key: '˜', code: 'KeyN', altKey: true }))?.type).toBe('navigate');
  });

  it('leaves browser combos alone: Shift, Ctrl+Alt, a held key, plain letters', () => {
    expect(shortcutFor(key({ code: 'KeyT', ctrlKey: true, shiftKey: true }))).toBeNull(); // reopen tab
    expect(shortcutFor(key({ code: 'KeyN', ctrlKey: true, altKey: true }))).toBeNull(); // AltGr on Windows
    expect(shortcutFor(key({ code: 'KeyN', ctrlKey: true, repeat: true }))).toBeNull();
    expect(shortcutFor(key({ key: 'n', code: 'KeyN' }))).toBeNull();
    expect(shortcutFor(key({ code: 'KeyC', ctrlKey: true }))).toBeNull(); // copy stays copy
  });
});

describe('shortcutFor — actions', () => {
  it('F5 refreshes the data; Shift/Ctrl+F5 stay the browser hard reload', () => {
    expect(shortcutFor(key({ key: 'F5', code: 'F5' }))).toEqual({ type: 'refresh' });
    expect(shortcutFor(key({ key: 'F5', code: 'F5', shiftKey: true }))).toBeNull();
    expect(shortcutFor(key({ key: 'F5', code: 'F5', ctrlKey: true }))).toBeNull();
  });

  it('Ctrl+R is never taken: it is the real reload', () => {
    expect(shortcutFor(key({ key: 'r', code: 'KeyR', ctrlKey: true }))).toBeNull();
  });

  it('Ctrl+Enter charges', () => {
    expect(shortcutFor(key({ key: 'Enter', code: 'Enter', ctrlKey: true }))).toEqual({ type: 'charge' });
    expect(shortcutFor(key({ key: 'Enter', code: 'NumpadEnter', ctrlKey: true }))).toEqual({ type: 'charge' });
    expect(shortcutFor(key({ key: 'Enter', code: 'Enter' }))).toBeNull();
  });

  it('Ctrl+F / Ctrl+K search; / searches only outside a text field', () => {
    expect(shortcutFor(key({ code: 'KeyF', ctrlKey: true }))).toEqual({ type: 'focus-search' });
    expect(shortcutFor(key({ code: 'KeyK', metaKey: true }))).toEqual({ type: 'focus-search' });
    expect(shortcutFor(key({ key: '/', code: 'Slash' }))).toEqual({ type: 'focus-search' });
    expect(shortcutFor(key({ key: '/', code: 'Slash', inEditable: true }))).toBeNull();
  });

  it('F1, Ctrl+/ and ? (outside a field) open the help', () => {
    expect(shortcutFor(key({ key: 'F1', code: 'F1' }))).toEqual({ type: 'help' });
    expect(shortcutFor(key({ key: '/', code: 'Slash', ctrlKey: true }))).toEqual({ type: 'help' });
    expect(shortcutFor(key({ key: '?', code: 'Slash', shiftKey: true }))).toEqual({ type: 'help' });
    expect(shortcutFor(key({ key: '?', code: 'Slash', shiftKey: true, inEditable: true }))).toBeNull();
  });
});

describe('shortcutHelpRows', () => {
  it('lists only the screens on offer, with the modifier that works here', () => {
    const rows = shortcutHelpRows((href) => href !== '/staff/tables', 'Alt');
    const keys = rows.map((r) => r.keys);
    expect(keys).toContain('Alt+N');
    expect(keys).not.toContain('Alt+T');
    expect(keys).toContain('F5');
    expect(keys).toContain('F1');
  });
});
