// The staff header's navigation, per surface (lib/staff/surfaceRules.ts).
//
//   POS          Live orders · Orders · Settle · New order · Tables — what the
//                counter does all day — and Cash, Attendance, Leave, (Stock,)
//                Menu and Settings under "More".
//   staff site   Live orders · Orders · Settle, plus New order and Tables only when
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
  /** Under the "More" menu. */
  more: StaffTab[];
  /** Extra links in the account menu. */
  account: StaffTab[];
}

const LIVE: StaffTab = { href: '/staff', label: 'Live orders' };
const ORDERS: StaffTab = { href: '/staff/orders', label: 'Orders' };
const SETTLE: StaffTab = { href: '/staff/settle', label: 'Settle' };
const NEW_ORDER: StaffTab = { href: '/staff/orders/new', label: 'New order' };
const TABLES: StaffTab = { href: '/staff/tables', label: 'Tables' };
const MENU: StaffTab = { href: '/staff/menu', label: 'Menu' };
const SETTINGS: StaffTab = { href: SETTINGS_ROOT, label: 'Settings' };
const STOCK: StaffTab = { href: '/staff/inventory', label: 'Stock' };

/** The occasional pages both surfaces keep under "More". */
function backOffice(input: StaffNavInput): StaffTab[] {
  return [
    // OPS-2: cash drawer day-open/close by denomination.
    ...(input.staffPos ? [{ href: '/staff/cash', label: 'Cash' }] : []),
    // ATT-1 / LEAVE-3: their own flag — dark until the geofence is tuned.
    ...(input.attendance
      ? [
          { href: '/staff/attendance', label: 'Attendance' },
          { href: '/staff/leave', label: 'Leave' },
        ]
      : []),
    // Inventory (docs/INVENTORY-SPEC.md): requests, verifying deliveries at
    // the POS, recipes.
    ...(input.inventory ? [STOCK] : []),
  ];
}

export function staffNav(input: StaffNavInput): StaffNav {
  if (input.surface === 'pos') {
    return {
      primary: [LIVE, ORDERS, SETTLE, ...(input.staffPos ? [NEW_ORDER, TABLES] : [])],
      more: [...backOffice(input), MENU, SETTINGS],
      account: [],
    };
  }
  return {
    primary: [LIVE, ORDERS, SETTLE, ...(input.staffPos && input.canTakeOrders ? [NEW_ORDER, TABLES] : [])],
    more: [...backOffice(input), MENU, SETTINGS],
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
