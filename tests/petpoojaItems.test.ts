import { describe, expect, it } from 'vitest';
import { splitItems } from '@/lib/petpooja/items';

describe('splitItems', () => {
  it('returns [] for an empty cell', () => {
    expect(splitItems('')).toEqual([]);
    expect(splitItems('   ')).toEqual([]);
  });

  it('splits a single item with no marker and no variant', () => {
    expect(splitItems('Choco Chip Cupcake')).toEqual([
      { raw_name: 'Choco Chip Cupcake', item_name: 'Choco Chip Cupcake', variant_label: '' },
    ]);
  });

  it('strips the [n] marker and captures the variant', () => {
    expect(splitItems("Hioc's Signature Creme [n] (Extra Large)")).toEqual([
      {
        raw_name: "Hioc's Signature Creme [n] (Extra Large)",
        item_name: "Hioc's Signature Creme",
        variant_label: 'Extra Large',
      },
    ]);
  });

  it('handles a short single-letter variant', () => {
    expect(splitItems('Tripple Choco Waffle [n] (L)')).toEqual([
      { raw_name: 'Tripple Choco Waffle [n] (L)', item_name: 'Tripple Choco Waffle', variant_label: 'L' },
    ]);
  });

  it('splits multiple comma-separated entries, each with its own marker/variant', () => {
    const text = "Cappucino [n] (Large), Caramel Chip Creme [n] (Extra Large), Water Bottle";
    expect(splitItems(text)).toEqual([
      { raw_name: 'Cappucino [n] (Large)', item_name: 'Cappucino', variant_label: 'Large' },
      {
        raw_name: 'Caramel Chip Creme [n] (Extra Large)',
        item_name: 'Caramel Chip Creme',
        variant_label: 'Extra Large',
      },
      { raw_name: 'Water Bottle', item_name: 'Water Bottle', variant_label: '' },
    ]);
  });

  it('handles a variant label that itself contains parentheses', () => {
    // Real Petpooja data: 'Ginger Orange Honey Tea (Mini(For Store))'.
    expect(splitItems('Ginger Orange Honey Tea (Mini(For Store))')).toEqual([
      {
        raw_name: 'Ginger Orange Honey Tea (Mini(For Store))',
        item_name: 'Ginger Orange Honey Tea',
        variant_label: 'Mini(For Store)',
      },
    ]);
  });

  it('strips an upper-case [N] marker (older exports)', () => {
    expect(splitItems('Hazelnut Creme Coffee [N] (Large)')).toEqual([
      { raw_name: 'Hazelnut Creme Coffee [N] (Large)', item_name: 'Hazelnut Creme Coffee', variant_label: 'Large' },
    ]);
  });

  it('strips the [n] marker even with no variant present', () => {
    expect(splitItems('Test Item [n]')).toEqual([
      { raw_name: 'Test Item [n]', item_name: 'Test Item', variant_label: '' },
    ]);
  });
});
