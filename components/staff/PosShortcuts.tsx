'use client';

// POS keyboard shortcuts — the listener (the keymap is lib/staff/shortcuts.ts).
// Mounted once by StaffShell, so the same keys work on every staff screen.
//
// A screen can take a shortcut over with useShortcutHandler(): New order uses
// it for Ctrl+F (its search bar), Ctrl+Enter (Charge) and to keep Ctrl+N from
// throwing away an order half punched. Whatever no screen takes, this does:
// screen keys navigate, F5 refreshes the data, F1 opens the help sheet. A
// search or charge key nobody takes is left to the browser (Ctrl+F stays Find).
//
// Nothing fires while a dialog is open (payment, customise, the PIN lock):
// those own the keyboard, and a screen change behind one would strand it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/Modal';
import { useSurfaceHref } from '@/components/SurfaceLink';
import { useStaffShell } from '@/components/staff/StaffShell';
import { flags } from '@/lib/flags';
import { isDesktopApp } from '@/lib/desktop/isDesktopApp';
import { staffNav } from '@/lib/staff/staffNav';
import { shortcutFor, shortcutHelpRows, type ShortcutAction } from '@/lib/staff/shortcuts';
import { requestPosRefresh } from '@/lib/staff/posRefresh';
import { startNavigation } from '@/lib/staff/navPending';

/** Returns true when it handled the action (the key is then consumed). */
export type ShortcutHandler = (action: ShortcutAction) => boolean;

const handlers: { current: ShortcutHandler }[] = [];

/** Let the mounted screen handle shortcuts before the defaults do. Latest mount wins. */
export function useShortcutHandler(handler: ShortcutHandler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const entry = ref;
    handlers.push(entry);
    return () => {
      const i = handlers.lastIndexOf(entry);
      if (i >= 0) handlers.splice(i, 1);
    };
  }, []);
}

/** Opens the shortcuts sheet from anywhere (the header's ⌨ button). */
export const SHOW_SHORTCUTS_EVENT = 'hioc:show-shortcuts';

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type);
  }
  return false;
}

function dialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/**
 * Soft refresh: every screen refetches its data and the server parts of the
 * page re-render, with the screen (and the order being punched) left as it is.
 */
export function useRunPosRefresh(): () => void {
  const router = useRouter();
  return useCallback(() => {
    requestPosRefresh();
    router.refresh();
  }, [router]);
}

export function PosShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const toHref = useSurfaceHref();
  const shell = useStaffShell();
  const runRefresh = useRunPosRefresh();
  const [helpOpen, setHelpOpen] = useState(false);
  const [navModifier, setNavModifier] = useState<'Ctrl' | 'Alt'>('Ctrl');

  // Only the screens this surface actually offers (no New order on a staff
  // website that may not take orders).
  const available = useMemo(() => {
    const nav = staffNav({
      surface: shell.surface,
      canTakeOrders: shell.canTakeOrders,
      staffPos: flags.staffPos,
      attendance: flags.attendance,
      inventory: flags.inventory,
      coffeePass: flags.coffeePass,
    });
    const hrefs = new Set(nav.primary.map((t) => t.href));
    return (href: string) => hrefs.has(href);
  }, [shell.surface, shell.canTakeOrders]);

  useEffect(() => {
    setNavModifier(isDesktopApp() ? 'Ctrl' : 'Alt');
  }, []);

  const latest = useRef({ available, pathname, toHref, runRefresh, router });
  latest.current = { available, pathname, toHref, runRefresh, router };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const action = shortcutFor({
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        repeat: e.repeat,
        inEditable: isEditable(e.target),
      });
      if (!action) return;
      const { available: has, pathname: path, toHref: href, runRefresh: refresh, router: r } = latest.current;

      // A refresh is harmless under a dialog; nothing else is.
      if (action.type !== 'refresh' && dialogOpen()) return;
      if (action.type === 'navigate' && !has(action.href)) return;

      for (let i = handlers.length - 1; i >= 0; i--) {
        if (handlers[i].current(action)) {
          e.preventDefault();
          return;
        }
      }

      switch (action.type) {
        case 'navigate': {
          e.preventDefault();
          const target = href(action.href);
          if (path === target) return; // already there
          startNavigation(action.href);
          r.push(target);
          return;
        }
        case 'refresh':
          e.preventDefault();
          refresh();
          return;
        case 'help':
          e.preventDefault();
          setHelpOpen((v) => !v);
          return;
        default:
          // focus-search / charge with no screen to take them: the browser's own.
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const open = () => setHelpOpen(true);
    window.addEventListener(SHOW_SHORTCUTS_EVENT, open);
    return () => window.removeEventListener(SHOW_SHORTCUTS_EVENT, open);
  }, []);

  const rows = shortcutHelpRows(available, navModifier);

  return (
    <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts" size="sm">
      <dl className="flex flex-col divide-y divide-line text-sm">
        {rows.map((row) => (
          <div key={row.keys} className="flex items-center justify-between gap-4 py-2">
            <dt className="text-charcoal">{row.label}</dt>
            <dd>
              <kbd className="whitespace-nowrap rounded border border-line bg-surface px-2 py-0.5 font-mono text-xs font-bold text-charcoal">
                {row.keys}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">
        {navModifier === 'Ctrl'
          ? 'In a browser tab, use Alt instead of Ctrl for the screen keys (the browser keeps Ctrl+N and Ctrl+T).'
          : 'In the HIOC POS app, Ctrl works too (Ctrl+N, Ctrl+T…).'}
      </p>
    </Modal>
  );
}
