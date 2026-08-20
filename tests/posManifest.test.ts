import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { POS_MANIFEST } from '@/lib/pos/manifest';
import { isHostAgnostic, rewriteForSurface } from '@/lib/routing/surface';

// DEV-1 — the manifest is the installed POS's entire configuration, and every
// way it can be wrong is invisible until someone at the counter launches the
// app and gets the wrong thing: a blank tile, the customer site, or a window
// that kicks every tap into a browser. None of these are type errors, so they
// are assertions instead.

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/** Width/height straight out of the PNG IHDR chunk — no image library needed. */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  // 8-byte signature, 4-byte length, 4-byte 'IHDR', then width and height.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('the POS web app manifest', () => {
  it('launches onto the staff board, not the customer site', () => {
    expect(POS_MANIFEST.start_url).toBe('/staff');
    expect(POS_MANIFEST.display).toBe('standalone');
  });

  it('scopes the whole origin so subdomain nav stays inside the app', () => {
    // On staff.hioc.in the staff nav renders prefix-free hrefs ('/orders'), so a
    // '/staff' scope would treat every tap as leaving the app.
    expect(POS_MANIFEST.scope).toBe('/');
    expect(POS_MANIFEST.start_url!.startsWith(POS_MANIFEST.scope!)).toBe(true);
    for (const s of POS_MANIFEST.shortcuts ?? []) {
      expect(s.url.startsWith(POS_MANIFEST.scope!)).toBe(true);
    }
  });

  it('ships both installable sizes, each declared for one purpose only', () => {
    const icons = POS_MANIFEST.icons ?? [];
    // Chrome's installability bar: a 192 and a 512. Maskable is what stops
    // Android from drawing a white box around the tile.
    for (const purpose of ['any', 'maskable']) {
      const sizes = icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
      expect(sizes).toContain('192x192');
      expect(sizes).toContain('512x512');
    }
    // 'any maskable' on one entry means one bitmap serves both, and Chrome warns
    // about it precisely because it cannot.
    for (const icon of icons) {
      expect(icon.purpose).not.toContain(' ');
    }
  });

  it('points at icon files that exist and are the size they claim', () => {
    for (const icon of POS_MANIFEST.icons ?? []) {
      const file = path.join(PUBLIC_DIR, String(icon.src));
      expect(existsSync(file), `${icon.src} is missing from public/`).toBe(true);
      const [w, h] = String(icon.sizes).split('x').map(Number);
      expect(pngSize(file)).toEqual({ width: w, height: h });
    }
  });

  it('is served from a URL no surface rewrite can move', () => {
    // An installed app resolves start_url and icons against the manifest's own
    // URL. If staff.hioc.in/pos.webmanifest were rewritten to
    // /staff/pos.webmanifest, the served document would still be found — but
    // the routing rule is what guarantees it, so pin it.
    expect(isHostAgnostic('/pos.webmanifest')).toBe(true);
    expect(rewriteForSurface('staff', '/pos.webmanifest')).toBeNull();
    expect(rewriteForSurface('owner', '/pos.webmanifest')).toBeNull();
  });
});
