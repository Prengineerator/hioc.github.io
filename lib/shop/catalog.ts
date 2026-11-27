// What the /shop page says about the jars, and the parcel sizes the owner
// starts from when sending an order to Shiprocket. Client-safe.
//
// The claims are the launch poster's own (public/images/promo-instant-coffee.jpg).
// Prices are NOT here: they live in shop_products and lib/shop/pricing.ts.

import type { GrindCode, ShopLine, ShopPackage, ShopProductLine } from './types';

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
export const BOX_WEIGHT_KG = 0.1;
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

// ---------------------------------------------------------------------------
// Shop v2 (docs/SHOP-V2-SPEC.md E1, E6): grinds, product lines, line SKUs and
// the parcel worked out from what is actually in the order.
// ---------------------------------------------------------------------------

/** How a Home Blend pack can be ground, in the order the customer sees them. */
export const GRINDS: readonly { code: GrindCode; label: string; short: string; hint: string; sku_suffix: string }[] = [
  { code: 'whole_bean', label: 'Whole bean', short: 'Whole bean', hint: "I'll grind it myself", sku_suffix: 'WB' },
  { code: 'espresso', label: 'Espresso', short: 'Espresso', hint: 'Fine, for espresso machines', sku_suffix: 'ESP' },
  { code: 'moka', label: 'Moka pot', short: 'Moka', hint: 'Fine-medium, for stovetop moka pots', sku_suffix: 'MOKA' },
  {
    code: 'filter',
    label: 'Pour-over / Filter',
    short: 'Filter',
    hint: 'Medium, for V60, Chemex, drip and South Indian filter',
    sku_suffix: 'FLT',
  },
  {
    code: 'french_press',
    label: 'French press',
    short: 'French press',
    hint: 'Coarse, for French press and cold brew',
    sku_suffix: 'FP',
  },
];

export function isGrindCode(v: unknown): v is GrindCode {
  return typeof v === 'string' && GRINDS.some((g) => g.code === v);
}

export function grindLabel(code: GrindCode): string {
  return GRINDS.find((g) => g.code === code)?.label ?? code;
}

export function grindShort(code: GrindCode): string {
  return GRINDS.find((g) => g.code === code)?.short ?? code;
}

/** The SKU of one line: the product's base SKU plus the grind suffix (unchanged without a grind). */
export function lineSku(baseSku: string, grind?: GrindCode | null): string {
  const g = grind ? GRINDS.find((x) => x.code === grind) : undefined;
  return g ? `${baseSku}-${g.sku_suffix}` : baseSku;
}

/** "250 g", "1 kg" */
export function packLabel(grams: number): string {
  if (grams >= 1000 && grams % 1000 === 0) return `${grams / 1000} kg`;
  return `${grams} g`;
}

export const PRODUCT_LINES: Record<ShopProductLine, { title: string; anchor: 'instant' | 'home-blend' }> = {
  instant: { title: 'Instant Coffee', anchor: 'instant' },
  home_blend: { title: 'Home Blend', anchor: 'home-blend' },
};

export const HOME_BLEND_NAME = 'HIOC. Signature Home Blend';

/**
 * The Home Blend pack images. These are an ILLUSTRATED stand-in (drawn as SVG,
 * source in public/images/shop/home-blend.svg), not a photo. Swap in a studio
 * photo under the same filenames: the portrait pack (594×792) and the landscape
 * scene (880×476, same aspect as hero-jars.png). Set either to null to fall back
 * to the "Photo coming soon" placeholder.
 */
export const HOME_BLEND_IMAGE: string | null = '/images/shop/home-blend.png';
export const HOME_BLEND_HERO_IMAGE: string | null = '/images/shop/home-blend-hero.png';
export const HOME_BLEND_IMAGE_ALT = `Illustration of a HIOC. Signature Home Blend coffee pack with roasted coffee beans`;
export const HOME_BLEND_IMAGE_SIZE = { width: 594, height: 792 } as const;
export const HOME_BLEND_HERO_SIZE = { width: 880, height: 476 } as const;

/**
 * The pack the Home Blend card opens on: 250 g, the everyday size (the 100 g
 * sample is a taster, not the lead). If 250 g isn't listed or is out of stock,
 * the first pack in stock, in the order given (smallest first on the card).
 */
export const DEFAULT_HOME_BLEND_GRAMS = 250;

export function defaultHomeBlendPack<T extends { pack_grams: number; in_stock: boolean }>(packs: readonly T[]): T | null {
  return packs.find((p) => p.in_stock && p.pack_grams === DEFAULT_HOME_BLEND_GRAMS) ?? packs.find((p) => p.in_stock) ?? null;
}

/** Short copy placeholders. The owner confirms the wording before launch. */
export const HOME_BLEND_HIGHLIGHTS = [
  'Our café house blend, roasted for your kitchen',
  'Ground fresh to your brew method, or whole bean',
  'Packed and sent within 2 working days of the roast',
];

/** The seed price of a product the owner hasn't priced yet: a product at this price can't be listed. */
export const PLACEHOLDER_PRICE_INR = 1;

/** A line's catalogue line; rows frozen by v1 checkouts have none and are instant coffee. */
export function lineOf(l: ShopLine): ShopProductLine {
  return l.line ?? 'instant';
}

/** "2× Signature Classic", "1× Home Blend 500 g · Filter" */
export function lineItemLabel(l: ShopLine): string {
  if (lineOf(l) === 'home_blend') {
    const pack = l.pack_grams ? ` ${packLabel(l.pack_grams)}` : '';
    const grind = l.grind ? ` · ${grindShort(l.grind)}` : '';
    return `${l.quantity}× Home Blend${pack}${grind}`;
  }
  return `${l.quantity}× ${l.name}`;
}

/** The item name sent to Shiprocket. */
export function shiprocketItemName(l: ShopLine): string {
  if (lineOf(l) === 'home_blend') {
    const pack = l.pack_grams ? packLabel(l.pack_grams) : '';
    const grind = l.grind ? (l.grind_label ?? grindLabel(l.grind)) : '';
    return `${HOME_BLEND_NAME}: ${[pack, grind].filter(Boolean).join(', ')}`;
  }
  return `${SHOP_PRODUCT_NAME}: ${l.name} (${packLabel(l.pack_grams ?? 50)})`;
}

/** What to do at the packing table: grind to order, or pack whole bean. Instant lines need nothing. */
export function packingChecklist(lines: readonly ShopLine[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (lineOf(l) !== 'home_blend') continue;
    const pack = l.pack_grams ? packLabel(l.pack_grams) : 'pack';
    if (!l.grind || l.grind === 'whole_bean') out.push(`Pack ${l.quantity} × ${pack} whole bean`);
    else out.push(`Grind ${l.quantity} × ${pack} for ${l.grind_label ?? grindLabel(l.grind)}`);
  }
  return out;
}

/** The most one order can weigh packed, goods only. Past it: a wholesale enquiry. */
export const MAX_PARCEL_KG = 6;

/** What one unit weighs packed when the line doesn't say (a 50 g jar). */
const DEFAULT_UNIT_WEIGHT_KG = JAR_WEIGHT_KG;

export function lineShipWeightKg(l: ShopLine): number {
  return l.ship_weight_kg ?? DEFAULT_UNIT_WEIGHT_KG;
}

/** The goods' weight, without the box. */
export function goodsWeightKg(lines: readonly ShopLine[]): number {
  const kg = lines.reduce((n, l) => n + lineShipWeightKg(l) * l.quantity, 0);
  return Math.round(kg * 1000) / 1000;
}

/** The parcel to start from: the box plus the goods, in a box sized by total weight. */
export function defaultPackageForLines(lines: readonly ShopLine[]): ShopPackage {
  const raw = Math.round((BOX_WEIGHT_KG + lines.reduce((n, l) => n + lineShipWeightKg(l) * l.quantity, 0)) * 1000) / 1000;
  const weight_kg = Math.round(raw * 100) / 100;
  if (raw <= 0.45) return { weight_kg, length_cm: 12, breadth_cm: 10, height_cm: 10 };
  if (raw <= 0.75) return { weight_kg, length_cm: 20, breadth_cm: 12, height_cm: 10 };
  if (raw <= 1.05) return { weight_kg, length_cm: 28, breadth_cm: 12, height_cm: 10 };
  if (raw <= 2.0) return { weight_kg, length_cm: 24, breadth_cm: 20, height_cm: 12 };
  return { weight_kg, length_cm: 30, breadth_cm: 24, height_cm: 14 };
}
