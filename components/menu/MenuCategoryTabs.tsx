'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CUSTOMER_MENU_CATEGORIES, MENU_CATEGORIES } from '@/lib/constants';

export function MenuCategoryTabs({
  active,
  onChange,
  includeInStore = false,
  leading = [],
  hidden = [],
  wrapOnWide = false,
}: {
  /** The current category slug, or null for none (neutral pills, e.g. while a
   * search is showing results from every category). */
  active: string | null;
  onChange: (category: string) => void;
  /** Show in-store-only categories (water bottles…) — the POS only. */
  includeInStore?: boolean;
  /** Extra tabs before the menu categories (the POS's "Quick picks"). */
  leading?: { slug: string; label: string }[];
  /** Categories with no pill: switched off for now (store_settings.hidden_categories)
   * or empty. */
  hidden?: readonly string[];
  /** From md up, wrap the pills onto more rows instead of scrolling sideways,
   * so a mouse user can reach every category (MENU-01). The customer menus
   * opt in; the POS keeps its single scrolling row. */
  wrapOnWide?: boolean;
}) {
  const categories = [
    ...leading,
    ...(includeInStore ? MENU_CATEGORIES : CUSTOMER_MENU_CATEGORIES).filter((c) => !hidden.includes(c.slug)),
  ];

  // On a phone the pills scroll sideways; with wrapOnWide, from md up they wrap
  // onto more rows so every category is visible without a scrollbar. Edge fades hint that the
  // strip scrolls, and show only on the side that has more to reveal.
  const stripRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const updateFade = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const left = strip.scrollLeft > 2;
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2;
    setFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  // Keep the active pill visible in the horizontally-scrolling strip — on a
  // phone, landing on /menu?category=desserts (or picking a later tab) used to
  // leave the highlighted pill scrolled off to the right. Scrolls only the
  // strip itself, never the page.
  useEffect(() => {
    const strip = stripRef.current;
    const pill = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (strip && pill) {
      const s = strip.getBoundingClientRect();
      const p = pill.getBoundingClientRect();
      if (p.left < s.left || p.right > s.right) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        strip.scrollBy({
          left: p.left - s.left - (s.width - p.width) / 2,
          behavior: reduce ? 'auto' : 'smooth',
        });
      }
    }
    updateFade();
  }, [active, categories.length, updateFade]);

  useEffect(() => {
    window.addEventListener('resize', updateFade);
    return () => window.removeEventListener('resize', updateFade);
  }, [updateFade]);

  // Arrow keys move focus along the strip (Home / End jump to the ends); Enter
  // or Space then picks the category, as on any button.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    let next = at;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else next = buttons.length - 1;
    buttons[next]?.focus();
  }

  return (
    <div className="relative">
      <div
        ref={stripRef}
        role="group"
        aria-label="Menu categories"
        onKeyDown={onKeyDown}
        onScroll={updateFade}
        className={'flex gap-2 overflow-x-auto pb-1' + (wrapOnWide ? ' md:flex-wrap md:overflow-visible' : '')}
        style={{ scrollbarWidth: 'none' }}
      >
        {categories.map((cat) => {
          const isActive = cat.slug === active;
          return (
            <button
              key={cat.slug}
              type="button"
              onClick={() => onChange(cat.slug)}
              aria-pressed={isActive}
              className={
                'inline-flex min-h-[44px] shrink-0 items-center rounded-full px-5 text-sm font-semibold transition-colors ' +
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
                (isActive
                  ? 'bg-tan-dark text-cream'
                  : 'border border-line text-charcoal hover:border-tan hover:text-tan-dark')
              }
            >
              {cat.label}
            </button>
          );
        })}
      </div>
      <div
        aria-hidden="true"
        className={
          'pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-cream to-transparent transition-opacity ' +
          (wrapOnWide ? 'md:hidden ' : '') +
          (fade.left ? 'opacity-100' : 'opacity-0')
        }
      />
      <div
        aria-hidden="true"
        className={
          'pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-cream to-transparent transition-opacity ' +
          (wrapOnWide ? 'md:hidden ' : '') +
          (fade.right ? 'opacity-100' : 'opacity-0')
        }
      />
    </div>
  );
}
