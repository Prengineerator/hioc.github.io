import { useId } from 'react';
import type { FlavourFamily } from '@/lib/suggest/types';

// Coffey, the HIOC. pick-helper (docs/COFFEY-SPEC.md §6.1): a friendly coffee
// cup drawn as one inline SVG, in brand tokens only — a charcoal outline, a
// white cup, a tan-dark coffee top and handle, and steam wisps in `tan`.
//
// Colour comes from Tailwind's fill-/stroke- utilities (never a hex) so the
// mascot can only ever use the palette. `tan` is decoration only, which is
// exactly what the steam and the cheeks are; nothing here carries text.
//
// One shape for every size: it has to read at ~22px inside a button and still
// look charming at 160px on /coffey. So: no gradients, no filters, a single
// outline weight, and a face made of a few big simple shapes.
//
// No 'use client' and no client-only hooks (useId is fine on the server), so
// server components — the home page teaser and /coffey — can render it.
//
// Motion: only the steam moves, through the `steam` Tailwind animation. It is a
// CSS animation on purpose (not SMIL <animate>): the global
// `prefers-reduced-motion` rule in app/globals.css reaches CSS animations but
// not SMIL, and under it the wisps simply rest at their base opacity.

export type CoffeyExpression = 'happy' | 'thinking' | 'wink';

/** What the customer has chosen so far (the wizard's "live cup"). Optional on the
 * mascot: with no `look` it renders exactly as it always has. `flavours` and
 * `bite` are NOT drawn in the SVG (emoji in SVG text is unreliable); LiveCup
 * shows them as badges around it. */
export interface CoffeyLook {
  temperature?: 'hot' | 'iced' | null;
  coffee?: 'strong' | 'smooth' | 'none' | null;
  sweetness?: 'none' | 'light' | 'sweet' | null;
  flavours?: FlavourFamily[];
  bite?: 'dessert' | 'food' | 'both' | null;
}

export interface CoffeyMascotProps {
  /** Rendered width and height in px. */
  size?: number;
  expression?: CoffeyExpression;
  /** Steam drift. Off, the wisps sit still. */
  animated?: boolean;
  /** The live cup: liquid colour, ice and a straw, sugar cubes. */
  look?: CoffeyLook;
  /** Gives the mascot an accessible name (role="img"). Without it the mascot is
   * decorative and hidden from assistive tech — right for most uses, where the
   * text next to it already says everything. */
  title?: string;
  className?: string;
}

// The mug: rounded, slightly wider at the rim, with a small flat base. Drawn
// once here because it is used three times (fill, shading clip, outline).
const BODY = 'M17 44 C17 78 24 108 42 108 L58 108 C76 108 83 78 83 44 Z';
const HANDLE = 'M79 58 C99 53 105 64 102 74 C99 84 91 88 77 86';

// Three wisps over the cup. Each is a gentle S-curve; the side ones are a touch
// shorter, and the negative delays start them at different points of the cycle
// so they never puff in unison. (A delay is not neutralised by the reduced-
// motion rule, but a negative one means the animation is already over the
// moment it starts, so the resting state is all that ever shows.)
const WISPS = [
  { d: 'M38 29 C33 24 43 20 38 15', delay: '-1.6s' },
  { d: 'M50 27 C44 21 56 16 50 9', delay: '0s' },
  { d: 'M62 29 C57 24 67 20 62 15', delay: '-0.8s' },
] as const;

export function CoffeyMascot({
  size = 48,
  expression = 'happy',
  animated = true,
  look,
  title,
  className = '',
}: CoffeyMascotProps) {
  const iced = look?.temperature === 'iced';
  const coffee = look?.coffee ?? null;
  const sugarCubes = look?.sweetness === 'light' ? 1 : look?.sweetness === 'sweet' ? 2 : 0;
  const liquidFill =
    coffee === 'strong'
      ? 'fill-charcoal'
      : coffee === 'smooth'
        ? 'fill-tan'
        : coffee === 'none'
          ? 'fill-surface stroke-tan-dark'
          : 'fill-tan-dark';
  // useId() yields ids like ":r3:"; the colons are legal in an id but awkward
  // inside url(#…), so strip them.
  const uid = useId().replace(/:/g, '');
  const titleId = `coffey-title-${uid}`;
  const clipId = `coffey-body-${uid}`;

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      focusable="false"
      role={title ? 'img' : undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-hidden={title ? undefined : true}
      className={['shrink-0', className].filter(Boolean).join(' ')}
    >
      {title ? <title id={titleId}>{title}</title> : null}

      {/* Steam — decoration, so plain tan is allowed here. Iced drinks have none. */}
      {iced ? null : (
        <g fill="none" strokeWidth="3.5" strokeLinecap="round" className="stroke-tan">
          {WISPS.map((w) => (
            <path
              key={w.d}
              d={w.d}
              className={animated ? 'animate-steam opacity-80' : 'opacity-80'}
              style={animated ? { animationDelay: w.delay } : undefined}
            />
          ))}
        </g>
      )}

      {/* Handle first, so the cup body sits over where it joins: a charcoal tube
          with a tan-dark core, which leaves a charcoal edge on both sides. */}
      <path d={HANDLE} fill="none" strokeWidth="10" strokeLinecap="round" className="stroke-charcoal" />
      <path d={HANDLE} fill="none" strokeWidth="4" strokeLinecap="round" className="stroke-tan-dark" />

      {/* Sugar cubes standing beside the base (live cup only). Drawn before the
          body so the cup overlaps them and they read as tucked beside it. */}
      {Array.from({ length: sugarCubes }, (_, i) => (
        <g
          key={i}
          data-part="sugar-cube"
          className="animate-scale-in"
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        >
          <rect
            x={i === 0 ? 7 : 10}
            y={i === 0 ? 94 : 79}
            width="15"
            height="15"
            rx="2.5"
            strokeWidth="2.5"
            transform={i === 0 ? undefined : 'rotate(-9 17.5 86.5)'}
            className="fill-cream stroke-charcoal"
          />
        </g>
      ))}

      {/* Cup body. The `surface` crescent down the right and along the bottom
          gives the white cup some volume: the body, clipped to itself, with a
          cream copy nudged up and to the left over a surface-coloured fill.
          The outline goes on last so it stays crisp over both. */}
      <path d={BODY} className="fill-cream" />
      <clipPath id={clipId}>
        <path d={BODY} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect x="10" y="40" width="80" height="72" className="fill-surface" />
        <path d={BODY} transform="translate(-4.5 -3)" className="fill-cream" />
      </g>
      <path d={BODY} fill="none" strokeWidth="3" strokeLinejoin="round" className="stroke-charcoal" />

      {/* Rim (its ellipse also hides the body path's closing edge), with the
          coffee sitting just below the lip and a small shine on it. */}
      <ellipse cx="50" cy="44" rx="33" ry="9.5" strokeWidth="3" className="fill-cream stroke-charcoal" />
      <ellipse
        cx="50"
        cy="45"
        rx="27"
        ry="5.5"
        strokeWidth={coffee === 'none' ? 2 : undefined}
        className={look ? `${liquidFill} transition-colors duration-300` : 'fill-tan-dark'}
      />
      <path
        d="M36 44 Q41 41.2 47 41.6"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-tan opacity-90"
      />

      {coffee === 'smooth' ? (
        <path
          data-part="swirl"
          d="M40 45.5 Q45 42.5 50 45.5 T60 45.5"
          fill="none"
          strokeWidth="2.2"
          strokeLinecap="round"
          className="stroke-cream"
        />
      ) : null}

      {/* Iced: a straw leaning out of the cup and two cubes sitting in the
          liquid, breaking the rim. */}
      {iced ? (
        <>
          <g
            data-part="straw"
            className="animate-scale-in"
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            <path d="M68 44 L85 8" fill="none" strokeWidth="7" strokeLinecap="round" className="stroke-charcoal" />
            <path d="M68 44 L85 8" fill="none" strokeWidth="3.5" strokeLinecap="round" className="stroke-tan-dark" />
          </g>
          <g
            data-part="ice-cube"
            className="animate-scale-in"
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            <rect
              x="34.5"
              y="33.5"
              width="13"
              height="13"
              rx="3"
              strokeWidth="2.5"
              transform="rotate(-14 41 40)"
              className="fill-cream stroke-charcoal"
            />
          </g>
          <g
            data-part="ice-cube"
            className="animate-scale-in"
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            <rect
              x="52"
              y="31.5"
              width="13"
              height="13"
              rx="3"
              strokeWidth="2.5"
              transform="rotate(12 58.5 38)"
              className="fill-cream stroke-charcoal"
            />
          </g>
        </>
      ) : null}

      {/* Cheeks. */}
      <circle cx="31" cy="81" r="5.2" className="fill-tan opacity-40" />
      <circle cx="69" cy="81" r="5.2" className="fill-tan opacity-40" />

      <Face expression={expression} />
    </svg>
  );
}

// The face. Happy eyes are big charcoal ovals with a tiny white highlight (the
// highlight is what makes them read as "eyes" at 22px); the mouth is one stroke.
function Face({ expression }: { expression: CoffeyExpression }) {
  if (expression === 'thinking') {
    // Looking up and off to one side: eyes with whites, so the pupils can
    // visibly sit in the top-right corner, and a small round "o" of a mouth.
    return (
      <g>
        <LookingEye cx={40} cy={69} />
        <LookingEye cx={61} cy={69} />
        <ellipse cx="52" cy="83.5" rx="3.4" ry="4" fill="none" strokeWidth="3" className="stroke-charcoal" />
      </g>
    );
  }

  return (
    <g>
      <Eye cx={39.5} cy={70} />
      {expression === 'wink' ? (
        // The closed eye: an upturned arc, like a happy squint.
        <path
          d="M55.5 71 Q60.5 64.5 65.5 71"
          fill="none"
          strokeWidth="3.2"
          strokeLinecap="round"
          className="stroke-charcoal"
        />
      ) : (
        <Eye cx={60.5} cy={70} />
      )}
      <path
        d="M42.5 81.5 Q50 90 57.5 81.5"
        fill="none"
        strokeWidth="3.2"
        strokeLinecap="round"
        className="stroke-charcoal"
      />
    </g>
  );
}

function Eye({ cx, cy }: { cx: number; cy: number }) {
  return (
    <>
      <ellipse cx={cx} cy={cy} rx="4.3" ry="5.3" className="fill-charcoal" />
      <circle cx={cx + 1.5} cy={cy - 1.9} r="1.5" className="fill-cream" />
    </>
  );
}

// An eye with a white and a pupil pushed to the upper right.
function LookingEye({ cx, cy }: { cx: number; cy: number }) {
  return (
    <>
      <ellipse cx={cx} cy={cy} rx="5.6" ry="6.4" strokeWidth="2.5" className="fill-cream stroke-charcoal" />
      <circle cx={cx + 2} cy={cy - 2.4} r="3.3" className="fill-charcoal" />
      <circle cx={cx + 2.9} cy={cy - 3.4} r="1" className="fill-cream" />
    </>
  );
}
