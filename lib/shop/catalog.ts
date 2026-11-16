// What the /shop page says about the jars, and the parcel sizes the owner
// starts from when sending an order to Shiprocket. Client-safe.
//
// The claims are the launch poster's own (public/images/promo-instant-coffee.jpg).
// Prices are NOT here: they live in shop_products and lib/shop/pricing.ts.

import type { ShopPackage } from './types';

export const SHOP_PRODUCT_NAME = 'HIOC. Premium Instant Coffee';

/**
 * The flavour cards: colour (the poster's flavour pills) and jar photo, by
 * product id. The jars are cut out of the launch poster (transparent PNGs, each
 * with a soft shadow); public/images/shop/hero-jars.png is all three together.
 */
export const FLAVOUR_STYLE: Record<string, { tagline: string; accent: string; image: string }> = {
  classic: {
    tagline: 'Bold, smooth and balanced — the everyday cup.',
    accent: '#1f3d7a',
    image: '/images/shop/jar-classic.png',
  },
  hazelnut: {
    tagline: 'Toasty, nutty and rich.',
    accent: '#8c2b22',
    image: '/images/shop/jar-hazelnut.png',
  },
  vanilla: {
    tagline: 'Sweet, creamy vanilla notes.',
    accent: '#b7791f',
    image: '/images/shop/jar-vanilla.png',
  },
};

export const FALLBACK_FLAVOUR_STYLE = { tagline: '', accent: '#8a6446', image: '' };

export const PRODUCT_HIGHLIGHTS = [
  '100% Arabica coffee',
  'Freeze-dried to lock in the rich aroma and flavour',
  'Café-style blends, instantly',
  'Anytime, anywhere — just add hot water or milk',
];

/** Net quantity of one jar, as printed on the label. */
export const PRODUCT_NET_QTY = '50 g';

/**
 * The promise made on /shop and on the Shipping & Delivery page, in one place
 * so the two always say the same. Change them here if the timings change.
 */
export const DISPATCH_WITHIN = '2 working days';
export const DELIVERY_TAKES = '3–7 working days';

// ---------------------------------------------------------------------------
// The parcel. Shiprocket bills on the larger of the dead weight and the
// volumetric weight (L × B × H ÷ 5000), so a sensible box matters. These are
// starting points the owner can change in the "Send to Shiprocket" dialog;
// weigh a packed box once and adjust them here.
// ---------------------------------------------------------------------------

/** Box, bubble wrap and filler. */
const BOX_WEIGHT_KG = 0.1;
/** One packed 50 g glass jar. */
const JAR_WEIGHT_KG = 0.3;

export function defaultPackage(jars: number): ShopPackage {
  const n = Math.max(1, Math.floor(jars));
  const weight_kg = Math.round((BOX_WEIGHT_KG + JAR_WEIGHT_KG * n) * 100) / 100;
  if (n === 1) return { weight_kg, length_cm: 12, breadth_cm: 10, height_cm: 10 };
  if (n === 2) return { weight_kg, length_cm: 20, breadth_cm: 12, height_cm: 10 };
  if (n === 3) return { weight_kg, length_cm: 28, breadth_cm: 12, height_cm: 10 };
  if (n <= 6) return { weight_kg, length_cm: 24, breadth_cm: 20, height_cm: 12 };
  return { weight_kg, length_cm: 30, breadth_cm: 24, height_cm: 14 };
}

export type PackageResult = { ok: true; pkg: ShopPackage } | { ok: false; error: string };

/** The owner's parcel entries: weight 0.05–20 kg, each side 1–150 cm. */
export function validatePackage(raw: unknown): PackageResult {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const weight_kg = num(r.weight_kg);
  if (!Number.isFinite(weight_kg) || weight_kg < 0.05 || weight_kg > 20) {
    return { ok: false, error: 'Weight must be between 0.05 and 20 kg' };
  }
  const sides = { length_cm: num(r.length_cm), breadth_cm: num(r.breadth_cm), height_cm: num(r.height_cm) };
  for (const [key, v] of Object.entries(sides)) {
    if (!Number.isFinite(v) || v < 1 || v > 150) {
      return { ok: false, error: `${key.replace('_cm', '')} must be between 1 and 150 cm` };
    }
  }
  return {
    ok: true,
    pkg: {
      weight_kg: Math.round(weight_kg * 1000) / 1000,
      length_cm: Math.round(sides.length_cm * 10) / 10,
      breadth_cm: Math.round(sides.breadth_cm * 10) / 10,
      height_cm: Math.round(sides.height_cm * 10) / 10,
    },
  };
}
