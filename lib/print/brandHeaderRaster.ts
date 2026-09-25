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

import { BRAND_NAME_EN, BRAND_NAME_HI } from '@/lib/print/brandHeader';
import { devanagariFont } from '@/lib/print/devanagariFont';
import type { RasterBlock } from '@/lib/print/ticketDoc';

// 8 dots/mm at the printer's native 203dpi-class resolution: 80mm → 576 dots,
// 58mm → 384 dots. Matches the paper widths PrinterSettings offers.
const DOT_WIDTH: Record<58 | 80, number> = { 58: 384, 80: 576 };

// Generous upper bound for the canvas — trimmed down to actual content after
// drawing (trimWhiteRows below), so this only needs to be "big enough".
const CANVAS_MAX_HEIGHT = 260;

const TOP_PADDING = 6;
const BOTTOM_PADDING = 6;
const GAP_AFTER_LOGO = 4;
const GAP_AFTER_HI = 4;
const LOGO_WIDTH_RATIO = 0.55;
const HI_FONT_PX = 44;
const EN_FONT_PX = 34;

const FALLBACK_STACK = `'Nirmala UI', 'Mangal', sans-serif`;

// One raster per paper width, built at most once per page load. Only a
// successful render is cached — a failure (logo/font hiccup, no canvas
// support) is retried on the next call rather than sticking as `null`
// forever.
const cache = new Map<58 | 80, RasterBlock>();

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

/** Drops fully-white rows off the top and bottom of a packed raster. */
function trimWhiteRows(data: Uint8Array, widthDots: number, heightDots: number): RasterBlock | null {
  const bytesPerRow = Math.ceil(widthDots / 8);
  let top = 0;
  let bottom = heightDots - 1;
  while (top < heightDots && rowIsBlank(data, top * bytesPerRow, bytesPerRow)) top++;
  while (bottom >= top && rowIsBlank(data, bottom * bytesPerRow, bytesPerRow)) bottom--;
  if (top > bottom) return null; // nothing was drawn at all
  const heightTrimmed = bottom - top + 1;
  return {
    kind: 'raster',
    widthDots,
    heightDots: heightTrimmed,
    data: data.slice(top * bytesPerRow, (bottom + 1) * bytesPerRow),
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

async function buildRaster(paperWidthMm: 58 | 80): Promise<RasterBlock | null> {
  const widthDots = DOT_WIDTH[paperWidthMm];

  const canvas = document.createElement('canvas');
  canvas.width = widthDots;
  canvas.height = CANVAS_MAX_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthDots, CANVAS_MAX_HEIGHT);
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  let y = TOP_PADDING;

  const logo = await loadLogo();
  if (logo) {
    const targetW = Math.round(widthDots * LOGO_WIDTH_RATIO);
    const targetH = Math.round((logo.naturalHeight / logo.naturalWidth) * targetW);
    if (targetH > 0 && y + targetH <= CANVAS_MAX_HEIGHT) {
      ctx.drawImage(logo, (widthDots - targetW) / 2, y, targetW, targetH);
      y += targetH + GAP_AFTER_LOGO;
    }
  }

  const family = devanagariFont.style.fontFamily;
  const stack = `${family}, ${FALLBACK_STACK}`;

  try {
    await document.fonts.load(`${HI_FONT_PX}px ${family}`, BRAND_NAME_HI);
  } catch {
    // Font never resolved (slow network, unsupported API) — canvas text below
    // still renders, just against whichever font is actually loaded/fallback.
  }

  if (y + HI_FONT_PX <= CANVAS_MAX_HEIGHT) {
    ctx.font = `${HI_FONT_PX}px ${stack}`;
    ctx.fillText(BRAND_NAME_HI, widthDots / 2, y);
    y += HI_FONT_PX + GAP_AFTER_HI;
  }

  if (y + EN_FONT_PX <= CANVAS_MAX_HEIGHT) {
    ctx.font = `bold ${EN_FONT_PX}px ${stack}`;
    ctx.fillText(BRAND_NAME_EN, widthDots / 2, y);
    y += EN_FONT_PX;
  }

  y += BOTTOM_PADDING;

  const heightDots = Math.min(CANVAS_MAX_HEIGHT, Math.ceil(y));
  const imageData = ctx.getImageData(0, 0, widthDots, heightDots);
  const packed = packMonochrome(imageData.data, widthDots, heightDots);
  return trimWhiteRows(packed, widthDots, heightDots);
}

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
