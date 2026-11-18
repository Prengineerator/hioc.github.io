'use client';

// Tiny client helpers for the /shop product-line cards: jump to an ordering
// section (smooth unless the user asked for reduced motion), keep the hash and
// the segmented control in step, and move focus to the section heading so
// keyboard and screen-reader users land in the right place.

import type { ReactNode } from 'react';
import { SELECT_PACK_EVENT } from '@/lib/shop/productLines';

function jump(hash: 'instant' | 'home-blend', headingId: string, productId?: string) {
  if (productId) window.dispatchEvent(new CustomEvent(SELECT_PACK_EVENT, { detail: { productId } }));
  const section = document.getElementById(hash);
  if (!section) return false;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  if (window.location.hash !== `#${hash}`) {
    window.history.pushState(null, '', `#${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
  document.getElementById(headingId)?.focus({ preventScroll: true });
  return true;
}

export function JumpLink({
  hash,
  headingId,
  className,
  children,
}: {
  hash: 'instant' | 'home-blend';
  headingId: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <a
      href={`#${hash}`}
      className={className}
      onClick={(e) => {
        if (jump(hash, headingId)) e.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

export function PackTileButton({
  productId,
  label,
  className,
  children,
}: {
  productId: string;
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} className={className} onClick={() => jump('home-blend', 'home-blend-heading', productId)}>
      {children}
    </button>
  );
}
