// Menu item photo with a tasteful placeholder (C6). Fixed aspect-ratio box
// so the layout never shifts (no CLS) whether or not a photo exists / has
// loaded yet — plain <img loading="lazy"> keeps the menu grid fast without
// pulling in next/image's remote-domain config for Supabase storage URLs.

import type { MenuItem } from '@/lib/types';

export function MenuItemImage({ item }: { item: Pick<MenuItem, 'name' | 'image_url'> }) {
  return (
    <div className="mb-3 aspect-[4/3] w-full overflow-hidden rounded-md bg-[#f6efe9]">
      {item.image_url ? (
        <img
          src={item.image_url}
          alt={item.name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
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
