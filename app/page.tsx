import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { CartProvider } from '@/lib/cart/CartContext';
import { CAFE_ADDRESS, CAFE_HOURS_HOME, MENU_CATEGORIES } from '@/lib/constants';
import { buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
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
      <HeroSection />
      <CategoryTeaser />
      <VisitStrip />
      <AboutTeaser />
    </CartProvider>
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
          <span className="text-xs font-bold uppercase tracking-[0.2em] text-tan">
            Kamla Nagar, Agra
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-charcoal md:text-5xl">
            HIOC<span className="text-tan">.</span>
          </h1>
          <p className="text-sm font-bold uppercase tracking-[0.3em] text-charcoal">
            High on Coffee
          </p>
          <p className="max-w-md text-muted">
            Coffee and Waffles, brewed and baked fresh in the heart of Kamla
            Nagar.
          </p>
          <div className="flex flex-col items-center gap-3 sm:flex-row md:items-start">
            <Link href="/menu" className={buttonVariants({ size: 'lg' })}>
              Order Now
            </Link>
            <span className="text-sm text-muted">{CAFE_HOURS_HOME}</span>
          </div>
        </div>
      </div>
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
        {MENU_CATEGORIES.map((cat) => (
          <Link key={cat.slug} href={`/menu?category=${encodeURIComponent(cat.slug)}`}>
            <Card interactive className="group h-full">
              <h3 className="font-bold text-charcoal group-hover:text-tan">
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
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-tan">Visit Us</p>
          <p className="mt-1 font-bold text-charcoal">{CAFE_ADDRESS}</p>
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
        className="mt-4 inline-block font-bold text-tan hover:underline"
      >
        Learn more →
      </Link>
    </section>
  );
}
