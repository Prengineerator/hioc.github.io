// Single source for the two-line brand wordmark printed at the top of
// receipts and token slips — NOT the KOT. Both the raw ESC/POS raster
// (lib/print/brandHeaderRaster.ts, and its text fallback in
// lib/print/escpos.ts) and the HTML/driver ticket (components/print/
// StaffTickets.tsx) read the strings from here so they can't drift.

/** Devanagari: "HIOC". ESC/POS can't render this as characters — it only
 * ever appears baked into the raster header image. */
export const BRAND_NAME_HI = 'हाईओक';

/** English wordmark, matching lib/constants.ts CAFE_NAME. */
export const BRAND_NAME_EN = 'HIOC.';
