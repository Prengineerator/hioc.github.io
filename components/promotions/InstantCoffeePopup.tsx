'use client';

// New-launch popup for HIOC. Premium Instant Coffee (owner request
// 2026-11-06): the owner's poster opens over the home page when someone lands
// on it, instead of sitting on the page all the time. It shows once per visit
// (sessionStorage, the same per-tab-session rule AnnouncementBanner uses for
// dismissals): closing it, or moving around the site and coming back to the
// home page, doesn't bring it back until the next visit. The jars are sold at
// the counter, not on the online menu, so there's no "add to cart" here. Like
// the poster, it sends people to the counter.
//
// To take it down when the offer ends, delete <InstantCoffeePopup /> from
// app/page.tsx along with this file and public/images/promo-instant-coffee.jpg.

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { buttonVariants } from '@/components/ui/Button';
import { useDialogBehavior } from '@/components/ui/useDialogBehavior';

const SEEN_KEY = 'hioc:promo-popup:instant-coffee';
const POSTER_SRC = '/images/promo-instant-coffee.jpg';
// Matches the poster's on-screen width below, so the hidden preload and the
// dialog ask next/image for the same file and the dialog opens from cache.
const POSTER_SIZES = '(min-width: 528px) 480px, calc(100vw - 2rem)';
// Give the page a moment to appear before the popup covers it.
const OPEN_DELAY_MS = 800;

function alreadySeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // sessionStorage unavailable (private mode etc.): it shows once per page load instead.
  }
}

type Phase = 'idle' | 'preloading' | 'open' | 'closed';

export function InstantCoffeePopup() {
  const [phase, setPhase] = useState<Phase>('idle');
  const mountedAt = useRef(0);
  const openTimer = useRef<ReturnType<typeof setTimeout>>();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  const open = phase === 'open';
  const close = () => setPhase('closed');
  useDialogBehavior(open, close, panelRef);

  // Decided after mount, never during SSR, so the server HTML and the first
  // client render agree (both render nothing).
  useEffect(() => {
    mountedAt.current = Date.now();
    if (!alreadySeen()) setPhase('preloading');
    return () => clearTimeout(openTimer.current);
  }, []);

  // Open only once the poster has downloaded, so it never appears as an empty
  // box that fills in. If the image fails, the popup stays away.
  function handlePosterLoaded() {
    const wait = Math.max(0, OPEN_DELAY_MS - (Date.now() - mountedAt.current));
    openTimer.current = setTimeout(() => {
      markSeen();
      setPhase('open');
    }, wait);
  }

  if (phase === 'preloading') {
    return (
      <div aria-hidden="true" className="hidden">
        <Image
          src={POSTER_SRC}
          alt=""
          width={1024}
          height={1536}
          sizes={POSTER_SIZES}
          loading="eager"
          onLoad={handlePosterLoaded}
          onError={() => setPhase('closed')}
        />
      </div>
    );
  }

  if (!open || typeof document === 'undefined') return null;

  // Portal to <body>, as Modal does, so the fixed overlay covers the whole
  // viewport whatever the home page's own layout is.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-4 py-8">
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        className="fixed inset-0 animate-fade-in bg-charcoal/60"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        // The poster is as wide as fits: the screen less its gutter, or the
        // height left once the gutter and the button bar are taken off
        // (scaled by the poster's 2:3 shape), or 480px, whichever is smallest.
        // So it always shows whole, without scrolling, on a small phone and on
        // a short laptop screen alike.
        style={{ width: 'min(calc(100vw - 2rem), calc((100svh - 9rem) * 2 / 3), 30rem)' }}
        className="relative flex animate-scale-in flex-col overflow-hidden rounded-md bg-cream shadow-elevated outline-none"
      >
        <h2 id={titleId} className="sr-only">
          New launch: HIOC. Premium Instant Coffee
        </h2>
        <div id={descId} className="sr-only">
          <p>
            Café-quality coffee, instantly. 100% Arabica, freeze-dried to lock in the rich aroma
            and flavour. 50 g jars in three flavours: Signature Classic, Nutty Hazelnut and French
            Vanilla.
          </p>
          <p>Regular price ₹399 a jar. Launch offer: 1 jar ₹299, 2 jars ₹499, 3 jars ₹599.</p>
          <p>Ask at the counter for a free trial cup!</p>
        </div>

        <Image
          src={POSTER_SRC}
          alt="Poster: three 50 g jars of HIOC. Premium Instant Coffee on a wooden board beside a cup of coffee."
          width={1024}
          height={1536}
          sizes={POSTER_SIZES}
          loading="eager"
          className="block h-auto w-full"
        />

        <button
          type="button"
          aria-label="Close"
          data-dialog-close
          onClick={close}
          className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-cream/90 text-2xl leading-none text-charcoal shadow-card transition-colors hover:bg-cream hover:text-tan-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
        >
          &times;
        </button>

        <div className="border-t border-line p-3">
          <button type="button" onClick={close} className={buttonVariants({ fullWidth: true })}>
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
