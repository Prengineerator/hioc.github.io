// The staff header's navigation, per surface (lib/staff/surfaceRules.ts).
//
//   POS          Live orders · Orders · New order · Menu (· Stock) — what the
//                counter does. Settings (printers live there) sits in the
//                account menu. Stock is where deliveries are verified, so the
//                counter needs it one tap away.
//   staff site   Live orders · Orders, plus New order and Tables only when
//                taking orders on the staff website is switched on; the
//                back-office pages under "More".
//
// It used to be one row of eight tabs plus six controls, which overflowed on
// a counter tablet. Pure (flags passed in) so each surface's nav is tested.

import { SETTINGS_ROOT } from '@/lib/staff/settingsNav';
import type { StaffSurface } from '@/lib/staff/surfaceRules';

export interface StaffTab {
  href: string;
  label: string;
}

export interface StaffNavInput {
  surface: StaffSurface;
  canTakeOrders: boolean;
  /** NEXT_PUBLIC flags (lib/flags.ts). */
  staffPos: boolean;
  attendance: boolean;
  /** Inventory (docs/INVENTORY-SPEC.md); optional so older callers read off. */
  inventory?: boolean;
}

export interface StaffNav {
  primary: StaffTab[];
  /** Under the "More" menu. Empty on the POS. */
  more: StaffTab[];
  /** Extra links in the account menu (the POS's Settings). */
  account: StaffTab[];
}

const LIVE: StaffTab = { href: '/staff', label: 'Live orders' };
const ORDERS: StaffTab = { href: '/staff/orders', label: 'Orders' };
const NEW_ORDER: StaffTab = { href: '/staff/orders/new', label: 'New order' };
const TABLES: StaffTab = { href: '/staff/tables', label: 'Tables' };
const MENU: StaffTab = { href: '/staff/menu', label: 'Menu' };
const SETTINGS: StaffTab = { href: SETTINGS_ROOT, label: 'Settings' };
const STOCK: StaffTab = { href: '/staff/inventory', label: 'Stock' };

export function staffNav(input: StaffNavInput): StaffNav {
  if (input.surface === 'pos') {
    return {
      primary: [LIVE, ORDERS, ...(input.staffPos ? [NEW_ORDER] : []), MENU, ...(input.inventory ? [STOCK] : [])],
      more: [],
      account: [SETTINGS],
    };
  }
  return {
    primary: [LIVE, ORDERS, ...(input.staffPos && input.canTakeOrders ? [NEW_ORDER, TABLES] : [])],
    more: [
      // OPS-2: cash drawer day-open/close by denomination.
      ...(input.staffPos ? [{ href: '/staff/cash', label: 'Cash' }] : []),
      // ATT-1 / LEAVE-3: their own flag — dark until the geofence is tuned.
      ...(input.attendance
        ? [
            { href: '/staff/attendance', label: 'Attendance' },
            { href: '/staff/leave', label: 'Leave' },
          ]
        : []),
      ...(input.inventory ? [STOCK] : []),
      MENU,
      SETTINGS,
    ],
    account: [],
  };
}

/** `pathname` already resolved for the surface (pass `toHref(href)` as href on
 * a subdomain). Settings matches any section under it; every other tab only
 * its own exact path, so Orders doesn't light up on New order. */
export function isActiveTab(pathname: string, href: string, settingsHref: string = SETTINGS_ROOT): boolean {
  if (href === settingsHref) return pathname === href || pathname.startsWith(`${href}/`);
  return pathname === href;
}
