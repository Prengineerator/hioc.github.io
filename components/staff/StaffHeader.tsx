'use client';

import Image from 'next/image';
import { SurfaceLink as Link, useSurfaceHref } from '@/components/SurfaceLink';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { StoreOpenState } from '@/lib/store/hours';
import { flags } from '@/lib/flags';
import { logoutButtonLabel, logoutDestination } from '@/lib/staff/pinUi';
import { isActiveSettingsSection, SETTINGS_ROOT } from '@/lib/staff/settingsNav';
import { COUNTER_MODE_HREFS } from '@/lib/staff/newOrderWatch';
import { useStaffShell } from '@/components/staff/StaffShell';

const TABS = [
  { href: '/staff', label: 'Orders' },
  // POS-1/POS-3: the counter-tablet order-entry surface + tables board. Only
  // shown when the staffPos flag is on (default ON, NEXT_PUBLIC_FLAG_STAFF_POS=
  // false to hide both).
  ...(flags.staffPos
    ? [
        { href: '/staff/orders/new', label: 'New order' },
        { href: '/staff/tables', label: 'Tables' },
        // OPS-2: cash drawer day-open/close by denomination.
        { href: '/staff/cash', label: 'Cash' },
      ]
    : []),
  // ATT-1: attendance. Its own flag, not staffPos — clocking in has nothing to
  // do with whether the counter POS is enabled, and it stays dark until the
  // geofence is tuned on site.
  ...(flags.attendance
    ? [
        { href: '/staff/attendance', label: 'Attendance' },
        // LEAVE-3. Under /staff, not /owner, because managers approve here and
        // /owner/** is owner-only.
        { href: '/staff/leave', label: 'Leave' },
      ]
    : []),
  { href: '/staff/menu', label: 'Menu' },
  // SET-1 — every POS/counter setting (printers & cash drawer, store,
  // this counter's device enrolment) lives under /staff/settings now.
  // Always shown, even in a plain browser tab with no desktop bridge: staff
  // need to be able to find it to learn what needs the HIOC POS desktop app
  // (PrinterSettings explains why when there's no bridge). Kept last.
  { href: SETTINGS_ROOT, label: 'Settings' },
];

export interface StaffPinControls {
  /** "Switch" once an operator is known, "Lock" beforehand (StaffPinOverlay
   * decides which — this component just renders the label it's given). */
  label: 'Switch' | 'Lock';
  onLock: () => void;
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
  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  const [openState, setOpenState] = useState<StoreOpenState | null>(null);
  // Mobile nav (< md): the tab row + account controls that sit inline on a
  // tablet/desktop header don't fit a 360–414px phone, so below md they move
  // into a collapsible drawer behind a hamburger button instead.
  const [menuOpen, setMenuOpen] = useState(false);

  // Counter mode trims the nav to what the counter works from — Orders, New
  // order, Tables — instead of hiding it (it used to cover the whole screen
  // with the Orders board, leaving no way to the other two).
  const shell = useStaffShell();
  const tabs = shell.counterMode ? TABS.filter((t) => COUNTER_MODE_HREFS.includes(t.href)) : TABS;
  const tabLabel = (tab: { href: string; label: string }) =>
    tab.href === '/staff' && shell.newOrderCount > 0 ? (
      <>
        {tab.label}{' '}
        <span className="ml-1 rounded-full bg-tan px-1.5 py-0.5 text-[11px] font-bold text-charcoal">
          {shell.newOrderCount} new
        </span>
      </>
    ) : (
      tab.label
    );

  const soundButton = (
    <button
      type="button"
      onClick={shell.toggleSound}
      aria-pressed={shell.soundOn}
      title={shell.soundOn && !shell.soundReady ? 'Tap anywhere to allow the order alarm' : undefined}
      className={
        'rounded-md border px-3 py-2 text-xs font-bold transition-colors ' +
        (!shell.soundOn
          ? 'border-cream/30 text-cream/60 hover:text-cream'
          : shell.soundReady
            ? 'border-cream/40 text-cream hover:bg-cream hover:text-charcoal'
            : 'border-amber-400 bg-amber-50 text-amber-800')
      }
    >
      {!shell.soundOn ? '🔕 Sound off' : shell.soundReady ? '🔔 Sound on' : '🔔 Tap to enable sound'}
    </button>
  );

  const counterModeButton = (
    <button
      type="button"
      onClick={() => shell.setCounterMode(!shell.counterMode)}
      aria-pressed={shell.counterMode}
      className={
        'rounded-md border px-3 py-2 text-xs font-bold transition-colors ' +
        (shell.counterMode
          ? 'border-tan bg-tan text-charcoal'
          : 'border-cream/40 text-cream hover:bg-cream hover:text-charcoal')
      }
    >
      {shell.counterMode ? 'Exit counter mode' : 'Counter mode'}
    </button>
  );

  // S7: live "is the store taking orders" badge, doubling as a quick link to
  // /staff/settings/store (SET-1 — moved off the Menu page). Best-effort — a failed fetch
  // just leaves the badge hidden. Refreshed on a poll, on window focus, and
  // instantly when the Store controls fire 'hioc:store-changed', so it never
  // goes stale after an override/pause toggle (or a time-based open/close).
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

  // PIN-2 — the owner's report: on an enrolled PIN counter, "Logout" was
  // leaving the operator cookie in place AND sending the browser to the
  // classic sign-in form instead of back to the PIN lock screen. Both bugs
  // trace to this function only ever having cleared/known about the classic
  // session. Fixed by always clearing BOTH credential types (best-effort —
  // whichever one wasn't in use is simply a no-op to clear, same as DELETE
  // /api/device/operator already promises), then routing based on whether
  // this counter is PIN-capable (`pinControls` is only ever handed to this
  // component under exactly that condition — see StaffPinOverlay).
  async function handleLogout() {
    await Promise.allSettled([
      fetch('/api/device/operator', { method: 'DELETE' }),
      fetch('/api/auth/logout', { method: 'POST' }),
    ]);

    const { href, hardReload } = logoutDestination(Boolean(pinControls));
    if (hardReload) {
      // A full navigation, not router.push: only a fresh request re-runs
      // getCounterActor()/getEnrolledDevice() on the server and renders the
      // full-screen LockScreen — a client-side push would land on whatever
      // the router already has cached for this route.
      window.location.assign(toHref(href));
    } else {
      router.push(toHref(href));
    }
  }

  const logoutLabel = logoutButtonLabel(Boolean(pinControls));

  // The drawer is per-navigation, not per-render — a tapped link (or a route
  // change from anywhere else, e.g. router.push after logout) should always
  // leave it closed on the next screen rather than reopened over it.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const storeBadge = openState ? (
    <Link
      href="/staff/settings/store"
      onClick={() => setMenuOpen(false)}
      className={
        'inline-block rounded-md px-3 py-2 text-xs font-bold transition-colors ' +
        (openState.acceptingOrders
          ? 'bg-[#e8f3ea] text-[#2f6b38] hover:opacity-80'
          : 'bg-[#f6efe9] text-tan-dark hover:opacity-80')
      }
    >
      {openState.acceptingOrders
        ? 'Store: Accepting'
        : openState.reason === 'paused'
          ? 'Store: Paused'
          : 'Store: Closed'}
    </Link>
  ) : null;

  return (
    <header className="sticky top-0 z-40 bg-charcoal text-cream">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2">
            <Image
              src="/images/logo-light.png"
              alt="HIOC."
              width={480}
              height={291}
              className="h-7 w-auto object-contain"
            />
            <span className="text-sm font-normal text-cream/60">Staff</span>
          </span>
          {/* Tablet/desktop tab row — unchanged from before; just hidden below
              md, where it moves into the drawer instead. */}
          <nav className="hidden md:block">
            <ul className="flex items-center gap-4 text-sm">
              {tabs.map((tab) => {
                // Every other tab matches only its own exact path; the
                // Settings tab (SET-1) matches any /staff/settings/** path,
                // via the same helper the settings sidebar itself uses.
                const isActive =
                  tab.href === SETTINGS_ROOT
                    ? isActiveSettingsSection(pathname, toHref(tab.href))
                    : pathname === toHref(tab.href);
                return (
                  <li key={tab.href}>
                    <Link
                      href={tab.href}
                      className={
                        'border-b-2 pb-1 transition-colors ' +
                        (isActive
                          ? 'border-tan text-tan'
                          : 'border-transparent text-cream/70 hover:text-cream')
                      }
                    >
                      {tabLabel(tab)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        {/* Tablet/desktop account controls — unchanged, hidden below md. */}
        <div className="hidden items-center gap-3 md:flex">
          {soundButton}
          {counterModeButton}
          {storeBadge}
          <div className="text-right leading-tight" title={userEmail}>
            <div className="max-w-[36vw] truncate text-xs font-medium text-cream sm:max-w-none">
              {userName || userEmail || 'Signed in'}
            </div>
            {roleLabel ? (
              <div className="text-[10px] uppercase tracking-wide text-cream/50">{roleLabel}</div>
            ) : null}
          </div>
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

        {/* Phone hamburger — the tab row + account controls above don't fit a
            360–414px header, so they collapse into the drawer below instead of
            wrapping or overflowing. min 40px square tap target. */}
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

      {/* Phone drawer: tab list + store badge + account + logout, all stacked
          so every tap target stays full-width and ≥40px tall. */}
      {menuOpen ? (
        <div id="staff-mobile-menu" className="border-t border-cream/10 px-4 pb-4 md:hidden">
          <nav>
            <ul className="flex flex-col gap-1 pt-3 text-sm">
              {tabs.map((tab) => {
                // Every other tab matches only its own exact path; the
                // Settings tab (SET-1) matches any /staff/settings/** path,
                // via the same helper the settings sidebar itself uses.
                const isActive =
                  tab.href === SETTINGS_ROOT
                    ? isActiveSettingsSection(pathname, toHref(tab.href))
                    : pathname === toHref(tab.href);
                return (
                  <li key={tab.href}>
                    <Link
                      href={tab.href}
                      className={
                        'block rounded-md px-3 py-2.5 font-bold transition-colors ' +
                        (isActive
                          ? 'bg-cream/10 text-tan'
                          : 'text-cream/80 hover:bg-cream/5 hover:text-cream')
                      }
                    >
                      {tabLabel(tab)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="mt-3 flex flex-col gap-3 border-t border-cream/10 pt-3">
            <div className="flex flex-wrap gap-2">
              {soundButton}
              {counterModeButton}
            </div>
            {storeBadge}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 leading-tight" title={userEmail}>
                <div className="truncate text-xs font-medium text-cream">
                  {userName || userEmail || 'Signed in'}
                </div>
                {roleLabel ? (
                  <div className="text-[10px] uppercase tracking-wide text-cream/50">{roleLabel}</div>
                ) : null}
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
