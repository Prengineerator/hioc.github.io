'use client';

// Owner header. It used to be one row of up to 21 links that wrapped onto three
// lines on a laptop and was a long sideways-scrolling pill row on a phone. Now:
//   lg+     HIOC · Owner | Overview  Sales ▾  Menu ▾  Customers ▾  Team ▾  Setup ▾ | Staff board ↗
//   below   HIOC · Owner ........ [☰ <current page>]  — the toggle opens a drawer
//           with every section laid out, nothing hidden behind a second tap
//
// WHAT is grouped under which heading lives in lib/owner/ownerNav.ts (pure, so
// each flag combination is tested); this file only draws it and runs the
// open/close behaviour.
//
// The section buttons are a disclosure navigation (WAI-ARIA APG "Disclosure
// Navigation Menu"): a button with aria-expanded that shows a plain list of
// links. They are deliberately NOT role="menu"/"menuitem" — those roles promise
// arrow-key navigation, type-ahead and a roving focus that this does not
// implement, and a screen-reader user who is told "menu" would press the arrow
// keys and get nothing. Tab walks the links in order, Escape closes and puts
// focus back on the button, which is all a list of links needs.
//
// One <nav> landmark covers both layouts: the desktop row and the phone drawer
// are two lists inside it, each hidden at the other's width. The phone toggle
// sits beside it (it is the button that shows or hides the nav, not a link in
// it). Closed panels stay in the markup with the `hidden` attribute rather than
// being unmounted, so their links are in the page for crawling/prefetch and the
// server and first client render are identical.

import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { SurfaceLink as Link, useSurfaceHref } from '@/components/SurfaceLink';
import { usePathname } from 'next/navigation';
import { flags } from '@/lib/flags';
import { MENU_PENDING_COUNT_EVENT } from '@/components/owner/menu/menuEvents';
import {
  OWNER_MENU_HREF,
  activeOwnerGroup,
  activeOwnerLink,
  ownerNav,
  type OwnerLink,
  type OwnerNavGroup,
} from '@/lib/owner/ownerNav';

type GroupId = OwnerNavGroup['id'];

/** The toggle's aria-controls target: the <nav>, which is the drawer below lg. */
const MOBILE_NAV_ID = 'owner-mobile-nav';

/** Closes a dropdown on an outside click or Escape (same as StaffHeader's). */
function useDismiss<T extends HTMLElement>(open: boolean, close: () => void, onEscape?: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      onEscape?.();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, onEscape]);
  return ref;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className={'ml-1 h-4 w-4 shrink-0 transition-transform' + (open ? ' rotate-180' : '')}
    >
      <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowUpRight() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0">
      <path d="M6 14 14 6M7.5 6H14v6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0">
      {open ? (
        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : (
        <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** Staff menu changes waiting for the owner. `active`: sitting on the charcoal "current" fill. */
function MenuBadge({ count, active }: { count: number; active: boolean }) {
  return (
    <span
      className={
        'ml-2 rounded-full px-1.5 py-0.5 text-[11px] font-bold ' +
        (active ? 'bg-cream text-charcoal' : 'bg-tan-dark text-cream')
      }
    >
      {count}
      <span className="sr-only"> menu changes waiting</span>
    </span>
  );
}

interface LinkProps {
  link: OwnerLink;
  active: boolean;
  /** Menu changes waiting; only the Menu page's link shows it (0 elsewhere). */
  pending: number;
  /** A tapped link always lands on closed menus, even when the page does not change. */
  onNavigate: () => void;
}

/** A top-level link in the desktop bar: Overview, or a group that has only one page. */
function BarLink({ link, active, pending, onNavigate }: LinkProps) {
  return (
    <Link
      href={link.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={
        'inline-flex min-h-[40px] items-center whitespace-nowrap rounded-md px-3 text-sm font-bold transition-colors ' +
        (active ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-surface')
      }
    >
      {link.label}
      {pending > 0 ? <MenuBadge count={pending} active={active} /> : null}
    </Link>
  );
}

/** A page in a section panel or the phone drawer: its name, and what it is for. */
function NavItemLink({ link, active, pending, onNavigate }: LinkProps) {
  return (
    <Link
      href={link.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={
        'relative block min-h-[44px] rounded-md px-3 py-2 transition-colors hover:bg-surface' +
        (active ? ' bg-surface' : '')
      }
    >
      {/* The open page's marker: tan is decoration only, so a bar, not text. */}
      {active ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-tan" /> : null}
      <span className="flex items-center text-sm font-bold text-charcoal">
        {link.label}
        {pending > 0 ? <MenuBadge count={pending} active={false} /> : null}
      </span>
      <span className="block text-xs text-muted">{link.description}</span>
    </Link>
  );
}

/** The counter's live board is another surface, so it is a button-like link set apart from the pages. */
function StaffBoardLink({ link, onNavigate, drawer }: { link: OwnerLink; onNavigate: () => void; drawer?: boolean }) {
  return (
    <Link
      href={link.href}
      onClick={onNavigate}
      className={
        'items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-3 text-sm font-bold text-charcoal transition-colors hover:bg-surface ' +
        (drawer ? 'flex min-h-[44px] w-full justify-between' : 'inline-flex min-h-[40px]')
      }
    >
      {link.label}
      <ArrowUpRight />
    </Link>
  );
}

interface GroupDisclosureProps {
  group: OwnerNavGroup;
  open: boolean;
  /** The open page is in this group. */
  current: boolean;
  /** href of the open page, to mark its row in the panel. */
  currentHref: string | undefined;
  pendingMenu: number;
  /** The last group opens leftwards so its panel cannot run off the right edge. */
  align: 'left' | 'right';
  onToggle: (id: GroupId) => void;
  onClose: (id: GroupId) => void;
  onNavigate: () => void;
}

/** One section button and its panel of pages (desktop). */
function GroupDisclosure({
  group,
  open,
  current,
  currentHref,
  pendingMenu,
  align,
  onToggle,
  onClose,
  onNavigate,
}: GroupDisclosureProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => onClose(group.id), [onClose, group.id]);
  // Escape from inside the panel would otherwise leave focus on a hidden link.
  const refocusTrigger = useCallback(() => triggerRef.current?.focus(), []);
  const ref = useDismiss<HTMLDivElement>(open, close, refocusTrigger);
  const panelId = `owner-nav-${group.id}`;
  const menuBadge = group.items.some((l) => l.href === OWNER_MENU_HREF) ? pendingMenu : 0;

  // Tabbing (or shift-tabbing) out of the group closes it. A blur with no
  // relatedTarget is a click on the panel's padding or the window losing focus;
  // the outside-click handler covers real outside clicks, so those stay open.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (open && next && !e.currentTarget.contains(next)) close();
  };

  return (
    <div ref={ref} className="relative" onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onToggle(group.id)}
        className={
          'inline-flex min-h-[40px] items-center whitespace-nowrap rounded-md px-3 text-sm font-bold transition-colors ' +
          (current ? 'bg-charcoal text-cream' : open ? 'bg-surface text-charcoal' : 'text-charcoal hover:bg-surface')
        }
      >
        {group.label}
        {current ? <span className="sr-only"> (current section)</span> : null}
        {menuBadge > 0 ? <MenuBadge count={menuBadge} active={current} /> : null}
        <Chevron open={open} />
      </button>
      {/* Hidden with the attribute (not unmounted, and no display class on this
          element so the attribute is not overridden). A plain list of links:
          see the header comment for why this is not role="menu". */}
      <ul
        id={panelId}
        hidden={!open}
        className={
          'absolute top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] animate-scale-in rounded-md border border-line bg-cream p-1.5 shadow-elevated ' +
          (align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left')
        }
      >
        {group.items.map((item) => (
          <li key={item.href}>
            <NavItemLink
              link={item}
              active={item.href === currentHref}
              pending={item.href === OWNER_MENU_HREF ? pendingMenu : 0}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OwnerHeader() {
  const pathname = usePathname();
  // See StaffHeader: compare the RESOLVED href, not the canonical one. On
  // owner.hioc.in '/owner/menu' is '/menu' and the root is '/'.
  const toHref = useSurfaceHref();
  const { coffeePass, marketing, attendance } = flags;
  const nav = useMemo(() => ownerNav({ coffeePass, marketing, attendance }), [coffeePass, marketing, attendance]);
  const currentLink = activeOwnerLink(nav, pathname, toHref);
  const currentGroup = activeOwnerGroup(nav, pathname, toHref);
  const currentHref = currentLink?.href;
  // Staff menu changes waiting for the owner, shown as a badge on the Menu page's link.
  const [pendingMenu, setPendingMenu] = useState(0);
  // At most one desktop section panel is open; the phone drawer is separate.
  const [openId, setOpenId] = useState<GroupId | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Functional updates, and closing only if that group is still the open one:
  // a blur from group A as focus moves to group B must not shut B.
  const toggleGroup = useCallback((id: GroupId) => setOpenId((cur) => (cur === id ? null : id)), []);
  const closeGroup = useCallback((id: GroupId) => setOpenId((cur) => (cur === id ? null : cur)), []);
  const closeAll = useCallback(() => {
    setOpenId(null);
    setMobileOpen(false);
  }, []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const refocusToggle = useCallback(() => toggleRef.current?.focus(), []);
  // The ref spans the toggle too: a tap on the toggle is "inside", so it only
  // runs its own onClick (otherwise the outside handler would close the drawer
  // on pointerdown and the click would immediately reopen it).
  const shellRef = useDismiss<HTMLDivElement>(mobileOpen, closeMobile, refocusToggle);

  // Menus are per-navigation: a tapped link always lands on closed menus.
  useEffect(() => {
    setOpenId(null);
    setMobileOpen(false);
  }, [pathname]);

  // One fetch on load (and when the tab regains focus); the Menu screen pushes
  // fresh counts through MENU_PENDING_COUNT_EVENT after each decision, so no
  // polling. A failed fetch just leaves the badge off.
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/owner/menu-requests?status=pending', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { pendingCount?: number } | null) => {
          if (alive && data && typeof data.pendingCount === 'number') setPendingMenu(data.pendingCount);
        })
        .catch(() => undefined);
    };
    const onCount = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      if (typeof n === 'number') setPendingMenu(n);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    load();
    window.addEventListener(MENU_PENDING_COUNT_EVENT, onCount);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.removeEventListener(MENU_PENDING_COUNT_EVENT, onCount);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const pendingFor = (link: OwnerLink) => (link.href === OWNER_MENU_HREF ? pendingMenu : 0);

  return (
    // Sticky so the section nav stays one tap away on the long overview.
    <header className="sticky top-0 z-30 border-b border-line bg-cream/95 backdrop-blur print:hidden">
      {/* Below lg this row wraps: brand and toggle on the first line, the <nav>
          (the drawer, full width) on the second. From lg the toggle is gone and
          the <nav> shares the first line. The padding is on the children, not
          the row, so the drawer's rule and scrollbar run edge to edge. */}
      <div ref={shellRef} className="mx-auto flex max-w-7xl flex-wrap items-center">
        <span className="shrink-0 whitespace-nowrap px-4 py-3 font-bold text-charcoal">HIOC · Owner</span>

        <button
          ref={toggleRef}
          type="button"
          aria-expanded={mobileOpen}
          aria-controls={MOBILE_NAV_ID}
          onClick={() => setMobileOpen((v) => !v)}
          className={
            'relative ml-auto mr-4 inline-flex min-h-[44px] max-w-[60%] items-center gap-2 rounded-md border border-line px-3 text-sm font-bold text-charcoal transition-colors hover:bg-surface lg:hidden' +
            (mobileOpen ? ' bg-surface' : '')
          }
        >
          <span className="sr-only">{currentLink ? 'Owner sections, current page: ' : 'Owner '}</span>
          <MenuIcon open={mobileOpen} />
          <span className="min-w-0 truncate">{currentLink ? currentLink.label : 'Sections'}</span>
          {!mobileOpen && pendingMenu > 0 ? (
            <>
              {/* On the hamburger's top-right corner, inside the button: the
                  toggle sits 2px from the top of the screen, so a dot hung off
                  its corner would be cut off. */}
              <span aria-hidden="true" className="absolute left-[1.625rem] top-1.5 h-2.5 w-2.5 rounded-full bg-tan-dark ring-2 ring-cream" />
              <span className="sr-only">, menu changes waiting</span>
            </>
          ) : null}
        </button>

        <nav
          id={MOBILE_NAV_ID}
          aria-label="Owner navigation"
          className={
            (mobileOpen ? 'block ' : 'hidden ') +
            'max-h-[calc(100dvh-4rem)] w-full overflow-y-auto border-t border-line px-4 pb-4 ' +
            'lg:block lg:max-h-none lg:w-auto lg:flex-1 lg:overflow-visible lg:border-0 lg:pb-0 lg:pl-0 lg:pr-4'
          }
        >
          {/* lg and up: one row of links and section buttons, Staff board pushed right. */}
          <ul className="hidden items-center gap-1 lg:flex">
            <li>
              <BarLink link={nav.overview} active={nav.overview.href === currentHref} pending={0} onNavigate={closeAll} />
            </li>
            {nav.groups.map((g, i) => (
              <li key={g.id}>
                {g.items.length === 1 ? (
                  // A section with one page is just that page's link.
                  <BarLink
                    link={g.items[0]}
                    active={g.items[0].href === currentHref}
                    pending={pendingFor(g.items[0])}
                    onNavigate={closeAll}
                  />
                ) : (
                  <GroupDisclosure
                    group={g}
                    open={openId === g.id}
                    current={currentGroup?.id === g.id}
                    currentHref={currentHref}
                    pendingMenu={pendingMenu}
                    align={i === nav.groups.length - 1 ? 'right' : 'left'}
                    onToggle={toggleGroup}
                    onClose={closeGroup}
                    onNavigate={closeAll}
                  />
                )}
              </li>
            ))}
            <li className="ml-auto">
              <StaffBoardLink link={nav.staffBoard} onNavigate={closeAll} />
            </li>
          </ul>

          {/* Below lg: every section laid out, even one-page sections (under a
              heading), so nothing is a second tap away. */}
          <div className="animate-fade-in lg:hidden">
            <ul className="pt-3">
              <li>
                <NavItemLink
                  link={nav.overview}
                  active={nav.overview.href === currentHref}
                  pending={0}
                  onNavigate={closeAll}
                />
              </li>
            </ul>
            {nav.groups.map((g) => {
              const headingId = `${MOBILE_NAV_ID}-${g.id}-heading`;
              return (
                <div key={g.id} className="mt-4">
                  <p id={headingId} className="px-3 text-xs font-bold uppercase tracking-wide text-muted">
                    {g.label}
                  </p>
                  <ul aria-labelledby={headingId} className="mt-1 grid gap-1 sm:grid-cols-2">
                    {g.items.map((item) => (
                      <li key={item.href}>
                        <NavItemLink
                          link={item}
                          active={item.href === currentHref}
                          pending={pendingFor(item)}
                          onNavigate={closeAll}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <div className="mt-4 border-t border-line pt-3">
              <StaffBoardLink link={nav.staffBoard} onNavigate={closeAll} drawer />
            </div>
          </div>
        </nav>
      </div>
    </header>
  );
}
