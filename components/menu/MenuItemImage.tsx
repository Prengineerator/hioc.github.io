// Menu item photo (C6). Fixed aspect-ratio box so the layout never shifts (no
// CLS) while a photo loads — plain <img> keeps the menu grid fast without
// pulling in next/image's remote-domain config for Supabase storage URLs.
// A Skeleton shimmer sits behind the photo until it has loaded. The photo
// itself is never hidden waiting for JavaScript (no opacity gate), so it shows
// with scripting off and as soon as the browser has the bytes.
//
// An item with no photo (or one that fails to load) renders NO image slot at
// all by default, so a menu row reads as clean text rather than a placeholder
// cup on beige; callers lay out around the absent box. A caller whose layout
// needs the slot filled (the checkout's "Pairs well with" rows) passes
// missing="placeholder" for the old cup tile.

'use client';

import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import type { MenuItem } from '@/lib/types';

export function MenuItemImage({
  item,
  className = 'mb-3 aspect-[4/3] w-full',
  eager = false,
  missing = 'hide',
}: {
  item: Pick<MenuItem, 'name' | 'image_url'>;
  className?: string;
  /** Load now instead of lazily: for the first photos on screen. */
  eager?: boolean;
  /** No photo: render nothing (default), or the cup placeholder tile. */
  missing?: 'hide' | 'placeholder';
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // A cached photo can finish before hydration, so its onLoad never reaches us.
  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) setLoaded(true);
  }, []);

  if (!item.image_url || failed) {
    if (missing === 'hide') return null;
    return (
      <div className={`relative overflow-hidden rounded-md bg-surface ${className}`}>
        <div aria-hidden="true" className="flex h-full w-full items-center justify-center text-3xl text-tan-dark">
          ☕
        </div>
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden rounded-md bg-surface ${className}`}>
      {!loaded ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      <img
        ref={imgRef}
        src={item.image_url}
        alt={item.name}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className="relative h-full w-full object-cover"
      />
    </div>
  );
}
