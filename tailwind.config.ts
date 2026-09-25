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
        // Brand palette — exact hex values reused from the legacy site's css/style.css,
        // with one deliberate exception: `muted` was darkened from the legacy #828282
        // (~3.9:1 on white, fails WCAG AA for text) to #6b6560, a warm grey that keeps
        // the brand's feel while passing AA (~5.7:1 on white). Do not invent other
        // shades here; `tan-dark` is the other derived exception (a manually computed
        // ~12% darkened tan) used only for hover states.
        charcoal: '#232325',
        tan: '#ad825e',
        'tan-dark': '#96714f',
        cream: '#ffffff',
        muted: '#6b6560',
        // Two small neutral extensions (design-system pass) that formalize
        // hex values already used ad hoc throughout the app as arbitrary
        // Tailwind values (`border-[#e5e5e5]`, `bg-[#f6efe9]`) — naming them
        // gives new components (Card, Input, Modal, ...) a single source of
        // truth without touching the arbitrary-value call sites, which keep
        // working unchanged.
        line: '#e5e5e5', // hairline borders (cards, inputs, dividers)
        surface: '#f6efe9', // tan-tinted soft background (banners, hover fills)
      },
      fontFamily: {
        // DM Sans (loaded via next/font/google in app/layout.tsx, --font-dm-sans) is
        // the default face for headings and body copy — replaces the legacy site's
        // all-monospace look (css/style.css, index.html) with a real weight range and
        // better small-size readability.
        sans: ['var(--font-dm-sans)', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        // Space Mono (also loaded in app/layout.tsx, --font-space-mono) is kept as a
        // brand accent: prices, bill amounts, order numbers, pickup codes (usually
        // paired with tabular-nums), and code/ID-style displays on staff surfaces.
        mono: ['var(--font-space-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        // Tailwind defaults are sufficient (rounded-md for buttons/inputs/cards,
        // rounded-full for pill tabs/badges) — no custom radius scale needed.
      },
      boxShadow: {
        // Slightly warmer/softer than Tailwind's default shadow-sm, tuned to
        // the charcoal brand color instead of pure black. `card` is the
        // resting elevation for Card/MenuItemCard; `elevated` is for
        // popovers/modals and Card's hover state.
        card: '0 1px 2px 0 rgb(35 35 37 / 0.06), 0 1px 3px 0 rgb(35 35 37 / 0.06)',
        elevated: '0 12px 32px -8px rgb(35 35 37 / 0.28)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96) translateY(4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
      },
      animation: {
        // Used by components/ui/Modal.tsx for the overlay + panel entrance.
        'fade-in': 'fade-in 150ms ease-out',
        'scale-in': 'scale-in 150ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
