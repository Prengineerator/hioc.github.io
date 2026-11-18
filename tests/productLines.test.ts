import { describe, expect, it } from 'vitest';
import { acceptedPackId, homeBlendFromLabel, homeBlendTiles, productLinesToShow } from '@/lib/shop/productLines';

describe('homeBlendTiles', () => {
  it('sorts by grams, labels packs and marks only 250 g popular', () => {
    const t = homeBlendTiles([
      { pack_grams: 1000, price_inr: 1750 },
      { pack_grams: 250, price_inr: 525 },
      { pack_grams: 100, price_inr: 225 },
      { pack_grams: 500, price_inr: 950 },
    ]);
    expect(t.map((x) => x.label)).toEqual(['100 g', '250 g', '500 g', '1 kg']);
    expect(t.map((x) => x.priceInr)).toEqual([225, 525, 950, 1750]);
    expect(t.filter((x) => x.popular).map((x) => x.grams)).toEqual([250]);
  });
  it('is empty with no packs', () => {
    expect(homeBlendTiles([])).toEqual([]);
  });
});

describe('productLinesToShow', () => {
  it('shows only lines with products', () => {
    expect(productLinesToShow(3, 0)).toEqual({ instant: true, homeBlend: false });
    expect(productLinesToShow(0, 2)).toEqual({ instant: false, homeBlend: true });
    expect(productLinesToShow(0, 0)).toEqual({ instant: false, homeBlend: false });
  });
});

describe('acceptedPackId', () => {
  const packs = [
    { id: 'a', listed: true, in_stock: true },
    { id: 'b', listed: true, in_stock: false },
    { id: 'c', listed: false, in_stock: true },
  ];
  it('accepts only a listed, in-stock pack id', () => {
    expect(acceptedPackId({ productId: 'a' }, packs)).toBe('a');
    expect(acceptedPackId({ productId: 'b' }, packs)).toBeNull();
    expect(acceptedPackId({ productId: 'c' }, packs)).toBeNull();
    expect(acceptedPackId({ productId: 'zzz' }, packs)).toBeNull();
  });
  it('ignores malformed details', () => {
    expect(acceptedPackId(null, packs)).toBeNull();
    expect(acceptedPackId('a', packs)).toBeNull();
    expect(acceptedPackId({ productId: 5 }, packs)).toBeNull();
    expect(acceptedPackId({}, packs)).toBeNull();
  });
});

describe('homeBlendFromLabel', () => {
  it('uses the cheapest pack', () => {
    const tiles = homeBlendTiles([
      { pack_grams: 250, price_inr: 525 },
      { pack_grams: 100, price_inr: 225 },
    ]);
    expect(homeBlendFromLabel(tiles)).toEqual({ priceInr: 225, note: '(100 g sample)' });
  });
  it('has no sample wording for bigger packs, and null when empty', () => {
    expect(homeBlendFromLabel(homeBlendTiles([{ pack_grams: 250, price_inr: 525 }]))).toEqual({ priceInr: 525, note: '(250 g)' });
    expect(homeBlendFromLabel([])).toBeNull();
  });
});
