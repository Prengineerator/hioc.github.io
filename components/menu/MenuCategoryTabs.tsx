'use client';

import { CUSTOMER_MENU_CATEGORIES, MENU_CATEGORIES } from '@/lib/constants';

export function MenuCategoryTabs({
  active,
  onChange,
  includeInStore = false,
  leading = [],
}: {
  active: string;
  onChange: (category: string) => void;
  /** Show in-store-only categories (water bottles…) — the POS only. */
  includeInStore?: boolean;
  /** Extra tabs before the menu categories (the POS's "Quick picks"). */
  leading?: { slug: string; label: string }[];
}) {
  const categories = [...leading, ...(includeInStore ? MENU_CATEGORIES : CUSTOMER_MENU_CATEGORIES)];
  return (
    <div
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
