import { describe, expect, it } from 'vitest';
import { packMonochrome } from '@/lib/print/brandHeaderRaster';

// PRN-6 — packMonochrome is the one piece of lib/print/brandHeaderRaster.ts
// that's pure (no canvas, no DOM) and so the only part unit-testable in this
// repo's node-environment vitest setup. The rest of that module — loading the
// logo image, loading the Devanagari font, drawing to a <canvas> — needs a
// real browser and is exercised manually via PrinterSettings' Test print.

describe('packMonochrome', () => {
  it('packs a 2x2 RGBA buffer into 1-bit rows, MSB first, black = alpha>128 && luminance<128', () => {
    // width=2 -> bytesPerRow = ceil(2/8) = 1, so each row is exactly one byte.
    // (x=0,y=0): opaque black -> black (bit 0x80 set)
    // (x=1,y=0): opaque white -> white
    // (x=0,y=1): black but mostly transparent (alpha=100<=128) -> white
    // (x=1,y=1): opaque dark gray (luminance<128) -> black (bit 0x40 set)
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 255, // (0,0) opaque black
      255, 255, 255, 255, // (1,0) opaque white
      0, 0, 0, 100, // (0,1) transparent black
      50, 50, 50, 200, // (1,1) opaque dark gray
    ]);
    const packed = packMonochrome(rgba, 2, 2);
    expect(packed).toEqual(new Uint8Array([0b1000_0000, 0b0100_0000]));
  });

  it('uses bytesPerRow = ceil(width / 8) even when width isn\'t a multiple of 8', () => {
    // width=9 -> bytesPerRow = 2. All-white 9x1 image, so both bytes are 0.
    const rgba = new Uint8ClampedArray(9 * 4).fill(255); // opaque white everywhere
    const packed = packMonochrome(rgba, 9, 1);
    expect(packed).toHaveLength(2);
    expect(packed.every((b) => b === 0)).toBe(true);
  });

  it('packs an all-opaque-black row as all 1 bits, respecting the exact byte count for the width', () => {
    const width = 8;
    const rgba = new Uint8ClampedArray(width * 4);
    for (let x = 0; x < width; x++) {
      rgba[x * 4 + 3] = 255; // r=g=b=0 (already), fully opaque
    }
    const packed = packMonochrome(rgba, width, 1);
    expect(packed).toEqual(new Uint8Array([0xff]));
  });
});
