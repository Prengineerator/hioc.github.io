// DEV-3 — what this machine defaults to, and what the store defaults to.
//
// Pure, because the resolution rule is the whole feature and it is exactly the
// kind of thing `||` gets wrong: a device that says "do NOT print KOTs" stores
// `false`, and `false || store.kot` reads that as "no opinion" and prints
// anyway. Every fallback here is `??`, and there is a test for the false case.

import { readAutoPrintSettings, type AutoPrintSettings } from '@/lib/staff/autoPrint';
import type { PosDeviceContext, StoreSettings } from '@/lib/types';

/** What the POS uses when nothing has an opinion. Matches the counter's own
 *  historical default — most orders at this cafe are taken at a table. */
export const POS_FALLBACK_ORDER_TYPE = 'dine_in' as const;

export type PosDefaultOrderType = 'takeaway' | 'dine_in';

/**
 * Device override, else the store-level switches (POS4-3), else the documented
 * defaults. Three layers, and the middle one is why this exists: the event
 * stand has no kitchen to print for, the counter does, and neither should have
 * to be reconfigured when the other changes.
 */
export function resolveAutoPrint(
  store: Partial<StoreSettings> | null | undefined,
  device: Pick<PosDeviceContext, 'auto_print_kot' | 'auto_print_bill'> | null | undefined,
): AutoPrintSettings {
  const storeSettings = readAutoPrintSettings(store);
  return {
    kot: device?.auto_print_kot ?? storeSettings.kot,
    bill: device?.auto_print_bill ?? storeSettings.bill,
  };
}

/**
 * The order type the POS opens on. A DEFAULT, not a lock — the staffer's toggle
 * still works, and their choice sticks for the rest of the shift exactly as it
 * did before this device existed.
 */
export function resolveDefaultOrderType(
  device: Pick<PosDeviceContext, 'default_order_type'> | null | undefined,
): PosDefaultOrderType {
  return device?.default_order_type ?? POS_FALLBACK_ORDER_TYPE;
}
