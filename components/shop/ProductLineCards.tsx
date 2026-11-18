import Image from 'next/image';
import { HomeBlendPlaceholder } from '@/components/shop/HomeBlendPlaceholder';
import { JumpLink, PackTileButton } from '@/components/shop/ShopJump';
import { buttonVariants } from '@/components/ui/Button';
import { HOME_BLEND_HIGHLIGHTS, HOME_BLEND_IMAGE, HOME_BLEND_NAME, PRODUCT_HIGHLIGHTS } from '@/lib/shop/catalog';
import { rupees } from '@/lib/shop/pricing';
import { homeBlendFromLabel, homeBlendTiles, productLinesToShow } from '@/lib/shop/productLines';

// The two product-line cards at the top of /shop, one per line, each leading to
// its ordering section below. Server component: page.tsx loads the data and
// passes plain props; only the jump links / pack tiles are client (ShopJump).
// Below md each card is compact (thumbnail beside the text, one price, the CTA)
// so both choices fit on a phone screen. The introductory offer is instant-only.

export interface ProductLineCardsProps {
  /** Number of listed instant products; 0 hides the instant card. */
  instantCount: number;
  /** Listed Home Blend packs; none hides the Home Blend card. */
  homeBlendPacks: { id: string; pack_grams: number; price_inr: number; in_stock: boolean }[];
  /** Lowest instant jar price. */
  price: number;
  /** The introductory offer, only when it is live for this viewer. */
  intro: { name: string; deals: { jars: number; price: number; was: number }[] } | null;
  welcomeBack: string | null;
  shippingCopy: string;
}

const CARD = 'flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card';
const RIBBON = 'rounded-full bg-tan-dark px-3 py-1 text-xs font-semibold text-cream shadow-sm';
const TILE = 'h-full w-full rounded-md bg-cream px-2 py-3 text-center shadow-sm';
const SIZES = '(min-width: 1024px) 480px, (min-width: 768px) 45vw, 96px';
const WARM = 'radial-gradient(ellipse at 50% 35%, #ffffff 0%, #f6efe9 60%, #efe3d6 100%)';
const FROM = 'mt-2 text-base font-bold text-charcoal';
const AMOUNT = 'font-mono tabular-nums';
const CTA = buttonVariants({ size: 'lg', fullWidth: true });

function Highlights({ items }: { items: readonly string[] }) {
  return (
    <ul className="space-y-1.5 text-sm text-charcoal">
      {items.map((h, i) => (
        <li key={h} className={`${i >= 2 ? 'hidden md:flex' : 'flex'} gap-2`}>
          <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-tan" />
          {h}
        </li>
      ))}
    </ul>
  );
}

export function ProductLineCards({ instantCount, homeBlendPacks, price, intro, welcomeBack, shippingCopy }: ProductLineCardsProps) {
  const tiles = homeBlendTiles(homeBlendPacks);
  const { instant: showInstant, homeBlend: showHomeBlend } = productLinesToShow(instantCount, tiles.length);
  if (!showInstant && !showHomeBlend) return null;
  const both = showInstant && showHomeBlend;
  const homeBlendFrom = homeBlendFromLabel(tiles);

  return (
    <div className={both ? 'mt-4 grid gap-4 md:mt-8 md:grid-cols-2 md:gap-6' : 'mx-auto mt-4 max-w-xl md:mt-8'}>
      {showInstant ? (
        <section aria-labelledby="line-instant-heading" className={CARD}>
          <div className="flex flex-1 items-start gap-4 p-4 md:flex-col md:items-stretch md:gap-0 md:p-0">
            <div
              className="relative w-24 shrink-0 overflow-hidden rounded-lg md:w-full md:rounded-none md:px-2 md:pb-2 md:pt-12"
              style={{ background: WARM }}
            >
              <Image
                src="/images/shop/hero-jars.png"
                alt="Three 50 g jars of HIOC. Premium Instant Coffee — Nutty Hazelnut, French Vanilla and Classic — tied with black ribbons."
                width={880}
                height={476}
                priority
                sizes={SIZES}
                className="h-auto w-full"
              />
              {intro ? <DesktopRibbon text={intro.name} /> : welcomeBack ? <DesktopRibbon text="Welcome back" /> : null}
            </div>

            <div className="min-w-0 flex-1 md:flex md:flex-col md:p-5">
              {intro ? <MobileRibbon text={intro.name} /> : welcomeBack ? <MobileRibbon text="Welcome back" /> : null}
              <h2 id="line-instant-heading" className="text-lg font-bold text-charcoal md:text-xl">
                Premium Instant Coffee
              </h2>
              <p className="mt-0.5 text-sm text-muted">Three flavours · 50 g jars</p>
              <p className={FROM}>
                From <span className={AMOUNT}>{rupees(price)}</span> a jar
              </p>

              <div className="mt-3 hidden md:block">
                <Highlights items={PRODUCT_HIGHLIGHTS} />
              </div>

              {intro ? (
                <>
                  <p className="mt-2 text-xs text-muted md:hidden">
                    {intro.name}: {intro.deals.map((d) => `${d.jars} jars ${rupees(d.price)}`).join(', ')}
                  </p>
                  <div className="mt-5 hidden rounded-md border border-line bg-cream/60 p-3 md:block">
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-tan-dark">{intro.name} · any instant flavours</p>
                    <ul className="mt-3 grid grid-cols-3 gap-2">
                      <li className={TILE}>
                        <p className="text-xs text-muted">1 jar</p>
                        <p className="mt-0.5 font-mono text-lg font-bold tabular-nums text-charcoal">{rupees(price)}</p>
                      </li>
                      {intro.deals.slice(0, 2).map((d) => (
                        <li key={d.jars} className={`${TILE} ring-1 ring-tan`}>
                          <p className="text-xs font-semibold text-tan-dark">{d.jars} jars</p>
                          <p className="mt-0.5 font-mono text-lg font-bold tabular-nums text-charcoal">{rupees(d.price)}</p>
                          <p className="text-xs text-muted">
                            <s>{rupees(d.was)}</s>
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              ) : welcomeBack ? (
                <>
                  <p className="mt-2 text-xs font-semibold text-charcoal md:hidden">{welcomeBack}</p>
                  <div className="mt-5 hidden rounded-md border border-line bg-cream/60 p-3 md:block">
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-tan-dark">Welcome back</p>
                    <p className="mt-2 text-base font-semibold text-charcoal">{welcomeBack}</p>
                  </div>
                </>
              ) : null}
              <p className="mt-3 hidden text-xs text-muted md:block">{shippingCopy}</p>
            </div>
          </div>

          <div className="px-4 pb-4 md:px-5 md:pb-5">
            <JumpLink hash="instant" headingId="flavours-heading" className={CTA}>
              Order instant coffee <span aria-hidden="true">→</span>
            </JumpLink>
          </div>
        </section>
      ) : null}

      {showHomeBlend ? (
        <section aria-labelledby="line-home-blend-heading" className={CARD}>
          <div className="flex flex-1 items-start gap-4 p-4 md:flex-col md:items-stretch md:gap-0 md:p-0">
            <div className="relative w-24 shrink-0 overflow-hidden rounded-lg md:w-full md:rounded-none">
              <DesktopRibbon text={welcomeBack ? 'Welcome back' : 'New'} />
              {HOME_BLEND_IMAGE ? (
                <div className="relative aspect-square md:aspect-[880/476]" style={{ background: WARM }}>
                  <Image src={HOME_BLEND_IMAGE} alt={`${HOME_BLEND_NAME} pack`} fill sizes={SIZES} className="object-contain p-2 md:p-4" />
                </div>
              ) : (
                <HomeBlendPlaceholder compact warm className="aspect-square md:aspect-[880/476] md:pt-8" />
              )}
            </div>

            <div className="min-w-0 flex-1 md:flex md:flex-col md:p-5">
              <MobileRibbon text={welcomeBack ? 'Welcome back' : 'New'} />
              <h2 id="line-home-blend-heading" className="text-lg font-bold text-charcoal md:text-xl">
                Signature Home Blend
              </h2>
              <p className="mt-0.5 text-sm text-muted">Whole bean or freshly ground</p>
              {homeBlendFrom ? (
                <p className={FROM}>
                  From <span className={AMOUNT}>{rupees(homeBlendFrom.priceInr)}</span> {homeBlendFrom.note}
                </p>
              ) : null}

              <div className="mt-3 hidden md:block">
                <Highlights items={HOME_BLEND_HIGHLIGHTS} />
              </div>

              <div className="mt-5 hidden rounded-md border border-line bg-cream/60 p-3 md:block">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-tan-dark">Tap a pack to choose it</p>
                <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4">
                  {tiles.map((t) => {
                    const body = (
                      <>
                        <span className="block text-xs font-semibold text-tan-dark">{t.label}</span>
                        <span className="mt-0.5 block font-mono text-lg font-bold tabular-nums text-charcoal">{rupees(t.priceInr)}</span>
                        <span aria-hidden={t.popular ? undefined : true} className={`mt-1 block text-[11px] font-semibold uppercase tracking-wide ${t.popular ? 'text-tan-dark' : 'invisible'}`}>
                          Popular
                        </span>
                      </>
                    );
                    const ring = t.popular ? 'ring-1 ring-tan' : '';
                    return (
                      <li key={t.id || t.grams} className="flex">
                        {t.inStock && t.id ? (
                          <PackTileButton
                            productId={t.id}
                            label={`Choose ${t.label}, ${rupees(t.priceInr)}${t.popular ? ', popular' : ''}`}
                            className={`${TILE} ${ring} min-h-[44px] hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan`}
                          >
                            {body}
                          </PackTileButton>
                        ) : (
                          <div className={`${TILE} ${ring} opacity-60`}>
                            {body}
                            <span className="block text-xs font-semibold text-muted">Out of stock</span>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
              {welcomeBack ? <p className="mt-3 hidden text-sm font-semibold text-charcoal md:block">{welcomeBack}</p> : null}
              <p className="mt-3 hidden text-xs text-muted md:block">{shippingCopy}</p>
              <p className="mt-1 text-xs text-muted">Pick your grind on the next step: whole bean or ground for your brewer</p>
            </div>
          </div>

          <div className="px-4 pb-4 md:px-5 md:pb-5">
            <JumpLink hash="home-blend" headingId="home-blend-heading" className={CTA}>
              Order Home Blend <span aria-hidden="true">→</span>
            </JumpLink>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function DesktopRibbon({ text }: { text: string }) {
  return <span className={`${RIBBON} absolute left-4 top-4 z-10 hidden md:inline-block`}>{text}</span>;
}

function MobileRibbon({ text }: { text: string }) {
  return <span className={`${RIBBON} mb-1.5 inline-block md:hidden`}>{text}</span>;
}
