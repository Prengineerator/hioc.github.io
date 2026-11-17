'use client';

// The wizard's live cup: Coffey's mug, reacting to what the customer picks.
// CoffeyMascot draws the cup itself (liquid, ice, straw, sugar cubes); the
// flavour and bite choices are emoji, which are unreliable inside SVG, so they
// ride on small round badges over the corners instead (only when the cup is big
// enough to carry them). Whenever the look changes the cup winks for ~600 ms —
// never on first mount. Decorative: aria-hidden; the chips say everything.

import { useEffect, useRef, useState } from 'react';
import { CoffeyMascot, type CoffeyExpression, type CoffeyLook } from '@/components/coffey/CoffeyMascot';
import { FLAVOUR_FAMILY_INFO } from '@/lib/suggest/traitVocabulary';

export const LIVE_CUP_BADGE_MIN_SIZE = 72;
const WINK_MS = 600;

const BITE_ICON = { dessert: '🧇', food: '🥪', both: '🍽️' } as const;

function Badge({ children, className, size }: { children: string; className: string; size: number }) {
  return (
    <span
      className={
        'flex items-center justify-center rounded-full border border-line bg-cream leading-none animate-scale-in ' +
        className
      }
      style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
    >
      {children}
    </span>
  );
}

export function LiveCup({
  look,
  size,
  expression = 'happy',
  animated,
}: {
  look?: CoffeyLook;
  size: number;
  expression?: CoffeyExpression;
  animated?: boolean;
}) {
  const [winking, setWinking] = useState(false);
  const lookKey = JSON.stringify(look ?? null);
  const previous = useRef(lookKey);

  useEffect(() => {
    if (previous.current === lookKey) return;
    previous.current = lookKey;
    setWinking(true);
    const timer = setTimeout(() => setWinking(false), WINK_MS);
    return () => clearTimeout(timer);
  }, [lookKey]);

  const badges = size >= LIVE_CUP_BADGE_MIN_SIZE;
  const badgeSize = Math.round(size * 0.3);
  const flavours = (look?.flavours ?? []).slice(0, 2);

  return (
    <span aria-hidden="true" className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <CoffeyMascot size={size} expression={winking ? 'wink' : expression} animated={animated} look={look} />
      {badges && flavours.length > 0 ? (
        <span className="absolute -right-1 -top-1 flex">
          {flavours.map((family, i) => (
            <span key={family} className="relative" style={{ marginLeft: i === 0 ? 0 : -badgeSize * 0.25 }}>
              <Badge size={badgeSize} className="">
                {FLAVOUR_FAMILY_INFO[family].emoji}
              </Badge>
            </span>
          ))}
        </span>
      ) : null}
      {badges && look?.bite ? (
        <Badge size={badgeSize} className="absolute -bottom-1 -left-1">
          {BITE_ICON[look.bite]}
        </Badge>
      ) : null}
    </span>
  );
}
