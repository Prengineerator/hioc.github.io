'use client';

// "How sweet?": a glass that fills. Dragging (or tapping) on it sets the level
// from the pointer's height: bottom third Not sweet, middle Lightly sweet, top
// Sweet. It is a pointer convenience only and is aria-hidden: the three chips
// beside it are the accessible control (tap to choose, tap again to clear), which
// is also the alternative to dragging.
//
// `touch-action: none` is set on the glass element ONLY, so a drag on it does not
// scroll the page while the rest of the page scrolls normally. The pointer is
// captured on pointerdown so the drag keeps working if the finger leaves the
// glass. A level that is disabled (greyed out for this combination) cannot be
// chosen: the drag keeps the last level it allowed.
//
// Drawn as inline SVG in palette tokens (fill-/stroke- utilities, no hex). The
// liquid is one group moved with a CSS transform transition (neutralised under
// prefers-reduced-motion by the global rule).

import { useId, useRef, type PointerEvent } from 'react';
import { glassFraction, glassLevel, type SweetnessChoice } from '@/components/suggest/wizardModel';
import type { FacetOption } from '@/lib/suggest/facets';

const GLASS = 'M8 6 L56 6 L51 89 Q50.6 92 47.5 92 L16.5 92 Q13.4 92 13 89 Z';

// Where the liquid's surface sits (viewBox y) for each level; unset parks it
// below the glass.
const SURFACE_Y: Record<SweetnessChoice | 'empty', number> = {
  empty: 100,
  none: 78,
  light: 49,
  sweet: 18,
};
const CUBES: Record<SweetnessChoice, number> = { none: 1, light: 2, sweet: 3 };
// Cube positions relative to the surface.
const CUBE_AT = [
  { x: 19, y: 5, r: -10 },
  { x: 34, y: 12, r: 12 },
  { x: 24, y: 24, r: 6 },
] as const;

export function SweetnessGlass({
  value,
  off,
  onChange,
}: {
  value: SweetnessChoice | null;
  off: ReadonlySet<FacetOption>;
  onChange: (level: SweetnessChoice) => void;
}) {
  const clipId = `glass-clip-${useId().replace(/:/g, '')}`;
  const dragging = useRef(false);
  // The last level this drag allowed (starts at what is chosen).
  const last = useRef<SweetnessChoice | null>(value);
  last.current = dragging.current ? last.current : value;

  function apply(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const level = glassLevel(glassFraction(e.clientY, rect.top, rect.height), off, last.current);
    if (level && level !== last.current) {
      last.current = level;
      onChange(level);
    }
  }

  function end(e: PointerEvent<HTMLDivElement>) {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const surface = SURFACE_Y[value ?? 'empty'];

  return (
    <div aria-hidden="true" className="flex shrink-0 flex-col items-center">
      <div
        data-part="glass"
        className="select-none"
        style={{
          touchAction: 'none',
          width: 88,
          height: 132,
          cursor: 'ns-resize',
        }}
        onPointerDown={(e) => {
          dragging.current = true;
          last.current = value;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          apply(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) apply(e);
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <svg viewBox="0 0 64 96" width="88" height="132" focusable="false" className="block">
          <clipPath id={clipId}>
            <path d={GLASS} />
          </clipPath>
          <path d={GLASS} className="fill-cream" />
          <g clipPath={`url(#${clipId})`}>
            <g
              data-part="liquid"
              style={{
                transform: `translateY(${surface}px)`,
                transition: 'transform 300ms ease-out',
              }}
            >
              <path d="M0 0 Q8 -3.5 16 0 T32 0 T48 0 T64 0 V100 H0 Z" className="fill-tan" />
              {value
                ? Array.from({ length: CUBES[value] }, (_, i) => (
                    <g
                      key={`${value}-${i}`}
                      data-part="glass-cube"
                      className="animate-scale-in"
                      style={{
                        transformBox: 'fill-box',
                        transformOrigin: 'center',
                      }}
                    >
                      <rect
                        x={CUBE_AT[i].x}
                        y={CUBE_AT[i].y}
                        width="8"
                        height="8"
                        rx="1.5"
                        strokeWidth="1.8"
                        transform={`rotate(${CUBE_AT[i].r} ${CUBE_AT[i].x + 4} ${CUBE_AT[i].y + 4})`}
                        className="fill-cream stroke-charcoal"
                      />
                    </g>
                  ))
                : null}
            </g>
            {value === null ? (
              <line
                data-part="fill-line"
                x1="12"
                y1="63"
                x2="52"
                y2="63"
                strokeWidth="2"
                strokeDasharray="4 3"
                strokeLinecap="round"
                className="stroke-tan"
              />
            ) : null}
          </g>
          <path d={GLASS} fill="none" strokeWidth="3" strokeLinejoin="round" className="stroke-charcoal" />
        </svg>
      </div>
      <span className="mt-1 h-4 text-xs leading-4 text-muted">{value === null ? 'Drag to fill' : ''}</span>
    </div>
  );
}
