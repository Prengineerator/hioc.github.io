// Where a staff screen is running decides what it may do.
//
//   'pos'  an enrolled counter device (the HIOC POS app) — takes orders and is
//          the only place the menu can be changed;
//   'web'  the staff website on any other browser (a phone, a laptop) — sees
//          orders and the live board; takes orders only when the owner or a
//          manager has switched store_settings.staff_web_ordering on (off by
//          default), and never edits the menu.
//
// Pure: the server resolves the surface (lib/staff/surface.ts) and every API
// route and screen applies these same rules.

export type StaffSurface = 'pos' | 'web';

export function canTakeOrders(surface: StaffSurface, staffWebOrdering: boolean | null | undefined): boolean {
  return surface === 'pos' || staffWebOrdering === true;
}

export function canEditMenu(surface: StaffSurface): boolean {
  return surface === 'pos';
}

export const ORDERING_OFF_MESSAGE =
  'Taking orders is switched off on the staff website. Use the POS, or ask the owner or a manager to turn it on in Settings → Store.';

export const MENU_POS_ONLY_MESSAGE = 'Menu changes can only be made on the POS.';
