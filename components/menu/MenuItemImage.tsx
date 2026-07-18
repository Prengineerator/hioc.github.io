// Menu item photo with a tasteful placeholder (C6). Fixed aspect-ratio box
// so the layout never shifts (no CLS) whether or not a photo exists / has
// loaded yet — plain <img loading="lazy"> keeps the menu grid fast without
// pulling in next/image's remote-domain config for Supabase storage URLs.
// A Skeleton shimmer covers the box until the photo actually finishes
// loading, so slow connections show a soft placeholder instead of a blank
// tile popping straight to the final image.

'use client';

import { useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import type { MenuItem } from '@/lib/types';

export function MenuItemImage({ item }: { item: Pick<MenuItem, 'name' | 'image_url'> }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="relative mb-3 aspect-[4/3] w-full overflow-hidden rounded-md bg-surface">
      {item.image_url ? (
        <>
          {!loaded ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
          <img
            src={item.image_url}
            alt={item.name}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            className={
              'h-full w-full object-cover transition-opacity duration-200 ' +
              (loaded ? 'opacity-100' : 'opacity-0')
            }
          />
        </>
      ) : (
        <div
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center text-3xl text-tan"
        >
          ☕
        </div>
      )}
    </div>
  );
}
