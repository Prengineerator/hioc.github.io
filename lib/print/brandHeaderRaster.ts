// Client-only: rasterizes the logo + "हाईओक" / "HIOC." brand header onto a
// <canvas> and packs it into the 1-bit raster `lib/print/escpos.ts` prints
// with `GS v 0`. Devanagari (and a logo image) can't be represented as
// ESC/POS characters, so this is the one place that header becomes pixels
// instead of text.
//
// Guarded end-to-end by `typeof document !== 'undefined'` and try/catch: this
// module only ever runs in a browser (the Electron renderer, via
// lib/desktop/printExecutor.ts's `resolveBrandHeader`), never in tests or on
// the server, and a failure here — a blocked image load, a font that never
// resolves, a tainted/unsupported canvas — must never break a print job. Every
// failure path returns `null`, and `renderEscPos` falls back to centered
// double-size "HIOC." text when it does (see escpos.ts).
//
// PRN-7 field report (printed header misaligned on real 80mm paper): the
// layout math used to run entirely inline, against a fixed CANVAS_MAX_HEIGHT
// guess and the font's nominal 'top' baseline. Two bugs fell out of that:
//   - the logo's real aspect ratio (480x291 — h/w ≈ 0.61) makes it ~192px
//     tall at 80mm's 576-dot width and 0.55 width ratio, which left only
//     ~58px of the 260px budget for BOTH Devanagari and English lines — not
//     enough, so the `y + EN_FONT_PX <= CANVAS_MAX_HEIGHT` guard silently
//     dropped the English line instead of growing the canvas;
//   - 'top' textBaseline measures from the font's nominal ascent, not the
//     glyphs actually painted, so a 4px gap after the logo was thin enough
//     for a tall Devanagari matra to visually clip into the logo art above.
// The fix: measure each element for real (image trimmed to its visual
// content, text via `measureText`'s *actual* bounding box) and size the
// canvas to fit everything, instead of hoping a fixed budget is enough.
// `computeHeaderLayout` below is the pure math this depends on — no canvas,
// so it's the part this file's own unit tests can actually exercise.

import { BRAND_NAME_EN, BRAND_NAME_HI } from '@/lib/print/brandHeader';
import { devanagariFont } from '@/lib/print/devanagariFont';
import type { RasterBlock } from '@/lib/print/ticketDoc';

// 8 dots/mm at the printer's native 203dpi-class resolution: 80mm → 576 dots,
// 58mm → 384 dots. Matches the paper widths PrinterSettings offers.
const DOT_WIDTH: Record<58 | 80, number> = { 58: 384, 80: 576 };

// Safety ceiling only — real content is measured and the canvas is sized to
// fit it exactly (see `computeHeaderLayout`); this just stops a pathological
// font/image measurement from producing a runaway-tall canvas.
const CANVAS_SAFETY_MAX_HEIGHT = 500;

const TOP_PADDING = 6;
const BOTTOM_PADDING = 10;
const GAP_AFTER_LOGO = 10;
const GAP_AFTER_HI = 6;
const LOGO_WIDTH_RATIO = 0.55; // ~50-60% of paper width, per PRN-7.
const HI_FONT_PX = 44;
const EN_FONT_PX = 34;

const FALLBACK_STACK = `'Nirmala UI', 'Mangal', sans-serif`;

// ---------------------------------------------------------------------------
// Pure layout math — no canvas, no DOM. Unit-tested directly in
// tests/print/brandHeaderRaster.test.ts.
// ---------------------------------------------------------------------------

/** The exact vertical extent of a piece of drawn text, as
 * `CanvasRenderingContext2D#measureText` reports it for the actual glyphs —
 * not the font's nominal (and, for Devanagari, unreliable) ascent/descent. */
export interface HeaderTextMetrics {
  ascent: number;
  descent: number;
}

/** A loaded image's pixel dimensions — either the raw natural size, or (once
 * trimmed) the tight bounding box of its visible content. */
export interface HeaderImageMetrics {
  width: number;
  height: number;
}

export interface HeaderLayoutInput {
  widthDots: number;
  /** null when the logo failed to load — the header still lays out fine
   * without it. */
  logo: HeaderImageMetrics | null;
  hi: HeaderTextMetrics;
  en: HeaderTextMetrics;
}

/** One element's box in the composed header: `top`/`height` describe its
 * vertical extent (for overlap/bounds checks); `baselineY` is the y to pass
 * to `fillText` under `textBaseline = 'alphabetic'` (text elements only);
 * `left`/`width` are the logo's horizontal placement (logo only — text is
 * drawn with `textAlign = 'center'` at `widthDots / 2` instead). */
export interface HeaderElementBox {
  top: number;
  height: number;
  baselineY?: number;
  left?: number;
  width?: number;
}

export interface HeaderLayout {
  widthDots: number;
  totalHeight: number;
  logo: HeaderElementBox | null;
  hi: HeaderElementBox;
  en: HeaderElementBox;
}

/**
 * Stacks logo → gap → Hindi → gap → English, each sized from real
 * measurements (never a guessed font-metric box), and returns the exact
 * vertical box every element needs plus the total canvas height required to
 * fit all of them plus top/bottom padding. Centers the logo horizontally on
 * `widthDots`; text elements are centered by the caller via `textAlign =
 * 'center'` at `fillText` time, using this function's `baselineY`.
 */
export function computeHeaderLayout(input: HeaderLayoutInput): HeaderLayout {
  const { widthDots, logo, hi, en } = input;
  let y = TOP_PADDING;

  let logoBox: HeaderElementBox | null = null;
  if (logo && logo.width > 0 && logo.height > 0) {
    const width = Math.round(widthDots * LOGO_WIDTH_RATIO);
    const height = Math.round((logo.height / logo.width) * width);
    if (height > 0) {
      logoBox = { top: y, height, width, left: (widthDots - width) / 2 };
      y += height + GAP_AFTER_LOGO;
    }
  }

  const hiHeight = hi.ascent + hi.descent;
  const hiBox: HeaderElementBox = { top: y, height: hiHeight, baselineY: y + hi.ascent };
  y += hiHeight + GAP_AFTER_HI;

  const enHeight = en.ascent + en.descent;
  const enBox: HeaderElementBox = { top: y, height: enHeight, baselineY: y + en.ascent };
  y += enHeight;

  y += BOTTOM_PADDING;

  return {
    widthDots,
    totalHeight: Math.min(CANVAS_SAFETY_MAX_HEIGHT, Math.ceil(y)),
    logo: logoBox,
    hi: hiBox,
    en: enBox,
  };
}

/** The tight bounding box of "visible" content in an RGBA buffer — anything
 * that isn't (fully transparent OR near-white) counts. Pure: operates on a
 * plain pixel buffer, no canvas — used to trim the logo PNG's transparent/
 * white margins before it's centered, so its VISUAL center (not the full
 * image bounding box, which can be asymmetrically padded) lands on the
 * paper's center. Returns null when nothing in the buffer counts as content. */
export function findContentBounds(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3];
      if (a <= 10) continue; // effectively transparent
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luminance >= 250) continue; // effectively white background
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// ---------------------------------------------------------------------------
// Canvas plumbing — everything below this line needs a real DOM and is only
// exercised manually (PrinterSettings' "Test print"), per the file-level
// comment above.
// ---------------------------------------------------------------------------

/**
 * Packs an RGBA pixel buffer (as `CanvasRenderingContext2D#getImageData`
 * returns it) into 1-bit-per-pixel rows, MSB first — the format `GS v 0`
 * (and `TicketBlock`'s `raster` kind) expects. A pixel is black when it's
 * mostly opaque (alpha > 128) and dark (luminance < 128); everything else —
 * including fully transparent pixels — is white (0).
 */
export function packMonochrome(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const a = rgba[i + 3];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      if (a > 128 && luminance < 128) {
        out[rowOffset + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

/** Whether a packed row (bytesPerRow bytes starting at `offset`) is all-white. */
function rowIsBlank(data: Uint8Array, offset: number, bytesPerRow: number): boolean {
  for (let i = 0; i < bytesPerRow; i++) {
    if (data[offset + i] !== 0) return false;
  }
  return true;
}

/**
 * Drops fully-white rows off the TOP only of a packed raster — a defensive
 * trim for a stray blank row from a measurement/rounding edge case, since
 * `computeHeaderLayout` now sizes the canvas to fit its content exactly.
 *
 * PRN-7 field report ("no gap between the header and the shop address that
 * follows"): the original version trimmed the BOTTOM too, which silently ate
 * the deliberate `BOTTOM_PADDING` margin the layout adds after "HIOC." —
 * blank rows are indistinguishable from "nothing left to trim", so intent
 * and padding trimmed identically. The gap only exists at all if the raster
 * is allowed to end in blank rows, so the bottom is never trimmed here.
 */
function trimLeadingBlankRows(data: Uint8Array, widthDots: number, heightDots: number): RasterBlock | null {
  const bytesPerRow = Math.ceil(widthDots / 8);
  let top = 0;
  while (top < heightDots && rowIsBlank(data, top * bytesPerRow, bytesPerRow)) top++;
  if (top >= heightDots) return null; // nothing was drawn at all
  const heightTrimmed = heightDots - top;
  return {
    kind: 'raster',
    widthDots,
    heightDots: heightTrimmed,
    data: data.slice(top * bytesPerRow, heightDots * bytesPerRow),
  };
}

/** Loads /images/logo-black.png, or null if it can't be loaded — the header
 * still draws the Hindi/English text without it in that case. */
async function loadLogo(): Promise<HTMLImageElement | null> {
  try {
    const img = new Image();
    img.src = '/images/logo-black.png';
    if (typeof img.decode === 'function') {
      await img.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('logo image failed to load'));
      });
    }
    return img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null;
  } catch {
    return null;
  }
}

/** Draws `img` at its natural size onto a scratch canvas and returns the
 * tight bounding box of its visible content (see `findContentBounds`), in
 * the image's own natural pixel coordinates. Falls back to the full natural
 * bounds if a scratch canvas/context isn't available or nothing is found. */
function trimLogoBounds(img: HTMLImageElement): { x: number; y: number; width: number; height: number } {
  const full = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
  try {
    const scratch = document.createElement('canvas');
    scratch.width = img.naturalWidth;
    scratch.height = img.naturalHeight;
    const sctx = scratch.getContext('2d');
    if (!sctx) return full;
    sctx.drawImage(img, 0, 0);
    const imageData = sctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
    return findContentBounds(imageData.data, img.naturalWidth, img.naturalHeight) ?? full;
  } catch {
    return full;
  }
}

/** Measures the exact painted extent of `text` in `font` — the actual glyph
 * bounding box (`actualBoundingBoxAscent`/`Descent`), not the font's nominal
 * metrics, which for Devanagari can under- or over-state how tall the glyphs
 * really paint. */
function measureTextBox(ctx: CanvasRenderingContext2D, text: string, font: string): HeaderTextMetrics {
  ctx.font = font;
  const m = ctx.measureText(text);
  const ascent = Number.isFinite(m.actualBoundingBoxAscent) ? Math.max(0, m.actualBoundingBoxAscent) : 0;
  const descent = Number.isFinite(m.actualBoundingBoxDescent) ? Math.max(0, m.actualBoundingBoxDescent) : 0;
  // A font that reports a degenerate (zero) box for real text (e.g. glyphs
  // not yet painted anywhere) would otherwise collapse that element's box to
  // nothing and silently drop it — fall back to the pixel font size as a
  // floor so the layout always reserves *some* room for it.
  const px = Number.parseFloat(font) || 0;
  return ascent + descent > 0 ? { ascent, descent } : { ascent: px * 0.8, descent: px * 0.2 };
}

async function buildRaster(paperWidthMm: 58 | 80): Promise<RasterBlock | null> {
  const widthDots = DOT_WIDTH[paperWidthMm];

  const measureCanvas = document.createElement('canvas');
  const mctx = measureCanvas.getContext('2d');
  if (!mctx) return null;

  const family = devanagariFont.style.fontFamily;
  const stack = `${family}, ${FALLBACK_STACK}`;

  try {
    await document.fonts.load(`${HI_FONT_PX}px ${family}`, BRAND_NAME_HI);
  } catch {
    // Font never resolved (slow network, unsupported API) — canvas text below
    // still renders, just against whichever font is actually loaded/fallback.
  }

  const logo = await loadLogo();
  const logoBounds = logo ? trimLogoBounds(logo) : null;

  const layout = computeHeaderLayout({
    widthDots,
    logo: logoBounds ? { width: logoBounds.width, height: logoBounds.height } : null,
    hi: measureTextBox(mctx, BRAND_NAME_HI, `${HI_FONT_PX}px ${stack}`),
    en: measureTextBox(mctx, BRAND_NAME_EN, `bold ${EN_FONT_PX}px ${stack}`),
  });

  const canvas = document.createElement('canvas');
  canvas.width = widthDots;
  canvas.height = layout.totalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthDots, layout.totalHeight);
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic'; // paired with baselineY = top + ascent from computeHeaderLayout

  if (logo && logoBounds && layout.logo) {
    const { top, height, left, width } = layout.logo;
    ctx.drawImage(
      logo,
      logoBounds.x,
      logoBounds.y,
      logoBounds.width,
      logoBounds.height,
      left ?? 0,
      top,
      width ?? 0,
      height,
    );
  }

  ctx.font = `${HI_FONT_PX}px ${stack}`;
  ctx.fillText(BRAND_NAME_HI, widthDots / 2, layout.hi.baselineY ?? layout.hi.top);

  ctx.font = `bold ${EN_FONT_PX}px ${stack}`;
  ctx.fillText(BRAND_NAME_EN, widthDots / 2, layout.en.baselineY ?? layout.en.top);

  const imageData = ctx.getImageData(0, 0, widthDots, layout.totalHeight);
  const packed = packMonochrome(imageData.data, widthDots, layout.totalHeight);
  return trimLeadingBlankRows(packed, widthDots, layout.totalHeight);
}

// One raster per paper width, built at most once per page load. Only a
// successful render is cached — a failure (logo/font hiccup, no canvas
// support) is retried on the next call rather than sticking as `null`
// forever.
const cache = new Map<58 | 80, RasterBlock>();

/**
 * Returns the rasterized brand header for a given paper width, or `null` if
 * it can't be built right now (no DOM, no canvas 2D context, or any other
 * failure along the way) — callers (`resolveBrandHeader` in
 * lib/desktop/printExecutor.ts) leave the `brandHeader` placeholder block in
 * place when this returns `null`, and `renderEscPos`'s text fallback covers
 * it from there. Cached per paper width after a successful build.
 */
// A *rejected* logo/font load is already handled inline (loadLogo's own
// try/catch, the document.fonts.load try/catch). This guards the other
// failure mode: one that never settles at all — an image `decode()` or a
// font load stuck on a hung network fetch would otherwise stall this
// promise, and with it the printer's whole print job (printExecutor.ts
// awaits `resolveBrandHeader` before sending anything to the printer). A
// print job racing a slow-but-working rasterization should still win instead
// of quietly falling back, so this is generous — well beyond how long a
// same-origin local image and a Google Fonts asset actually take.
const BUILD_TIMEOUT_MS = 4000;

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export async function getBrandHeaderRaster(paperWidthMm: 58 | 80): Promise<RasterBlock | null> {
  if (typeof document === 'undefined') return null;

  const cached = cache.get(paperWidthMm);
  if (cached) return cached;

  try {
    const raster = await Promise.race([buildRaster(paperWidthMm), timeout(BUILD_TIMEOUT_MS, null)]);
    if (raster) cache.set(paperWidthMm, raster);
    return raster;
  } catch {
    return null;
  }
}
