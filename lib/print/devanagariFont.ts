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
  // The variable is declared on the ROOT layout (app/layout.tsx), so every
  // customer page (menu, checkout, …) would otherwise get a <link
  // rel="preload"> for a font it never renders. The @font-face rule is still
  // declared site-wide, so the staff-print page and the canvas rasterizer
  // (brandHeaderRaster.ts, via `document.fonts.load`) still fetch it on
  // demand — only when "हाईओक" is actually drawn.
  preload: false,
});
