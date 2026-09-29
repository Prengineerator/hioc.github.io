'use client';

import { useEffect, useRef } from 'react';
import { CUSTOMER_MENU_CATEGORIES, MENU_CATEGORIES } from '@/lib/constants';

export function MenuCategoryTabs({
  active,
  onChange,
  includeInStore = false,
  leading = [],
  hidden = [],
}: {
  active: string;
  onChange: (category: string) => void;
  /** Show in-store-only categories (water bottles…) — the POS only. */
  includeInStore?: boolean;
  /** Extra tabs before the menu categories (the POS's "Quick picks"). */
  leading?: { slug: string; label: string }[];
  /** Categories switched off for now (store_settings.hidden_categories). */
  hidden?: readonly string[];
}) {
  const categories = [
    ...leading,
    ...(includeInStore ? MENU_CATEGORIES : CUSTOMER_MENU_CATEGORIES).filter((c) => !hidden.includes(c.slug)),
  ];

  // Keep the active pill visible in the horizontally-scrolling strip — on a
  // phone, landing on /menu?category=desserts (or picking a later tab) used to
  // leave the highlighted pill scrolled off to the right. Scrolls only the
  // strip itself, never the page.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const pill = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!strip || !pill) return;
    const s = strip.getBoundingClientRect();
    const p = pill.getBoundingClientRect();
    if (p.left < s.left || p.right > s.right) {
      strip.scrollBy({ left: p.left - s.left - (s.width - p.width) / 2, behavior: 'smooth' });
    }
  }, [active]);

  return (
    <div
      ref={stripRef}
      className="flex gap-2 overflow-x-auto pb-1"
      style={{ scrollbarWidth: 'none' }}
    >
      {categories.map((cat) => {
        const isActive = cat.slug === active;
        return (
          <button
            key={cat.slug}
            type="button"
            onClick={() => onChange(cat.slug)}
            aria-current={isActive ? 'true' : undefined}
            className={
              'inline-flex min-h-[40px] shrink-0 items-center rounded-full px-5 text-sm font-semibold transition-colors ' +
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
              (isActive
                ? 'bg-tan text-cream'
                : 'border border-line text-charcoal hover:border-tan hover:text-tan')
            }
          >
            {cat.label}
          </button>
        );
      })}
    </div>
  );
}
