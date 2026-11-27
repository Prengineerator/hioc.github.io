import { NextResponse } from 'next/server';
import { notFound } from '@/lib/api/http';
import { flags } from '@/lib/flags';

// The customer site's web app manifest, so iPhone (iOS 16.4+) can add hioc.in to
// the Home Screen, which is the only way Safari delivers web push. Separate from
// /pos.webmanifest and linked only from customer pages (app/layout.tsx), never
// from /staff or /owner. 404 while the webPush flag is off.
export const dynamic = 'force-dynamic';

export function GET() {
  if (!flags.webPush) return notFound();
  return NextResponse.json(
    {
      id: '/',
      name: 'HIOC.',
      short_name: 'HIOC.',
      description: 'High on Coffee: order ahead for pickup.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#232325',
      theme_color: '#232325',
      icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
    },
    { headers: { 'content-type': 'application/manifest+json' } },
  );
}
