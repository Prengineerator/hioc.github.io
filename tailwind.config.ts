import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand palette — exact hex values reused from the legacy site's css/style.css.
        // Do not invent new shades here; `tan-dark` is the single derived exception
        // (a manually computed ~12% darkened tan) used only for hover states.
        charcoal: '#232325',
        tan: '#ad825e',
        'tan-dark': '#96714f',
        cream: '#ffffff',
        muted: '#828282',
      },
      fontFamily: {
        // Legacy site (css/style.css, index.html) loads "Space Mono" from Google Fonts
        // and uses it for both headings and body copy — mirrored here via next/font/google
        // in app/layout.tsx, which sets the --font-space-mono CSS variable.
        sans: ['var(--font-space-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        // Tailwind defaults are sufficient (rounded-md for buttons/inputs/cards,
        // rounded-full for pill tabs/badges) — no custom radius scale needed.
      },
    },
  },
  plugins: [],
};

export default config;
