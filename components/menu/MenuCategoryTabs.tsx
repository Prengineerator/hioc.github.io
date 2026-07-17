'use client';

import { MENU_CATEGORIES } from '@/lib/constants';

export function MenuCategoryTabs({
  active,
  onChange,
}: {
  active: string;
  onChange: (category: string) => void;
}) {
  return (
    <div
      className="flex gap-2 overflow-x-auto pb-1"
      style={{ scrollbarWidth: 'none' }}
    >
      {MENU_CATEGORIES.map((cat) => {
        const isActive = cat.slug === active;
        return (
          <button
            key={cat.slug}
            type="button"
            onClick={() => onChange(cat.slug)}
            aria-current={isActive ? 'true' : undefined}
            className={
              'shrink-0 rounded-full px-5 py-2 text-sm font-bold transition-colors ' +
              (isActive
                ? 'bg-tan text-cream'
                : 'border border-[#e5e5e5] text-charcoal hover:border-tan hover:text-tan')
            }
          >
            {cat.label}
          </button>
        );
      })}
    </div>
  );
}
