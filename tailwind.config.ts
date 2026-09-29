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
        // with deliberate exceptions: `muted` was darkened from the legacy #828282
        // (~3.9:1 on white, fails WCAG AA for text) to #6b6560, a warm grey that keeps
        // the brand's feel while passing AA (~5.7:1 on white).
        //
        // Tan comes in three roles (code-revamp 2026-09, SHR-UX-3). The brand tan
        // #ad825e is only ~3.4:1 against white (and ~3.0:1 on `surface`) — fine for
        // decoration, below AA for text. So:
        //   tan         — decoration only: bars, dots, borders, rings, progress
        //                 fills, focus outlines. Never text, never a fill behind text.
        //   tan-dark    — anything that carries text: tan-coloured text/links, and
        //                 fills with white text (primary buttons, active pills,
        //                 badges). 5.3:1 on white, 4.6:1 on `surface`.
        //   tan-darker  — hover/pressed state of a `tan-dark` fill (6.9:1).
        // Exception: on the charcoal chrome (StaffHeader, SiteFooter, LockScreen)
        // keep plain `tan` text — it's 4.6:1 there, and the darker shades fail.
        // Do not invent other shades here.
        charcoal: '#232325',
        tan: '#ad825e',
        'tan-dark': '#8a6446',
        'tan-darker': '#73533a',
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
        // PIN-2 — the lock screen's wrong-PIN feedback (components/staff/pin/
        // LockScreen.tsx). The global `prefers-reduced-motion: reduce` rule in
        // app/globals.css already forces every animation's duration to
        // 0.01ms, so this needs no separate reduced-motion handling here.
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-6px)' },
          '40%, 80%': { transform: 'translateX(6px)' },
        },
        // Coffey's steam wisps (components/coffey/CoffeyMascot.tsx): a gentle
        // upward drift that fades in and out. Each wisp's resting style (its
        // base opacity) is what shows under `prefers-reduced-motion`, where the
        // global rule in app/globals.css cuts every animation to one 0.01ms
        // pass — so the wisps sit still and visible rather than disappearing.
        steam: {
          '0%': { opacity: '0', transform: 'translateY(3px)' },
          '35%': { opacity: '0.9' },
          '100%': { opacity: '0', transform: 'translateY(-6px)' },
        },
      },
      animation: {
        // Used by components/ui/Modal.tsx for the overlay + panel entrance.
        'fade-in': 'fade-in 150ms ease-out',
        'scale-in': 'scale-in 150ms ease-out',
        shake: 'shake 400ms ease-in-out',
        steam: 'steam 2.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
