'use client';

// Staff header. It used to be one row of eight tabs plus the store badge,
// sound, counter mode, name/role, Lock and Logout, which wrapped and pushed
// options off-screen on a counter tablet. Now:
//   left   logo · Live orders · Orders · New order · Tables · More ▾
//   right  store pill · sound icon · counter-mode icon · account ▾
// The back-office pages (Cash, Attendance, Leave, Menu, Settings) live under
// "More"; name, role, Lock/Switch and Logout under the account menu. Below md
// everything folds into the drawer, with the sound icon kept in the bar
// because it is the one control a counter needs at a glance.
// Tab lists: lib/staff/staffNav.ts. Sound and counter mode: StaffShell.

import Image from 'next/image';
import { SurfaceLink as Link, useSurfaceHref } from '@/components/SurfaceLink';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoreOpenState } from '@/lib/store/hours';
import { flags } from '@/lib/flags';
import { logoutButtonLabel, logoutDestination } from '@/lib/staff/pinUi';
import { COUNTER_MODE_HREFS } from '@/lib/staff/newOrderWatch';
import { isActiveTab, staffNav, type StaffTab } from '@/lib/staff/staffNav';
import { SETTINGS_ROOT } from '@/lib/staff/settingsNav';
import { useStaffShell } from '@/components/staff/StaffShell';


export interface StaffPinControls {
  /** "Switch" once an operator is known, "Lock" beforehand (StaffPinOverlay
   * decides which — this component just renders the label it's given). */
  label: 'Switch' | 'Lock';
  onLock: () => void;
}

/** Closes a dropdown on an outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

export function StaffHeader({
  userEmail,
  userName,
  role,
  pinControls,
}: {
  userEmail: string;
  userName?: string;
  role: string;
  /** PIN-2 — present only on an enrolled device with the flag on, inside the
   * desktop app (StaffPinOverlay decides all of that; this component only
   * renders the button when it's handed one). Omitted everywhere else, so
   * every other caller of StaffHeader is completely unaffected. */
  pinControls?: StaffPinControls;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // usePathname() reports the BROWSER's path, which on staff.hioc.in is
  // '/orders' while the tab href is '/staff/orders'. Compare like with like or
  // no tab ever highlights on the subdomain.
  const toHref = useSurfaceHref();
  const shell = useStaffShell();
  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  const displayName = userName || userEmail || 'Signed in';
  const [openState, setOpenState] = useState<StoreOpenState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false); // phone drawer
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const closeAccount = useCallback(() => setAccountOpen(false), []);
  const moreRef = useDismiss(moreOpen, closeMore);
  const accountRef = useDismiss(accountOpen, closeAccount);

  // Counter mode keeps only what the counter works from, and no More menu.
  // POS vs staff website (lib/staff/staffNav.ts); counter mode then keeps only
  // what the counter works from, and no More menu.
  const nav = staffNav({
    surface: shell.surface,
    canTakeOrders: shell.canTakeOrders,
    staffPos: flags.staffPos,
    attendance: flags.attendance,
  });
  const primary = shell.counterMode ? nav.primary.filter((t) => COUNTER_MODE_HREFS.includes(t.href)) : nav.primary;
  const more = shell.counterMode ? [] : nav.more;
  const active = (tab: StaffTab) => isActiveTab(pathname, toHref(tab.href), toHref(SETTINGS_ROOT));
  const moreActive = more.find(active);

  // S7: live "is the store taking orders" badge, doubling as a quick link to
  // /staff/settings/store. Best-effort — a failed fetch just hides it.
  // Refreshed on a poll, on focus, and on 'hioc:store-changed'.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/store-settings', { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) setOpenState(data.openState ?? null);
        })
        .catch(() => {});
    };
    load();
    const poll = setInterval(load, 15000);
    window.addEventListener('focus', load);
    window.addEventListener('hioc:store-changed', load);
    return () => {
      cancelled = true;
      clearInterval(poll);
      window.removeEventListener('focus', load);
      window.removeEventListener('hioc:store-changed', load);
    };
  }, []);

  // PIN-2 — always clear BOTH credential types (whichever wasn't in use is a
  // no-op), then route to the PIN lock screen on a PIN counter or to the
  // classic sign-in everywhere else.
  async function handleLogout() {
    await Promise.allSettled([
      fetch('/api/device/operator', { method: 'DELETE' }),
      fetch('/api/auth/logout', { method: 'POST' }),
    ]);

    const { href, hardReload } = logoutDestination(Boolean(pinControls));
    if (hardReload) {
      // A full navigation re-runs getCounterActor()/getEnrolledDevice() on the
      // server and renders the LockScreen; a client push would reuse the cache.
      window.location.assign(toHref(href));
    } else {
      router.push(toHref(href));
    }
  }

  const logoutLabel = logoutButtonLabel(Boolean(pinControls));

  // Menus are per-navigation: a tapped link always lands on a closed menu.
  useEffect(() => {
    setMenuOpen(false);
    setMoreOpen(false);
    setAccountOpen(false);
  }, [pathname]);

  const storePill = openState ? (
    <Link
      href="/staff/settings/store"
      title="Store status: tap to change"
      className={
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold transition-opacity hover:opacity-80 ' +
        (openState.acceptingOrders ? 'bg-[#e8f3ea] text-[#2f6b38]' : 'bg-[#f6efe9] text-tan-dark')
      }
    >
      <span
        aria-hidden
        className={'inline-block h-2 w-2 rounded-full ' + (openState.acceptingOrders ? 'bg-[#2f6b38]' : 'bg-tan-dark')}
      />
      {openState.acceptingOrders ? 'Open' : openState.reason === 'paused' ? 'Paused' : 'Closed'}
    </Link>
  ) : null;

  const soundLabel = !shell.soundOn
    ? 'Order alarm off: tap to turn on'
    : shell.soundReady
      ? 'Order alarm on: tap to turn off'
      : 'Tap to allow the order alarm sound';
  const soundButton = (
    <button
      type="button"
      onClick={shell.toggleSound}
      aria-pressed={shell.soundOn}
      aria-label={soundLabel}
      title={soundLabel}
      className={
        'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md border text-lg transition-colors ' +
        (!shell.soundOn
          ? 'border-cream/30 text-cream/50 hover:text-cream'
          : shell.soundReady
            ? 'border-cream/30 hover:bg-cream/10'
            : 'border-amber-400 bg-amber-400/20')
      }
    >
      <span aria-hidden>{shell.soundOn ? '🔔' : '🔕'}</span>
      {shell.soundOn && !shell.soundReady ? (
        <span aria-hidden className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-amber-400" />
      ) : null}
    </button>
  );

  const counterLabel = shell.counterMode ? 'Exit counter mode' : 'Counter mode: full screen, screen stays on';
  const counterButton = (
    <button
      type="button"
      onClick={() => shell.setCounterMode(!shell.counterMode)}
      aria-pressed={shell.counterMode}
      aria-label={counterLabel}
      title={counterLabel}
      className={
        'flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-sm font-bold transition-colors ' +
        (shell.counterMode ? 'border-tan bg-tan text-charcoal' : 'border-cream/30 text-cream hover:bg-cream/10')
      }
    >
      <span aria-hidden>⛶</span>
      {shell.counterMode ? <span>Exit</span> : null}
    </button>
  );

  const tabLabel = (tab: StaffTab) =>
    tab.href === '/staff' && shell.newOrderCount > 0 ? (
      <>
        {tab.label}
        <span className="ml-1.5 rounded-full bg-tan px-1.5 py-0.5 text-[11px] font-bold text-charcoal">
          {shell.newOrderCount}
        </span>
      </>
    ) : (
      tab.label
    );

  return (
    <header className="sticky top-0 z-40 bg-charcoal text-cream">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-5">
          <Image
            src="/images/logo-light.png"
            alt="HIOC. Staff"
            width={480}
            height={291}
            className="h-7 w-auto shrink-0 object-contain"
          />
          <nav className="hidden md:block" aria-label="Staff">
            <ul className="flex items-center gap-1 text-sm">
              {primary.map((tab) => (
                <li key={tab.href}>
                  <Link
                    href={tab.href}
                    aria-current={active(tab) ? 'page' : undefined}
                    className={
                      'flex items-center whitespace-nowrap rounded-md px-3 py-2 font-bold transition-colors ' +
                      (active(tab) ? 'bg-cream/10 text-tan' : 'text-cream/75 hover:bg-cream/5 hover:text-cream')
                    }
                  >
                    {tabLabel(tab)}
                  </Link>
                </li>
              ))}
              {more.length > 0 ? (
                <li>
                  <div ref={moreRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setMoreOpen((v) => !v)}
                      aria-expanded={moreOpen}
                      aria-haspopup="menu"
                      className={
                        'flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2 font-bold transition-colors ' +
                        (moreActive ? 'bg-cream/10 text-tan' : 'text-cream/75 hover:bg-cream/5 hover:text-cream')
                      }
                    >
                      {moreActive ? moreActive.label : 'More'} <span aria-hidden>▾</span>
                    </button>
                    {moreOpen ? (
                      <ul
                        role="menu"
                        className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-md border border-cream/10 bg-charcoal py-1 shadow-lg"
                      >
                        {more.map((tab) => (
                          <li key={tab.href} role="none">
                            <Link
                              href={tab.href}
                              role="menuitem"
                              className={
                                'block px-4 py-2.5 text-sm font-bold ' +
                                (active(tab) ? 'text-tan' : 'text-cream/85 hover:bg-cream/5 hover:text-cream')
                              }
                            >
                              {tab.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </li>
              ) : null}
            </ul>
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden lg:inline-flex">{storePill}</span>
          {soundButton}
          <span className="hidden md:inline-flex">{counterButton}</span>

          {/* Account menu — name, role, Lock/Switch, Logout. md+ only; the
              drawer carries them on a phone. */}
          <div ref={accountRef} className="relative hidden md:block">
            <button
              type="button"
              onClick={() => setAccountOpen((v) => !v)}
              aria-expanded={accountOpen}
              aria-haspopup="menu"
              title={userEmail}
              className="flex h-10 max-w-[180px] items-center gap-2 rounded-md border border-cream/30 px-2.5 text-sm hover:bg-cream/10"
            >
              <span
                aria-hidden
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-tan text-xs font-bold text-charcoal"
              >
                {displayName.charAt(0).toUpperCase()}
              </span>
              <span className="hidden truncate font-medium xl:inline">{displayName}</span>
              <span aria-hidden>▾</span>
            </button>
            {accountOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 w-60 rounded-md border border-cream/10 bg-charcoal p-3 shadow-lg"
              >
                <p className="truncate text-sm font-bold text-cream">{displayName}</p>
                {roleLabel ? <p className="text-[11px] uppercase tracking-wide text-cream/50">{roleLabel}</p> : null}
                {userEmail && userName ? <p className="truncate text-xs text-cream/50">{userEmail}</p> : null}
                <div className="mt-3 lg:hidden">{storePill}</div>
                {nav.account.length > 0 ? (
                  <ul className="mt-3 border-t border-cream/10 pt-2">
                    {nav.account.map((tab) => (
                      <li key={tab.href}>
                        <Link
                          href={tab.href}
                          role="menuitem"
                          className={
                            'block rounded-md px-2 py-2 text-sm font-bold ' +
                            (active(tab) ? 'text-tan' : 'text-cream/85 hover:bg-cream/5 hover:text-cream')
                          }
                        >
                          {tab.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-3 flex flex-col gap-2">
                  {pinControls ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={pinControls.onLock}
                      className="rounded-md border border-tan/60 px-4 py-2 text-sm font-bold text-tan transition-colors hover:bg-tan hover:text-charcoal"
                    >
                      {pinControls.label}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleLogout}
                    className="rounded-md border border-cream/40 px-4 py-2 text-sm text-cream transition-colors hover:bg-cream hover:text-charcoal"
                  >
                    {logoutLabel}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Phone hamburger (< md). */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-controls="staff-mobile-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-cream/30 text-cream md:hidden"
          >
            <span aria-hidden className="text-xl leading-none">
              {menuOpen ? '×' : '☰'}
            </span>
          </button>
        </div>
      </div>

      {/* Phone drawer: every tab, then the controls, full-width tap targets. */}
      {menuOpen ? (
        <div id="staff-mobile-menu" className="border-t border-cream/10 px-4 pb-4 md:hidden">
          <nav aria-label="Staff">
            <ul className="flex flex-col gap-1 pt-3 text-sm">
              {[...primary, ...more, ...nav.account].map((tab) => (
                <li key={tab.href}>
                  <Link
                    href={tab.href}
                    aria-current={active(tab) ? 'page' : undefined}
                    className={
                      'flex items-center rounded-md px-3 py-2.5 font-bold transition-colors ' +
                      (active(tab) ? 'bg-cream/10 text-tan' : 'text-cream/80 hover:bg-cream/5 hover:text-cream')
                    }
                  >
                    {tabLabel(tab)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="mt-3 flex flex-col gap-3 border-t border-cream/10 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              {counterButton}
              {storePill}
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 leading-tight" title={userEmail}>
                <div className="truncate text-xs font-medium text-cream">{displayName}</div>
                {roleLabel ? <div className="text-[10px] uppercase tracking-wide text-cream/50">{roleLabel}</div> : null}
              </div>
              <div className="flex shrink-0 gap-2">
                {pinControls ? (
                  <button
                    type="button"
                    onClick={pinControls.onLock}
                    className="rounded-md border border-tan/60 px-4 py-2 text-sm font-bold text-tan transition-colors hover:bg-tan hover:text-charcoal"
                  >
                    {pinControls.label}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={handleLogout}
                  className="rounded-md border border-cream/40 px-4 py-2 text-sm text-cream transition-colors hover:bg-cream hover:text-charcoal"
                >
                  {logoutLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
