import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'About',
  description:
    'The HIOC. story — a pure-vegetarian cafe rooted in Kamla Nagar, Agra.',
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <section className="flex flex-col items-center gap-8 md:flex-row md:gap-12">
        <div className="w-full max-w-md shrink-0 md:max-w-lg">
          <Image
            src="/images/img.jpeg"
            alt="HIOC. vintage coffee cart illustration"
            width={700}
            height={700}
            className="h-auto w-full rounded-md object-contain"
          />
          <p className="mt-2 text-center text-sm text-muted">
            The HIOC. cart — where it all started.
          </p>
        </div>
        <div className="text-center md:text-left">
          <h1 className="text-3xl font-bold tracking-tight text-charcoal md:text-5xl">
            HIOC<span className="text-tan">.</span>
          </h1>
          <p className="mt-2 italic tracking-wide text-muted">
            High on Coffee — Rooted in Kamla Nagar
          </p>
        </div>
      </section>

      <section className="mx-auto mt-12 flex max-w-2xl flex-col gap-6 leading-relaxed text-charcoal">
        <p>
          Before we had four walls, HIOC. started as an idea on wheels —
          coffee brewed fresh and rolled out to wherever people gathered.
          These days you&apos;ll find us parked for good at E/773, Near V
          Mart, Kamla Nagar, Agra — the wheels stopped rolling, but we&apos;re
          still every bit as High on Coffee as we started out.
        </p>
        <p>
          We&apos;re a pure-vegetarian café, and coffee and waffles are what
          we do best — hand-brewed cups alongside crisp, golden waffles made
          to order. Skipping dairy? Ask for oat milk or soya milk with any
          coffee on the menu, no questions asked.
        </p>
        <p>
          HIOC. is meant to be easy — pop in, grab a table, and stay a
          while. A relaxed, wallet-friendly cafe — a coffee-and-waffle stop
          for two typically runs around ₹350.
        </p>
      </section>

      <section className="mx-auto mt-12 max-w-2xl text-center">
        <h2 className="text-2xl font-bold text-charcoal md:text-3xl">
          Come Say Hi
        </h2>
        <div className="mt-6 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Link
            href="/menu"
            className="w-full rounded-md bg-tan px-8 py-3 text-center font-bold text-cream transition-colors hover:bg-tan-dark sm:w-auto"
          >
            View Menu
          </Link>
          <Link
            href="/contact"
            className="w-full rounded-md border-2 border-tan px-8 py-3 text-center font-bold text-tan transition-colors hover:bg-tan hover:text-cream sm:w-auto"
          >
            Get Directions
          </Link>
        </div>
      </section>
    </div>
  );
}
