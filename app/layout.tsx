import type { Metadata, Viewport } from 'next';
import { Space_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { SiteHeader } from '@/components/site/SiteHeader';
import { SiteFooter } from '@/components/site/SiteFooter';
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
  return (
    <html lang="en" className={spaceMono.variable}>
      <body className="flex min-h-screen flex-col font-sans bg-cream text-charcoal">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
        <Analytics />
      </body>
    </html>
  );
}
