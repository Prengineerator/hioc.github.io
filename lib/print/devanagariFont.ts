import { Noto_Sans_Devanagari } from 'next/font/google';

// The only Devanagari face in the app — used for "हाईओक" in the brand header,
// both when the HTML/driver ticket (components/print/StaffTickets.tsx) draws
// it directly in the DOM and when brandHeaderRaster.ts draws it onto a canvas
// to rasterize for ESC/POS printers. Latin text ("HIOC.") shares the same
// stack: this subset doesn't cover Latin glyphs, so the browser/canvas falls
// through to the declared fallback for it automatically.
export const devanagariFont = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  weight: ['400', '700'],
  variable: '--font-noto-devanagari',
  display: 'swap',
});
