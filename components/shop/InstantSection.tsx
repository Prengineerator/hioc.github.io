'use client';

// The Instant Coffee half of the Choose step (docs/SHOP-V2-SPEC.md E8): the v1
// flavour cards and steppers, unchanged in look. Quantities live in the cart
// (the page owns it); this component only reports "set this product to n".
// Also home of the shared Stepper, which the Home Blend card and the cart
// drawer use too.

import Image from 'next/image';
import { Button } from '@/components/ui/Button';
import { FALLBACK_FLAVOUR_STYLE, FLAVOUR_STYLE } from '@/lib/shop/catalog';
import { offerDeals, rupees } from '@/lib/shop/pricing';
import type { ShopProduct, ShopSettings } from '@/lib/shop/types';

/**
 * A quantity stepper with 44 px targets. With min 0 a zero quantity shows a
 * single "Add" button (the flavour cards); with min 1 it is always the +/- pair
 * (the Home Blend card, whose Add is a separate button).
 */
export function Stepper({
  label,
  value,
  onChange,
  canAdd,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  canAdd: boolean;
  min?: 0 | 1;
}) {
  if (value === 0 && min === 0) {
    return (
      <Button variant="secondary" size="sm" onClick={() => onChange(1)} disabled={!canAdd} aria-label={`Add ${label}`}>
        Add
      </Button>
    );
  }
  const btn =
    'flex h-11 w-11 items-center justify-center rounded-md text-xl font-semibold text-tan-dark transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan';
  return (
    <div className="inline-flex items-center rounded-md border border-line" role="group" aria-label={`${label} quantity`}>
      <button type="button" className={btn} onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={`One fewer ${label}`}>
        <span aria-hidden="true">−</span>
      </button>
      <span className="min-w-[2ch] text-center font-mono text-base tabular-nums text-charcoal" aria-live="polite">
        {value}
      </span>
      <button type="button" className={btn} onClick={() => onChange(value + 1)} disabled={!canAdd} aria-label={`One more ${label}`}>
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}

export function InstantSection({
  products,
  quantities,
  onSetQuantity,
  canAddMore,
  settings,
  introEligible,
}: {
  products: ShopProduct[];
  /** Units in the cart by product id (instant jars have no grind). */
  quantities: Record<string, number>;
  onSetQuantity: (productId: string, quantity: number) => void;
  canAddMore: boolean;
  settings: ShopSettings;
  introEligible: boolean;
}) {
  if (products.length === 0) return null;
  const unitPrice = Math.min(...products.map((p) => p.price_inr));
  const offer = introEligible ? settings.offer : null;
  const deals = offer ? offerDeals(offer.tier_prices, unitPrice) : [];
  const shipping = `${rupees(settings.shipping_fee_inr)} shipping, free on orders of ${rupees(settings.free_shipping_min_inr)}+`;

  return (
    <section id="instant" aria-labelledby="flavours-heading" className="scroll-mt-28">
      <h2 id="flavours-heading" className="text-xl font-bold text-charcoal">
        Instant Coffee
      </h2>
      <p className="mt-1 text-sm text-muted">
        {deals.length > 0 && offer
          ? `${offer.name}: ${deals.map((d) => `${d.jars} for ${rupees(d.price)}`).join(' · ')} · any flavours · ${shipping}`
          : `${rupees(unitPrice)} a jar · mix any flavours · ${shipping}`}
      </p>
      <ul className="mt-5 grid gap-4 md:grid-cols-3">
        {products.map((p) => {
          const style = FLAVOUR_STYLE[p.id] ?? FALLBACK_FLAVOUR_STYLE;
          const n = quantities[p.id] ?? 0;
          return (
            <li
              key={p.id}
              className="flex gap-4 overflow-hidden rounded-md border border-line bg-cream shadow-card md:flex-col md:gap-0"
              style={{ borderTop: `4px solid ${style.accent}` }}
            >
              {style.image ? (
                // The jar (a cut-out with its own soft shadow) on a wash of its
                // flavour colour, so the three cards read like a product line.
                <div
                  className="relative w-28 shrink-0 md:aspect-[5/4] md:w-full"
                  style={{ background: `radial-gradient(ellipse at 50% 40%, #ffffff 0%, ${style.accent}1f 100%)` }}
                >
                  <Image
                    src={style.image}
                    alt={`${p.name} jar, ${p.net_qty}`}
                    fill
                    sizes="(min-width: 768px) 33vw, 112px"
                    className={`object-contain p-2 md:p-3 ${p.in_stock ? '' : 'opacity-50 grayscale'}`}
                  />
                </div>
              ) : null}
              <div className="flex flex-1 flex-col py-3 pr-3 md:p-4">
                <h3 className="text-lg font-bold text-charcoal">{p.name}</h3>
                {style.tagline ? <p className="mt-0.5 text-sm text-muted">{style.tagline}</p> : null}
                <p className="mt-2 text-sm text-charcoal">
                  <span className="font-mono font-semibold tabular-nums">{rupees(p.price_inr)}</span>
                  <span className="text-muted"> · {p.net_qty} jar</span>
                </p>
                <div className="mt-auto pt-3">
                  {p.in_stock ? (
                    <Stepper label={p.name} value={n} onChange={(v) => onSetQuantity(p.id, v)} canAdd={canAddMore} />
                  ) : (
                    <span className="inline-flex rounded-full bg-surface px-3 py-1 text-xs font-semibold text-muted">Out of stock</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
