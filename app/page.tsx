import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { CartProvider } from '@/lib/cart/CartContext';
import {
  CAFE_ADDRESS,
  CAFE_DIRECTIONS_URL,
  CAFE_HOURS_HOME,
  CUSTOMER_MENU_CATEGORIES,
} from '@/lib/constants';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { getStoreSettings } from '@/lib/store/settings';
import { isCategoryHidden, switchesFromSettings } from '@/lib/menu/menuSwitches';
import { isInStoreOnly } from '@/lib/menu/inStore';
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
import { InstantCoffeePopup } from '@/components/promotions/InstantCoffeePopup';

export const metadata: Metadata = {
  // Absolute: the root segment's title template doesn't wrap a page title, so a
  // plain 'Home' would render as just "Home".
  title: { absolute: 'HIOC. Coffee and Waffles in Kamla Nagar, Agra | Order Ahead for Pickup' },
  description:
    'HIOC. is a pure-vegetarian cafe in Kamla Nagar, Agra. Order coffee and waffles ahead and pick them up at the counter.',
};

export default async function HomePage() {
  const categories = await liveCategories();
  return (
    <CartProvider>
      <AnnouncementBanner />
      {/* Launch poster as a popup over the landing page, once per visit. */}
      <InstantCoffeePopup />
      <HeroSection />
      <MeetCoffey />
      {/* HIOC Ritual teaser: renders nothing until the feature is on and a plan is on sale. */}
      {flags.coffeePass ? <RitualTeaser /> : null}
      <CategoryTeaser categories={categories} />
      <VisitStrip />
      <AboutTeaser />
    </CartProvider>
  );
}

/**
 * The customer categories that have at least one item on the menu, so a tile
 * never opens an empty page (Waffle Crepes and Coffee Beans today). Read-only,
 * on the server, with the same switches the menu API honours (a category the
 * owner has switched off is left out). The root layout already renders every
 * page per request (it reads headers()), so this adds one small read, not a
 * loss of static rendering. If either read fails the whole fixed
 * list is shown rather than an empty section.
 */
async function liveCategories() {
  try {
    const [{ data, error }, settings] = await Promise.all([
      createServerSupabaseClient().from('menu_items').select('category, in_store_only'),
      getStoreSettings().catch(() => null),
    ]);
    if (error || !data) return CUSTOMER_MENU_CATEGORIES;
    // Unavailable items still count: the menu lists them greyed out with a
    // reason (it asks /api/menu with includeUnavailable=true). In-store-only
    // items don't: the public menu leaves them out.
    const withItems = new Set(
      (data as { category: string; in_store_only: boolean | null }[])
        .filter((row) => !isInStoreOnly(row))
        .map((row) => row.category),
    );
    const hidden = settings ? switchesFromSettings(settings).hiddenCategories : [];
    const live = CUSTOMER_MENU_CATEGORIES.filter(
      (c) => withItems.has(c.slug) && !isCategoryHidden(c.slug, hidden),
    );
    return live.length > 0 ? live : CUSTOMER_MENU_CATEGORIES;
  } catch {
    return CUSTOMER_MENU_CATEGORIES;
  }
}

function HeroSection() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-8 md:py-20">
      <div className="flex flex-col items-center gap-6 md:flex-row md:gap-14">
        <div className="flex w-full max-w-sm shrink-0 justify-center md:max-w-md">
          <Image
            src="/images/img.jpeg"
            alt="HIOC. vintage coffee cart illustration"
            width={500}
            height={500}
            priority
            // Capped at 40% of the screen height on phones so "Order Now" stays above the fold.
            className="h-auto max-h-[40svh] w-auto max-w-full rounded-md object-contain md:max-h-none md:w-full md:max-w-sm"
          />
        </div>
        <div className="flex flex-col items-center gap-4 text-center md:items-start md:text-left">
          <span className="text-sm font-semibold text-tan-dark">Kamla Nagar, Agra</span>
          <h1 className="text-3xl font-bold tracking-tight text-charcoal md:text-5xl">
            HIOC<span className="text-tan-dark">.</span>
          </h1>
          <p className="text-base font-bold text-charcoal">High on Coffee</p>
          <p className="max-w-md text-muted">
            Order ahead on your phone and pick it up at the counter. Coffee and
            waffles, brewed and baked fresh in Kamla Nagar.
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
  "Tell me how you feel and I'll match it to the menu.",
  "Pick how sweet and I'll set the sugar for you.",
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
              How Coffey works
            </Link>
          </div>
        </div>
      </Card>
    </section>
  );
}

function CategoryTeaser({ categories }: { categories: typeof CUSTOMER_MENU_CATEGORIES }) {
  return (
    <section className="mx-auto max-w-6xl px-4 py-12">
      <div className="mb-8 text-center">
        <h2 className="text-2xl font-bold text-charcoal md:text-3xl">
          Explore the Menu
        </h2>
        <p className="mt-2 text-muted">Coffee, waffles, and more for every craving.</p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {categories.map((cat) => (
          <Link key={cat.slug} href={`/menu?category=${encodeURIComponent(cat.slug)}`}>
            <Card className="group h-full transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-0.5 hover:border-tan hover:shadow-elevated">
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
          <p className="text-sm font-semibold text-tan-dark">Visit us</p>
          <p className="mt-1 font-semibold text-charcoal">{CAFE_ADDRESS}</p>
          <p className="mt-1 text-sm text-muted">{CAFE_HOURS_HOME}</p>
        </div>
        {/* Straight to the maps pin; one line even at tablet width. */}
        <a
          href={CAFE_DIRECTIONS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'secondary', className: 'shrink-0 whitespace-nowrap' })}
        >
          Get Directions
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
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
        order. If you&apos;re skipping dairy, we&apos;ve got vegan milk
        options available, including oat and soya. Come find your new
        favourite corner.
      </p>
      <Link
        href="/about"
        className="mt-4 inline-block font-semibold text-tan-dark hover:underline"
      >
        Read our story
      </Link>
    </section>
  );
}
