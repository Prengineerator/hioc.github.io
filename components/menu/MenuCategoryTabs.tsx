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
              'inline-flex min-h-[40px] shrink-0 items-center rounded-full px-5 text-sm font-bold transition-colors ' +
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
