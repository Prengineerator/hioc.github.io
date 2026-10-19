// The HSN / SAC codes and GSTR-1 constants the GST pack reports under. Pure.
//
// The café's supply is a restaurant service (SAC 996331) — dine-in, takeaway and
// the HIOC Ritual pass sales alike. The one exception is roasted coffee beans
// sold by weight (menu_items.sold_by_weight), which are goods (HSN 0901) reported
// in kilograms.

import type { GstCode } from '@/lib/reports/exports/types';

export const SAC_RESTAURANT: GstCode = {
  code: '996331',
  description: 'Restaurant service',
  uqc: 'NA',
  kind: 'service',
};

export const HSN_COFFEE_BEANS: GstCode = {
  code: '0901',
  description: 'Coffee, roasted',
  uqc: 'KGS-KILOGRAMS',
  kind: 'goods',
};

/** State code 09 is the first two digits of BUSINESS.gstin (lib/legal.ts): Uttar Pradesh. */
export const PLACE_OF_SUPPLY = '09-Uttar Pradesh';

/** GSTR-1 Table 7 "Type": 'OE' = supplies made through a non-e-commerce channel (the café's own counter and site). */
export const B2CS_TYPE = 'OE';

export function gstCodeFor({ soldByWeight }: { soldByWeight: boolean }): GstCode {
  return soldByWeight ? HSN_COFFEE_BEANS : SAC_RESTAURANT;
}
