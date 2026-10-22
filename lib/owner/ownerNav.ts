// The owner header's navigation (components/owner/OwnerHeader.tsx).
//
//   Overview · Sales · Menu · Customers · Team · Setup     Staff board
//
//   Sales       Reports, Payments, Online orders, (Cash) — where the money is
//               counted and reconciled
//   Menu        Menu, Suggestions — the menu itself and the taste tags and
//               pairings Ask Coffey reads off it
//   Customers   Customers, Reviews, Feedback, then the offers made to them:
//               Promotions, (HIOC Ritual,) (Marketing)
//   Team        Team, (Attendance, Payroll) — the people and their time
//   Setup       Settings, Tables, Devices, Notifications — the cafe described
//               to the software, set once and checked now and then
//
// It used to be one row of up to 21 links that wrapped onto three lines on a
// laptop and scrolled sideways on a phone. Every page is still here; they are
// just grouped. Pure (flags passed in) so each combination is tested, like
// lib/staff/staffNav.ts.

import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';

export interface OwnerLink {
  href: string;
  label: string;
  /** One line under the label in the section panels: what the page is for. */
  description: string;
}

export interface OwnerNavGroup {
  /** Stable key, also used for element ids. */
  id: 'sales' | 'menu' | 'customers' | 'team' | 'setup';
  label: string;
  items: OwnerLink[];
}

export interface OwnerNavInput {
  /** NEXT_PUBLIC flags (lib/flags.ts). */
  coffeePass: boolean;
  marketing: boolean;
  attendance: boolean;
}

export interface OwnerNav {
  overview: OwnerLink;
  /** Never empty groups: a group whose pages are all flagged off is dropped. */
  groups: OwnerNavGroup[];
  /** The counter's live board — another surface, so it sits apart. */
  staffBoard: OwnerLink;
}

export const OWNER_ROOT = '/owner';
/** The Menu page carries the badge for staff menu changes waiting on the owner. */
export const OWNER_MENU_HREF = '/owner/menu';

const OVERVIEW: OwnerLink = { href: OWNER_ROOT, label: 'Overview', description: 'Today at a glance' };
const STAFF_BOARD: OwnerLink = { href: '/staff', label: 'Staff board', description: 'The counter’s live orders' };

export function ownerNav(input: OwnerNavInput): OwnerNav {
  const groups: OwnerNavGroup[] = [
    {
      id: 'sales',
      label: 'Sales',
      items: [
        // Reconcile any date range; GST, Insights and Downloads hang off it.
        { href: '/owner/reports', label: 'Reports', description: 'Sales, GST and downloads for any dates' },
        { href: '/owner/payments', label: 'Payments', description: 'Money in by method, last 30 days' },
        // Zomato/Swiggy payouts (docs/ONLINE-SETTLEMENTS.md): the delivery
        // apps' side of the same money, so next to Payments.
        { href: '/owner/online', label: 'Online orders', description: 'Zomato and Swiggy payouts' },
        // CC-4 (docs/PHASE-5-CASH-COUNTS.md). Behind the attendance flag as
        // before: the drawer count rides the clock-in/out punch.
        ...(input.attendance
          ? [{ href: '/owner/cash', label: 'Cash', description: 'Cash days, drawer counts and shortages' }]
          : []),
      ],
    },
    {
      id: 'menu',
      label: 'Menu',
      items: [
        // The owner's own editor plus the changes staff ask for on the POS.
        { href: OWNER_MENU_HREF, label: 'Menu', description: 'Edit items, approve staff changes' },
        // Phase-7 SUG-10. Always shown (not flag-gated): the owner needs the
        // Traits tab to tag the menu before NEXT_PUBLIC_FLAG_SUGGEST can go on.
        { href: '/owner/suggestions', label: 'Suggestions', description: 'Ask Coffey picks, pairings and taste tags' },
      ],
    },
    {
      id: 'customers',
      label: 'Customers',
      items: [
        { href: '/owner/customers', label: 'Customers', description: 'Regulars, new faces and top spenders' },
        { href: '/owner/reviews', label: 'Reviews', description: 'Star ratings to answer or hide' },
        { href: '/owner/feedback', label: 'Feedback', description: 'Replies to the after-order WhatsApp' },
        // Then the offers made to those customers: coupons you make by hand,
        // HIOC Ritual plans (CP-9) and the campaigns the marketing agent
        // prepares (docs/MARKETING-AGENT-SPEC.md). The last two are hidden
        // while their flag is off, like their pages.
        { href: '/owner/promotions', label: 'Promotions', description: 'Coupons and announcements' },
        ...(input.coffeePass
          ? [{ href: '/owner/passes', label: PASS_PROGRAM_NAME, description: 'Prepaid coffee plans' }]
          : []),
        ...(input.marketing
          ? [{ href: '/owner/marketing', label: 'Marketing', description: 'Campaigns the agent prepares for you' }]
          : []),
      ],
    },
    {
      id: 'team',
      label: 'Team',
      items: [
        { href: '/owner/staff', label: 'Team', description: 'Staff logins, roles and permissions' },
        // SHEET-1: dark until the geofence is tuned (lib/flags.ts).
        ...(input.attendance
          ? [
              { href: '/owner/attendance', label: 'Attendance', description: 'Punches, shifts and approvals' },
              { href: '/owner/payroll', label: 'Payroll', description: 'Monthly payslips and payouts' },
            ]
          : []),
      ],
    },
    {
      id: 'setup',
      label: 'Setup',
      items: [
        { href: '/owner/settings', label: 'Settings', description: 'Hours, GST, printing and feedback' },
        // The physical cafe described to the software: furniture, machines,
        // and the messages it sends.
        { href: '/owner/tables', label: 'Tables', description: 'Dine-in tables and their QR codes' },
        { href: '/owner/devices', label: 'Devices', description: 'Counter machines and their printers' },
        { href: '/owner/notifications', label: 'Notifications', description: 'Bill and order messages sent' },
      ],
    },
  ];
  return { overview: OVERVIEW, groups: groups.filter((g) => g.items.length > 0), staffBoard: STAFF_BOARD };
}

/**
 * `pathname` is the browser path and `href` the link's href already resolved
 * for the surface (`toHref(href)`: '/owner/menu' is '/menu' on owner.hioc.in).
 * The root resolves to a prefix of every owner page, so it must match exactly
 * (OWN-UX-1); every other link matches its own subtree, so Reports stays lit
 * on /owner/reports/gst and Feedback on a thread.
 */
export function isActiveOwnerLink(pathname: string, href: string, rootHref: string): boolean {
  if (href === rootHref) return pathname === href || pathname === `${href}/`;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The link for the page that is open, or null (e.g. a page not in the nav). */
export function activeOwnerLink(
  nav: OwnerNav,
  pathname: string,
  toHref: (href: string) => string = (h) => h,
): OwnerLink | null {
  const rootHref = toHref(OWNER_ROOT);
  const links = [nav.overview, ...nav.groups.flatMap((g) => g.items)];
  return links.find((l) => isActiveOwnerLink(pathname, toHref(l.href), rootHref)) ?? null;
}

/** The group holding the open page, or null (Overview belongs to none). */
export function activeOwnerGroup(
  nav: OwnerNav,
  pathname: string,
  toHref: (href: string) => string = (h) => h,
): OwnerNavGroup | null {
  const rootHref = toHref(OWNER_ROOT);
  return nav.groups.find((g) => g.items.some((l) => isActiveOwnerLink(pathname, toHref(l.href), rootHref))) ?? null;
}
