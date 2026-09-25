import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { DM_Sans, Space_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { SiteHeader } from '@/components/site/SiteHeader';
import { SiteFooter } from '@/components/site/SiteFooter';
import { SurfaceProvider } from '@/components/SurfaceLink';
import { surfaceForHost, type Surface } from '@/lib/routing/surface';
import './globals.css';

// DM Sans is the body/heading face (readable at small sizes, real weight
// range). Space Mono — the legacy site's only face (see index.html /
// css/style.css) — is kept as a brand accent for prices, bill amounts,
// order numbers and pickup codes, plus code/ID displays on staff surfaces.
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-space-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'HIOC.',
    template: '%s | HIOC.',
  },
  description: 'High on Coffee — order ahead for pickup.',
  // No `manifest` here on purpose — the only web app manifest in this repo
  // describes the POS, and it is declared in app/staff/layout.tsx so a customer
  // is never offered "Install HIOC POS". See app/pos.webmanifest/route.ts.
};

// Tints mobile browser chrome (address bar, task switcher) to match the
// brand instead of the OS default — a small but visible polish on phones,
// where this app is used most.
export const viewport: Viewport = {
  themeColor: '#232325',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Middleware sets x-surface. Resolved here, on the server, so client
  // components receive it as a prop on first render — deriving it from
  // window.location instead would render one href on the server and a
  // different one on the client, and hydration would fail on every nav bar.
  const h = headers();
  const surface: Surface =
    (h.get('x-surface') as Surface | null) ?? surfaceForHost(h.get('host'));

  return (
    <html lang="en" className={`${dmSans.variable} ${spaceMono.variable}`}>
      <body className="flex min-h-screen flex-col font-sans bg-cream text-charcoal">
        <SurfaceProvider surface={surface}>
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <SiteFooter />
          <Analytics />
        </SurfaceProvider>
      </body>
    </html>
  );
}
