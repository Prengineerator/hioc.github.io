// Stub for the `next/font/google` package (see vitest.config.ts alias).
//
// The real package only does anything inside Next's own build pipeline —
// its webpack/SWC loader intercepts the import and swaps in a generated
// per-font module; the actual npm package's `next/font/google/index.js` is
// an empty file, so calling e.g. `DM_Sans({...})` outside that pipeline
// throws "DM_Sans is not a function" (confirmed by running the real package
// under Vitest). app/layout.tsx and lib/print/devanagariFont.ts call their
// font loader at module scope, so anything that imports them (transitively —
// e.g. lib/print/brandHeaderRaster.ts, lib/desktop/printExecutor.ts) needs
// this stub just to load under Vitest, whether or not a test ever exercises
// the font itself.
function fakeFontLoader(name: string) {
  return (_opts: { variable?: string } = {}) => ({
    className: `mock-font-${name}`,
    style: { fontFamily: `"mock-font-${name}"` },
    variable: `--mock-font-${name}`,
  });
}

export const DM_Sans = fakeFontLoader('dm-sans');
export const Space_Mono = fakeFontLoader('space-mono');
export const Noto_Sans_Devanagari = fakeFontLoader('noto-sans-devanagari');
