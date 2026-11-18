'use client';

// The Home Blend half of the Choose step (docs/SHOP-V2-SPEC.md E1, E8): one
// product card on the brand `surface` background.
//   - an image slot (HOME_BLEND_IMAGE; until the photo exists, a styled
//     placeholder with its alt text, never a broken image)
//   - pack-size chips, a radio group, the price on each chip. Only listed packs
//     are offered; one that is out of stock is shown disabled, with text.
//   - grind chips, a radio group labelled by brew method, each with a one-line
//     hint. There is NO default grind: tapping "Add to order" without one shows
//     an inline prompt next to the group (aria-live) and moves focus to it.
//     Never an alert.
//   - a "Not sure? Pick how you brew" disclosure
//   - a stepper and "Add to order": a secondary button (the sticky bar owns the
//     page's one primary action)
// Packs are ground to order, so the same pack with another grind is its own
// cart line. The grind changes neither the price nor the stock.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/Button';
import { Stepper } from '@/components/shop/InstantSection';
import { HomeBlendPlaceholder } from '@/components/shop/HomeBlendPlaceholder';
import { GRINDS, HOME_BLEND_HIGHLIGHTS, HOME_BLEND_IMAGE, HOME_BLEND_NAME, defaultHomeBlendPack, grindShort, packLabel } from '@/lib/shop/catalog';
import { SELECT_PACK_EVENT, acceptedPackId } from '@/lib/shop/productLines';
import { MAX_UNITS_PER_ORDER, rupees, type CartItem } from '@/lib/shop/pricing';
import type { GrindCode, ShopProduct } from '@/lib/shop/types';

const CHIP =
  'flex min-h-[44px] cursor-pointer flex-col justify-center rounded-md border-2 px-4 py-2 text-left transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tan';

export function HomeBlendCard({
  products,
  unitsInCart,
  onAdd,
}: {
  /** Home Blend packs the owner has listed. */
  products: ShopProduct[];
  /** Units already in the cart, so the stepper stops at the order limit. */
  unitsInCart: number;
  onAdd: (item: CartItem) => void;
}) {
  const uid = useId();
  const packs = useMemo(
    () => products.filter((p) => p.line === 'home_blend' && p.listed).sort((a, b) => a.pack_grams - b.pack_grams || a.sort_order - b.sort_order),
    [products],
  );
  const [packId, setPackId] = useState<string | null>(defaultHomeBlendPack(packs)?.id ?? null);
  const [grind, setGrind] = useState<GrindCode | null>(null);
  const [grindPrompt, setGrindPrompt] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState<string | null>(null);
  const grindRef = useRef<HTMLInputElement>(null);

  // A pack tile in the /shop product-line card chose a pack: select it (listed, in stock only).
  useEffect(() => {
    const onSelect = (e: Event) => {
      const id = acceptedPackId((e as CustomEvent).detail, packs);
      if (id) {
        setPackId(id);
        setAdded(null);
      }
    };
    window.addEventListener(SELECT_PACK_EVENT, onSelect);
    return () => window.removeEventListener(SELECT_PACK_EVENT, onSelect);
  }, [packs]);

  if (packs.length === 0) return null;

  const pack = packs.find((p) => p.id === packId && p.in_stock) ?? defaultHomeBlendPack(packs);
  const room = Math.max(0, MAX_UNITS_PER_ORDER - unitsInCart);
  const description = (pack && pack.description) || packs.find((p) => p.description)?.description || '';
  const name = (pack && pack.display_name) || HOME_BLEND_NAME;

  function add() {
    if (!pack) return;
    if (!grind) {
      setGrindPrompt('Choose how you want it ground to add it to your order');
      setAdded(null);
      grindRef.current?.focus();
      return;
    }
    if (room <= 0) return;
    const n = Math.min(qty, room);
    onAdd({ product_id: pack.id, quantity: n, grind });
    setAdded(`Added ${n} × ${packLabel(pack.pack_grams)} · ${grindShort(grind)} to your order`);
    setQty(1);
  }

  return (
    <section id="home-blend" aria-labelledby="home-blend-heading" className="scroll-mt-28">
      <h2 id="home-blend-heading" tabIndex={-1} className="text-xl font-bold text-charcoal outline-none">
        Home Blend
      </h2>
      <p className="mt-1 text-sm text-muted">Our café blend for your kitchen, ground the way you brew.</p>

      <div className="mt-5 overflow-hidden rounded-md border border-line bg-surface md:grid md:grid-cols-[minmax(0,18rem)_1fr]">
        {HOME_BLEND_IMAGE ? (
          <div className="relative aspect-[4/3] md:aspect-auto">
            <Image src={HOME_BLEND_IMAGE} alt={`${HOME_BLEND_NAME} pack`} fill sizes="(min-width: 768px) 288px, 100vw" className="object-contain p-4" />
          </div>
        ) : (
          <HomeBlendPlaceholder className="aspect-[4/3] border-b border-line md:aspect-auto md:border-b-0 md:border-r" />
        )}

        <div className="p-4 md:p-6">
          <h3 className="text-lg font-bold text-charcoal">{name}</h3>
          {description ? (
            <p className="mt-1 text-sm text-charcoal">{description}</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm text-charcoal">
              {HOME_BLEND_HIGHLIGHTS.map((h) => (
                <li key={h} className="flex gap-2">
                  <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-tan" />
                  {h}
                </li>
              ))}
            </ul>
          )}

          <fieldset className="mt-5">
            <legend className="text-sm font-semibold text-charcoal">Pack size</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {packs.map((p) => {
                const checked = pack?.id === p.id;
                return (
                  <label
                    key={p.id}
                    className={[
                      CHIP,
                      checked ? 'border-tan-dark bg-tan-dark text-cream' : 'border-muted/80 bg-cream text-charcoal hover:bg-surface',
                      p.in_stock ? '' : 'cursor-not-allowed opacity-60',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name={`${uid}-pack`}
                      className="sr-only"
                      checked={checked}
                      disabled={!p.in_stock}
                      onChange={() => {
                        setPackId(p.id);
                        setAdded(null);
                      }}
                    />
                    <span className="text-sm font-semibold">
                      {checked ? <span aria-hidden="true">✓ </span> : null}
                      {packLabel(p.pack_grams)}
                    </span>
                    <span className="font-mono text-sm tabular-nums">{rupees(p.price_inr)}</span>
                    {p.in_stock ? null : <span className="text-xs font-semibold">Out of stock</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="mt-5" aria-describedby={`${uid}-grind-msg`}>
            <legend className="text-sm font-semibold text-charcoal">How do you brew?</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {GRINDS.map((g, i) => {
                const checked = grind === g.code;
                return (
                  <label
                    key={g.code}
                    className={[
                      CHIP,
                      checked ? 'border-tan-dark bg-tan-dark text-cream' : 'border-muted/80 bg-cream text-charcoal hover:bg-surface',
                    ].join(' ')}
                  >
                    <input
                      ref={i === 0 ? grindRef : undefined}
                      type="radio"
                      name={`${uid}-grind`}
                      className="sr-only"
                      checked={checked}
                      onChange={() => {
                        setGrind(g.code);
                        setGrindPrompt(null);
                        setAdded(null);
                      }}
                    />
                    <span className="text-sm font-semibold">
                      {checked ? <span aria-hidden="true">✓ </span> : null}
                      {g.label}
                    </span>
                    <span className={`text-xs ${checked ? 'text-cream' : 'text-muted'}`}>{g.hint}</span>
                  </label>
                );
              })}
            </div>
            <p id={`${uid}-grind-msg`} aria-live="polite" className={grindPrompt ? 'mt-2 text-sm font-semibold text-red-700' : 'sr-only'}>
              {grindPrompt ?? ''}
            </p>
          </fieldset>

          <details className="mt-3 text-sm">
            <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold text-tan-dark underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan">
              Not sure? Pick how you brew
            </summary>
            <div className="pb-2 text-charcoal">
              <p>Choose the grind that matches the way you make coffee at home:</p>
              <ul className="mt-2 space-y-1">
                {GRINDS.map((g) => (
                  <li key={g.code}>
                    <strong>{g.label}:</strong> {g.hint}.
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-muted">The grind doesn&apos;t change the price. You can add the same pack again with a different grind.</p>
            </div>
          </details>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {pack ? (
              <>
                <Stepper
                  label={`${packLabel(pack.pack_grams)} Home Blend`}
                  value={Math.min(qty, Math.max(1, room))}
                  onChange={(n) => setQty(Math.max(1, n))}
                  canAdd={qty < room}
                  min={1}
                />
                <Button variant="secondary" onClick={add} disabled={room <= 0}>
                  Add to order
                </Button>
              </>
            ) : (
              <p className="text-sm font-semibold text-muted">Out of stock right now. Check back soon.</p>
            )}
          </div>
          <p aria-live="polite" className={added ? 'mt-3 text-sm font-semibold text-green-800' : 'sr-only'}>
            {added ?? ''}
          </p>
          {room <= 0 ? <p className="mt-2 text-sm text-muted">That&apos;s the most we take online. For more, call or email us.</p> : null}
        </div>
      </div>
    </section>
  );
}
