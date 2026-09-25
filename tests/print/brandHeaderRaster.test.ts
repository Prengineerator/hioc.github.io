import { describe, expect, it } from 'vitest';
import { packMonochrome, computeHeaderLayout, findContentBounds } from '@/lib/print/brandHeaderRaster';

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

// PRN-7 — the pure layout math behind the logo/Hindi/English header stack.
// No canvas involved: real ascent/descent and logo aspect ratio are supplied
// directly, exactly as `buildRaster` would measure them, so this is fully
// testable without a DOM.
describe('computeHeaderLayout', () => {
  const widthDots = 576; // 80mm

  it('stacks logo -> gap -> Hindi -> gap -> English with no overlaps, each fully inside the canvas', () => {
    const layout = computeHeaderLayout({
      widthDots,
      logo: { width: 480, height: 291 }, // real logo-black.png aspect ratio
      hi: { ascent: 32, descent: 14 },
      en: { ascent: 24, descent: 8 },
    });

    expect(layout.logo).not.toBeNull();
    const logo = layout.logo!;
    // Logo starts at/after the top padding, never at y=0 (some margin above it).
    expect(logo.top).toBeGreaterThan(0);

    // Hindi starts strictly after the logo ends — no overlap.
    expect(layout.hi.top).toBeGreaterThanOrEqual(logo.top + logo.height);
    // English starts strictly after Hindi ends — no overlap.
    expect(layout.en.top).toBeGreaterThanOrEqual(layout.hi.top + layout.hi.height);

    // Everything (including bottom padding) fits inside the reported canvas height.
    expect(layout.en.top + layout.en.height).toBeLessThanOrEqual(layout.totalHeight);
    // There's an actual gap left after English — the header doesn't end flush
    // against the canvas edge (PRN-7: "no gap between header and address").
    expect(layout.totalHeight).toBeGreaterThan(layout.en.top + layout.en.height);

    // The logo is centered on the full dot width.
    expect(logo.left).toBeCloseTo((widthDots - logo.width!) / 2, 5);

    // Logo occupies roughly 50-60% of the paper width, per PRN-7.
    const ratio = logo.width! / widthDots;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(0.6);

    // baselineY = top + ascent for each text element (what fillText needs
    // under textBaseline = 'alphabetic').
    expect(layout.hi.baselineY).toBe(layout.hi.top + 32);
    expect(layout.en.baselineY).toBe(layout.en.top + 24);
  });

  it('still lays out Hindi and English correctly with no logo at all', () => {
    const layout = computeHeaderLayout({
      widthDots,
      logo: null,
      hi: { ascent: 32, descent: 14 },
      en: { ascent: 24, descent: 8 },
    });
    expect(layout.logo).toBeNull();
    expect(layout.hi.top).toBeGreaterThan(0);
    expect(layout.en.top).toBeGreaterThanOrEqual(layout.hi.top + layout.hi.height);
    expect(layout.en.top + layout.en.height).toBeLessThanOrEqual(layout.totalHeight);
  });

  it('sizes the canvas to fit a tall logo instead of silently dropping the English line', () => {
    // PRN-7 root cause: a fixed CANVAS_MAX_HEIGHT (260) plus the real
    // logo-black.png aspect ratio (h/w ~0.61) left too little room for the
    // English line, and the old code just skipped drawing it. This asserts
    // the new layout always reserves room for all three elements regardless
    // of how tall the logo's aspect ratio makes it.
    const layout = computeHeaderLayout({
      widthDots,
      logo: { width: 480, height: 291 },
      hi: { ascent: 32, descent: 14 },
      en: { ascent: 24, descent: 8 },
    });
    // English's box is present and has positive height — never collapsed/omitted.
    expect(layout.en.height).toBeGreaterThan(0);
    expect(layout.totalHeight).toBeGreaterThan(layout.logo!.top + layout.logo!.height);
  });

  it('is deterministic and produces the same layout for the same input', () => {
    const input = {
      widthDots,
      logo: { width: 480, height: 291 },
      hi: { ascent: 32, descent: 14 },
      en: { ascent: 24, descent: 8 },
    };
    expect(computeHeaderLayout(input)).toEqual(computeHeaderLayout(input));
  });
});

describe('findContentBounds', () => {
  function rgbaOf(pixels: Array<[number, number, number, number]>): Uint8ClampedArray {
    const out = new Uint8ClampedArray(pixels.length * 4);
    pixels.forEach(([r, g, b, a], i) => {
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = a;
    });
    return out;
  }

  it('finds a tight bounding box around a single opaque black pixel in a transparent field', () => {
    // 4x4, transparent everywhere except (2,1) which is opaque black.
    const pixels: Array<[number, number, number, number]> = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
    pixels[1 * 4 + 2] = [0, 0, 0, 255]; // (x=2, y=1)
    const bounds = findContentBounds(rgbaOf(pixels), 4, 4);
    expect(bounds).toEqual({ x: 2, y: 1, width: 1, height: 1 });
  });

  it('ignores a transparent margin and an opaque-white margin around real content', () => {
    // 5x5: opaque white border, transparent corner, black 1x1 content at (2,2).
    const pixels: Array<[number, number, number, number]> = [];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        if (x === 2 && y === 2) pixels.push([0, 0, 0, 255]);
        else if (x === 0 && y === 0) pixels.push([0, 0, 0, 0]); // transparent corner
        else pixels.push([255, 255, 255, 255]); // opaque white margin
      }
    }
    const bounds = findContentBounds(rgbaOf(pixels), 5, 5);
    expect(bounds).toEqual({ x: 2, y: 2, width: 1, height: 1 });
  });

  it('returns null when the buffer has no content at all (fully transparent or fully white)', () => {
    const allTransparent = rgbaOf(Array.from({ length: 9 }, () => [0, 0, 0, 0]));
    expect(findContentBounds(allTransparent, 3, 3)).toBeNull();

    const allWhite = rgbaOf(Array.from({ length: 9 }, () => [255, 255, 255, 255]));
    expect(findContentBounds(allWhite, 3, 3)).toBeNull();
  });

  it('crops an asymmetrically-padded logo so its visual content, not the padded canvas, sets the bounds', () => {
    // 6-wide x 3-tall: content only in columns 3-4 (right-heavy padding) —
    // this is the shape of bug PRN-7 calls out ("logo looks slightly left of
    // centre"): trimming must find the visually-offset content so the
    // CALLER can re-center it, rather than centering the padded image.
    const pixels: Array<[number, number, number, number]> = [];
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 6; x++) {
        const isContent = x >= 3 && x <= 4 && y === 1;
        pixels.push(isContent ? [0, 0, 0, 255] : [0, 0, 0, 0]);
      }
    }
    const bounds = findContentBounds(rgbaOf(pixels), 6, 3);
    expect(bounds).toEqual({ x: 3, y: 1, width: 2, height: 1 });
  });
});
