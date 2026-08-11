import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Space_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { SiteHeader } from '@/components/site/SiteHeader';
import { SiteFooter } from '@/components/site/SiteFooter';
import { SurfaceProvider } from '@/components/SurfaceLink';
import { surfaceForHost, type Surface } from '@/lib/routing/surface';
import './globals.css';

// Legacy site (see index.html / css/style.css) loads "Space Mono" from Google
// Fonts and uses it for both headings and body copy — reused here via
// next/font/google (instead of a <link> tag) for continuity of brand feel.
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
    <html lang="en" className={spaceMono.variable}>
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
