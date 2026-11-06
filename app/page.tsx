import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { CartProvider } from '@/lib/cart/CartContext';
import { CAFE_ADDRESS, CAFE_HOURS_HOME, CUSTOMER_MENU_CATEGORIES } from '@/lib/constants';
import { buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { flags } from '@/lib/flags';
import { CoffeyMascot } from '@/components/coffey/CoffeyMascot';
import { RitualTeaser } from '@/components/passes/RitualTeaser';
// Owned by the promotions engineer (components/promotions/**); imported
// here (not built here) since it's already self-contained (fetches its own
// data, handles empty/error states, per-session dismiss) — mounting it is
// this file's job (app/page.tsx is customer-chrome), building it is theirs.
import { AnnouncementBanner } from '@/components/promotions/AnnouncementBanner';

export const metadata: Metadata = {
  title: 'Home',
  description:
    'HIOC. — pure-vegetarian coffee and waffles in Kamla Nagar, Agra. High on Coffee.',
};

export default function HomePage() {
  return (
    <CartProvider>
      <AnnouncementBanner />
      <InstantCoffeePromo />
      <HeroSection />
      <MeetCoffey />
      {/* HIOC Ritual teaser: renders nothing until the feature is on and a plan is on sale. */}
      {flags.coffeePass ? <RitualTeaser /> : null}
      <CategoryTeaser />
      <VisitStrip />
      <AboutTeaser />
    </CartProvider>
  );
}

// New-launch promotion banner: the owner's poster for HIOC. Premium Instant
// Coffee (owner request 2026-11-06), at the top of the home page. The jars are
// sold at the counter, not on the online menu, so the banner has no "add to
// cart". Like the poster, it sends people to the counter. To take it down when
// the offer ends, delete <InstantCoffeePromo /> from HomePage along with
// public/images/promo-instant-coffee.jpg.
const INSTANT_COFFEE_FLAVOURS = ['Signature Classic', 'Nutty Hazelnut', 'French Vanilla'];
const INSTANT_COFFEE_OFFERS = [
  { label: '1 jar', price: '₹299' },
  { label: '2 jars', price: '₹499' },
  { label: '3 jars', price: '₹599' },
];

function InstantCoffeePromo() {
  return (
    <section
      aria-labelledby="instant-coffee-promo-heading"
      className="mx-auto max-w-6xl px-4 pt-6 md:pt-10"
    >
      <Card padding="none" className="mx-auto max-w-sm overflow-hidden md:flex md:max-w-none">
        {/* self-start: in the md+ row the card would otherwise stretch the
            image to the text column's height and distort the poster. */}
        <Image
          src="/images/promo-instant-coffee.jpg"
          alt="HIOC. Premium Instant Coffee poster: three 50 g jars, Nutty Hazelnut, French Vanilla and Classic, on a wooden board beside a cup of coffee."
          width={1024}
          height={1536}
          priority
          sizes="(min-width: 1024px) 384px, (min-width: 768px) 320px, (min-width: 416px) 384px, calc(100vw - 2rem)"
          className="h-auto w-full md:w-80 md:shrink-0 md:self-start lg:w-96"
        />
        <div className="flex max-w-xl flex-col justify-center gap-3 p-4 md:self-center md:p-8 lg:p-12">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-tan-dark">
            New launch
          </span>
          <h2
            id="instant-coffee-promo-heading"
            className="text-xl font-bold text-charcoal md:text-3xl"
          >
            HIOC. Premium Instant Coffee
          </h2>
          {/* On a phone the poster right above says all of this in large type,
              and repeating it underneath would double the banner's height. So
              the details show from md up, beside the poster, and stay in the
              accessibility tree at every width. */}
          <div className="sr-only md:not-sr-only md:flex md:flex-col md:gap-4">
            <p className="text-muted">
              Café-quality coffee, instantly. 100% Arabica, freeze-dried to lock
              in the rich aroma and flavour. 50 g jars in three flavours:
            </p>
            <ul role="list" className="flex flex-wrap gap-2">
              {INSTANT_COFFEE_FLAVOURS.map((flavour) => (
                <li
                  key={flavour}
                  className="rounded-full border border-tan px-3 py-1 text-sm font-semibold text-charcoal"
                >
                  {flavour}
                </li>
              ))}
            </ul>
            <div>
              <p className="text-sm text-muted">
                Regular <s className="font-mono tabular-nums">₹399</s> a jar. Launch offer:
              </p>
              <ul role="list" className="mt-2 grid grid-cols-3 gap-2">
                {INSTANT_COFFEE_OFFERS.map((offer) => (
                  <li key={offer.label} className="rounded-md bg-surface px-3 py-2 text-center">
                    <span className="block text-sm text-muted">{offer.label}</span>
                    <span className="font-mono text-lg font-bold tabular-nums text-charcoal">
                      {offer.price}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="font-semibold text-charcoal">
            Ask at the counter for a free trial cup!
          </p>
        </div>
      </Card>
    </section>
  );
}

function HeroSection() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-12 md:py-20">
      <div className="flex flex-col items-center gap-10 md:flex-row md:gap-14">
        <div className="flex w-full max-w-sm shrink-0 justify-center md:max-w-md">
          <Image
            src="/images/img.jpeg"
            alt="HIOC. vintage coffee cart illustration"
            width={500}
            height={500}
            priority
            className="h-auto w-full max-w-sm rounded-md object-contain"
          />
        </div>
        <div className="flex flex-col items-center gap-4 text-center md:items-start md:text-left">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-tan-dark">
            Kamla Nagar, Agra
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-charcoal md:text-5xl">
            HIOC<span className="text-tan-dark">.</span>
          </h1>
          <p className="text-sm font-bold uppercase tracking-[0.3em] text-charcoal">
            High on Coffee
          </p>
          <p className="max-w-md text-muted">
            Coffee and Waffles, brewed and baked fresh in the heart of Kamla
            Nagar.
          </p>
          {/* flex-wrap from sm up: at tablet width the hero's text column is
              narrower than these three side by side, and without wrapping the
              row pushed the whole page wider than the screen. */}
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap md:items-start">
            <Link href="/menu" className={buttonVariants({ size: 'lg' })}>
              Order Now
            </Link>
            {flags.suggest ? (
              <Link href="/suggest" className={buttonVariants({ size: 'lg', variant: 'secondary' })}>
                <CoffeyMascot size={22} />
                Ask Coffey
              </Link>
            ) : null}
            <span className="text-sm text-muted">{CAFE_HOURS_HOME}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// Coffey's introduction (COFFEY-SPEC §1): between the hero and the menu, only
// while the suggestion engine is on. One secondary button (the hero already has
// the page's primary, "Order Now") and a plain link to the article.
const COFFEY_PITCH = [
  "Tell me how you feel — I'll match it to the menu.",
  "Pick how sweet — I'll set the sugar for you.",
  'Three different picks, each with a reason.',
];

function MeetCoffey() {
  if (!flags.suggest) return null;
  return (
    <section aria-labelledby="meet-coffey-heading" className="mx-auto max-w-6xl px-4 pb-4">
      <Card
        padding="lg"
        className="flex flex-col items-center gap-4 text-center md:flex-row md:gap-10 md:text-left"
      >
        <CoffeyMascot size={96} expression="wink" />
        {/* The text column takes all the room the card has (w-full on a phone,
            flex-1 beside the mascot), so the lines wrap where the card ends and
            not before. */}
        <div className="flex w-full min-w-0 flex-col items-center md:flex-1 md:items-start">
          <h2 id="meet-coffey-heading" className="text-xl font-bold text-charcoal md:text-2xl">
            Meet Coffey, your pick-helper
          </h2>
          {/* Short lines read best left-aligned even when the card is centred. */}
          <ul role="list" className="mt-3 w-full space-y-1.5 text-left text-muted">
            {COFFEY_PITCH.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-tan" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex flex-col items-center gap-2 sm:flex-row sm:gap-5">
            <Link href="/suggest" className={buttonVariants({ variant: 'secondary' })}>
              Ask Coffey
            </Link>
            <Link
              href="/coffey"
              className="inline-flex min-h-[44px] items-center font-semibold text-tan-dark hover:underline"
            >
              How Coffey works →
            </Link>
          </div>
        </div>
      </Card>
    </section>
  );
}

function CategoryTeaser() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-12">
      <div className="mb-8 text-center">
        <h2 className="text-2xl font-bold text-charcoal md:text-3xl">
          Explore the Menu
        </h2>
        <p className="mt-2 text-muted">Coffee, waffles, and more — something for every craving.</p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {CUSTOMER_MENU_CATEGORIES.map((cat) => (
          <Link key={cat.slug} href={`/menu?category=${encodeURIComponent(cat.slug)}`}>
            <Card interactive className="group h-full">
              <h3 className="font-semibold text-charcoal group-hover:text-tan-dark">
                {cat.label}
              </h3>
              {cat.parent ? (
                <p className="mt-1 text-sm text-muted">{cat.parent}</p>
              ) : null}
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

function VisitStrip() {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-4">
      <Card className="flex flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-tan-dark">Visit Us</p>
          <p className="mt-1 font-semibold text-charcoal">{CAFE_ADDRESS}</p>
          <p className="mt-1 text-sm text-muted">{CAFE_HOURS_HOME}</p>
        </div>
        <Link href="/contact" className={buttonVariants({ variant: 'secondary' })}>
          Get Directions
        </Link>
      </Card>
    </section>
  );
}

function AboutTeaser() {
  return (
    <section className="mx-auto max-w-2xl px-4 py-12 text-center">
      <h2 className="text-2xl font-bold text-charcoal md:text-3xl">
        The HIOC. Story
      </h2>
      <p className="mt-4 text-muted">
        HIOC. is a pure-vegetarian café serving coffee and waffles from our
        home in Kamla Nagar, Agra. Every cup and every waffle is made to
        order — and if you&apos;re skipping dairy, we&apos;ve got vegan milk
        options available, including oat and soya. Come find your new
        favourite corner.
      </p>
      <Link
        href="/about"
        className="mt-4 inline-block font-semibold text-tan-dark hover:underline"
      >
        Learn more →
      </Link>
    </section>
  );
}
