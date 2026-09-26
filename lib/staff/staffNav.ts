// The staff header's navigation. It used to be one row of eight tabs plus six
// controls, which wrapped and overflowed on a counter tablet. Now:
//   - PRIMARY tabs, always visible: what the counter works from all day;
//   - MORE tabs, behind a "More" menu: back-office pages visited occasionally.
// Pure (flags are passed in) so the split is tested.

import { SETTINGS_ROOT } from '@/lib/staff/settingsNav';

export interface StaffTab {
  href: string;
  label: string;
}

export interface StaffNavFlags {
  staffPos: boolean;
  attendance: boolean;
}

export function primaryTabs(f: StaffNavFlags): StaffTab[] {
  return [
    { href: '/staff', label: 'Live orders' },
    { href: '/staff/orders', label: 'Orders' },
    // POS-1/POS-3: order entry + tables board, behind the staffPos flag.
    ...(f.staffPos
      ? [
          { href: '/staff/orders/new', label: 'New order' },
          { href: '/staff/tables', label: 'Tables' },
        ]
      : []),
  ];
}

export function moreTabs(f: StaffNavFlags): StaffTab[] {
  return [
    // OPS-2: cash drawer day-open/close by denomination.
    ...(f.staffPos ? [{ href: '/staff/cash', label: 'Cash' }] : []),
    // ATT-1 / LEAVE-3: their own flag — it stays dark until the geofence is tuned.
    ...(f.attendance
      ? [
          { href: '/staff/attendance', label: 'Attendance' },
          { href: '/staff/leave', label: 'Leave' },
        ]
      : []),
    { href: '/staff/menu', label: 'Menu' },
    // SET-1: every POS/counter setting. Always present, kept last.
    { href: SETTINGS_ROOT, label: 'Settings' },
  ];
}

/** `pathname` already resolved for the surface (pass `toHref(href)` as href on
 * a subdomain). Settings matches any section under it; every other tab only
 * its own exact path, so Orders doesn't light up on New order. */
export function isActiveTab(pathname: string, href: string, settingsHref: string = SETTINGS_ROOT): boolean {
  if (href === settingsHref) return pathname === href || pathname.startsWith(`${href}/`);
  return pathname === href;
}
