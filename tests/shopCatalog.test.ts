import { describe, expect, it } from 'vitest';
import {
  defaultPackage,
  defaultPackageForLines,
  goodsWeightKg,
  GRINDS,
  HOME_BLEND_IMAGE,
  isGrindCode,
  lineItemLabel,
  lineSku,
  MAX_PARCEL_KG,
  packingChecklist,
  packLabel,
  PLACEHOLDER_PRICE_INR,
  PRODUCT_LINES,
  shiprocketItemName,
} from '@/lib/shop/catalog';
import type { ShopLine } from '@/lib/shop/types';

const jar = (quantity: number, name = 'Signature Classic'): ShopLine => ({
  product_id: 'classic', name, sku: 'HIOC-IC-CLASSIC-50G', unit_price_inr: 399, quantity, line_total_inr: 399 * quantity,
});
const blend = (quantity: number, pack_grams: number, grind: ShopLine['grind'], ship_weight_kg: number): ShopLine => ({
  product_id: `hb-${pack_grams}`, name: `Signature Home Blend ${packLabel(pack_grams)}`, sku: 'HIOC-HB', unit_price_inr: 500,
  quantity, line_total_inr: 500 * quantity, line: 'home_blend', pack_grams, grind,
  grind_label: grind === 'filter' ? 'Pour-over / Filter' : grind === 'whole_bean' ? 'Whole bean' : null, ship_weight_kg,
});

describe('grinds', () => {
  it('lists the five grinds in order with codes, labels and suffixes', () => {
    expect(GRINDS.map((g) => [g.code, g.label, g.sku_suffix])).toEqual([
      ['whole_bean', 'Whole bean', 'WB'],
      ['espresso', 'Espresso', 'ESP'],
      ['moka', 'Moka pot', 'MOKA'],
      ['filter', 'Pour-over / Filter', 'FLT'],
      ['french_press', 'French press', 'FP'],
    ]);
    expect(GRINDS[3].hint).toBe('Medium, for V60, Chemex, drip and South Indian filter');
    expect(GRINDS[0].hint).toBe("I'll grind it myself");
  });
  it('recognises grind codes', () => {
    expect(isGrindCode('moka')).toBe(true);
    expect(isGrindCode('turkish')).toBe(false);
    expect(isGrindCode(null)).toBe(false);
  });
  it('builds line SKUs', () => {
    expect(lineSku('HIOC-HB-250G', 'filter')).toBe('HIOC-HB-250G-FLT');
    expect(lineSku('HIOC-HB-250G', null)).toBe('HIOC-HB-250G');
    expect(lineSku('HIOC-HB-250G')).toBe('HIOC-HB-250G');
  });
  it('labels pack sizes', () => {
    expect(packLabel(250)).toBe('250 g');
    expect(packLabel(1000)).toBe('1 kg');
  });
});

describe('constants', () => {
  it('has the line titles, placeholder price and no image yet', () => {
    expect(PRODUCT_LINES.instant.title).toBe('Instant Coffee');
    expect(PRODUCT_LINES.home_blend).toEqual({ title: 'Home Blend', anchor: 'home-blend' });
    expect(PLACEHOLDER_PRICE_INR).toBe(1);
    expect(HOME_BLEND_IMAGE).toBeNull();
    expect(MAX_PARCEL_KG).toBe(6);
  });
});

describe('line labels', () => {
  it('labels instant and home blend lines', () => {
    expect(lineItemLabel(jar(2))).toBe('2× Signature Classic');
    expect(lineItemLabel(blend(1, 500, 'filter', 0.55))).toBe('1× Home Blend 500 g · Filter');
  });
  it('names items for Shiprocket', () => {
    expect(shiprocketItemName({ ...jar(1, 'Nutty Hazelnut'), pack_grams: 50 })).toBe('HIOC. Premium Instant Coffee: Nutty Hazelnut (50 g)');
    expect(shiprocketItemName(blend(1, 500, 'filter', 0.55))).toBe('HIOC. Signature Home Blend: 500 g, Pour-over / Filter');
  });
  it('writes the packing checklist for home blend lines only', () => {
    expect(packingChecklist([jar(2), blend(1, 500, 'filter', 0.55), blend(2, 250, 'whole_bean', 0.3)])).toEqual([
      'Grind 1 × 500 g for Pour-over / Filter',
      'Pack 2 × 250 g whole bean',
    ]);
    expect(packingChecklist([jar(1)])).toEqual([]);
  });
});

describe('parcel', () => {
  it('sums goods weight', () => {
    expect(goodsWeightKg([jar(2), blend(1, 1000, 'moka', 1.1)])).toBe(1.7);
    expect(goodsWeightKg([{ ...jar(3), ship_weight_kg: undefined }])).toBe(0.9);
  });
  it('matches v1 for 1, 2 and 3 jars', () => {
    for (const n of [1, 2, 3]) expect(defaultPackageForLines([jar(n)])).toEqual(defaultPackage(n));
  });
  it('sizes the box for a 1 kg pack', () => {
    expect(defaultPackageForLines([blend(1, 1000, 'filter', 1.1)])).toEqual({ weight_kg: 1.2, length_cm: 24, breadth_cm: 20, height_cm: 12 });
  });
  it('uses the biggest box above 2 kg', () => {
    expect(defaultPackageForLines([blend(3, 1000, 'filter', 1.1)])).toMatchObject({ weight_kg: 3.4, length_cm: 30 });
  });
});
