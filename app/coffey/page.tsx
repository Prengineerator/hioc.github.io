import type { Metadata } from 'next';
import Link from 'next/link';
import { CoffeyMascot } from '@/components/coffey/CoffeyMascot';
import { buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { flags } from '@/lib/flags';
import { FLAVOUR_FAMILIES, MAX_MOODS, MOODS, SUGGEST_LIMITS, SWEETNESS_PREFS, SWEETNESS_SCALE } from '@/lib/suggest/types';
import { TRAIT_DIMENSIONS, TRAIT_QUESTION_COUNT } from '@/lib/suggest/traitVocabulary';

// "Meet Coffey" (docs/COFFEY-SPEC.md §6.3): the article behind the home page's
// "How Coffey works →" and the wizard's "What can Coffey do? →". It is visible
// even when flags.suggest is off — only its call to action changes.
//
// Every number on this page comes from the same constants the engine and the
// wizard use (see `count` below), so the copy can't drift from the code, and it
// makes no claim beyond what the engine does: no accuracy percentages, no speed
// promises.

// Small numbers read better as words ("three picks"), bigger ones as digits
// ("14 dimensions"). Always driven by a constant, never typed by hand.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function count(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}
function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const PICKS = count(SUGGEST_LIMITS.picks); // "three"
// The sweetness scale's steps: everything except the separate "Any".
const SWEETNESS_STEPS = SWEETNESS_PREFS.filter((p) => p !== 'any').length;

export const metadata: Metadata = {
  title: 'Meet Coffey',
  description: `Meet Coffey, the HIOC. pick-helper: tell it how you feel and what sounds good, and it picks ${PICKS} things from our real menu, each with a reason.`,
};

// "How I choose": the four steps of the pipeline, in order. The numbers on the
// badges are the positions in this list, not typed in.
const HOW_STEPS: { title: string; body: string }[] = [
  { title: 'Your rules first', body: "Anything that doesn't fit is set aside." },
  { title: 'A shortlist', body: "I rank what's left by your mood, flavours, sweetness and the time of day." },
  { title: 'Jev decides', body: 'Jev, a decision AI from TypeSafe AI, grades every shortlisted item for you.' },
  {
    title: `${capitalise(PICKS)} different picks`,
    body: `I blend Jev's judgement with my ranking and make sure the ${PICKS} aren't the same.`,
  },
];

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-2xl font-bold text-charcoal md:text-3xl">
      {children}
    </h2>
  );
}

export default function CoffeyPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 md:py-16">
      {/* 1. Hi, I'm Coffey */}
      <section
        aria-labelledby="coffey-hero-heading"
        className="flex flex-col items-center gap-8 text-center md:flex-row md:gap-12 md:text-left"
      >
        <CoffeyMascot size={160} expression="happy" title="Coffey, a smiling coffee cup" />
        <div>
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-tan-dark">Meet Coffey</span>
          <h1
            id="coffey-hero-heading"
            className="mt-2 text-3xl font-bold tracking-tight text-charcoal md:text-5xl"
          >
            Hi, I&apos;m Coffey
          </h1>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted">
            I&apos;m HIOC.&apos;s pick-helper. You tell me how you feel and what sounds good; I pick {PICKS} things
            from our real menu, each with a reason.
          </p>
        </div>
      </section>

      {/* 2. What I can do */}
      <section aria-labelledby="coffey-can-heading" className="mt-16">
        <SectionHeading id="coffey-can-heading">What I can do</SectionHeading>
        {/* Two balanced columns from md up (CSS columns, not a grid): the cards keep
            their natural heights instead of stretching to match a taller neighbour
            (the taste-profile chips make one card much taller than the rest), and
            the reading order down the columns is the source order. */}
        <ul role="list" className="mt-6 space-y-4 md:columns-2 md:gap-4 md:space-y-0">
          <Capability icon="💭" title="I read your mood">
            {capitalise(count(MOODS.length))} feelings to choose from, and you can pick up to {count(MAX_MOODS)}.
          </Capability>

          <Capability icon="📋" title="I know the whole menu">
            Every item carries a taste profile across {count(TRAIT_DIMENSIONS.length)} dimensions. When the menu is
            tagged, my AI answers {TRAIT_QUESTION_COUNT} questions about every single item, and flavours are grouped
            into {count(FLAVOUR_FAMILIES.length)} families, so &ldquo;nutty&rdquo; or &ldquo;fruity&rdquo; finds the
            right things.
            <ul role="list" aria-label="What I know about each item" className="mt-3 flex flex-wrap gap-1.5">
              {TRAIT_DIMENSIONS.map((dimension) => (
                <li
                  key={dimension.key}
                  className="rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-charcoal"
                >
                  {dimension.label}
                </li>
              ))}
            </ul>
          </Capability>

          <Capability icon="✅" title="I respect your rules">
            If you ask for iced, caffeine-free, a budget, or not-too-sweet, I never show you something that breaks it.
            Those rules are checked in code on every request, not left to the AI.
          </Capability>

          <Capability icon="🔀" title={`${capitalise(PICKS)} different picks`}>
            Not {PICKS} versions of the same drink.
          </Capability>

          <Capability icon="🏷️" title="Every pick says why">
            A one-line reason, plus &ldquo;why it matches&rdquo; tags.
          </Capability>

          <Capability icon="🍬" title="Sugar, your way">
            On drinks where you can choose sugar, I preselect the option closest to your sweetness pick. You can
            always change it.
          </Capability>

          <Capability icon="💛" title="I remember what you like" badge="Signed in">
            I learn from your past orders and show &ldquo;Your usual&rdquo;. You can reset it, or turn it off, in{' '}
            <Link href="/account" className="font-semibold text-tan-dark hover:underline">
              your account
            </Link>
            .
          </Capability>
        </ul>
      </section>

      {/* 3. How I choose */}
      <section aria-labelledby="coffey-how-heading" className="mt-16">
        <SectionHeading id="coffey-how-heading">How I choose</SectionHeading>
        <ol role="list" className="mt-6 grid gap-4 md:grid-cols-4 md:gap-6">
          {HOW_STEPS.map((step, i) => (
            <Step key={step.title} number={i + 1} title={step.title} last={i === HOW_STEPS.length - 1}>
              {step.body}
            </Step>
          ))}
        </ol>
        <p className="mt-5 rounded-md bg-surface px-4 py-3 text-charcoal">
          If the AI is ever slow or unavailable, I still answer from my own ranking.
        </p>
      </section>

      {/* 4. Why I ask what I ask — plain words, no statistics, no study names. */}
      <section aria-labelledby="coffey-why-heading" className="mt-16 max-w-2xl">
        <SectionHeading id="coffey-why-heading">Why I ask what I ask</SectionHeading>
        <ul role="list" className="mt-6 space-y-4 leading-relaxed text-charcoal">
          <Reason>
            <strong>How you feel</strong> changes what you crave, so I ask that first.
          </Reason>
          <Reason>
            <strong>Stress, tiredness and celebration</strong> all pull cravings in different directions, so
            there&apos;s a card for each.
          </Reason>
          <Reason>
            <strong>Feelings come mixed</strong>, so you can pick {count(MAX_MOODS)}.
          </Reason>
          <Reason>
            <strong>Sweetness is a scale</strong>, not a yes/no, so there are {count(SWEETNESS_STEPS)} steps.
          </Reason>
          <Reason>
            <strong>Too many choices make choosing harder</strong>, so I keep questions short and give you {PICKS}{' '}
            picks, not a long list.
          </Reason>
          <Reason>
            <strong>Some choices go together</strong>, like a drink and a bite, so you can tick more than one.
          </Reason>
        </ul>
      </section>

      {/* 5. Sugar, your way */}
      <section aria-labelledby="coffey-sugar-heading" className="mt-16 max-w-2xl">
        <SectionHeading id="coffey-sugar-heading">Sugar, your way</SectionHeading>
        <p className="mt-4 leading-relaxed text-charcoal">
          Every item gets a sweetness score out of {SWEETNESS_SCALE.max} for how sweet the kitchen makes it, before
          any sugar you add. Sugar can go in but never come out, so I treat a latte you can sweeten differently from
          a dessert that&apos;s already sweet. When you pick how sweet you&apos;d like it, I count the sugar choice
          too and preselect the closest option.
        </p>
      </section>

      {/* Add-ons and pairing ideas: after "Sugar, your way". The checkout paragraph only shows with its flag on. */}
      <section aria-labelledby="coffey-addons-heading" className="mt-16 max-w-2xl">
        <SectionHeading id="coffey-addons-heading">Add-ons and pairing ideas</SectionHeading>
        <p className="mt-4 leading-relaxed text-charcoal">
          When you pick a flavour and one of my picks doesn&apos;t have it on its own, I tell you which add-on gives it
          that flavour, like hazelnut syrup in a cappuccino. I point the add-on out on the customise screen and never
          add it for you.
        </p>
        {flags.checkoutPairings ? (
          <p className="mt-4 leading-relaxed text-charcoal">
            At checkout, I suggest a few things that go well with what&apos;s already in your cart. Each one has an Add
            button, and it&apos;s easy to ignore.
          </p>
        ) : null}
      </section>

      {/* 6. Your data */}
      <section aria-labelledby="coffey-data-heading" className="mt-16 max-w-2xl">
        <SectionHeading id="coffey-data-heading">Your data</SectionHeading>
        <p className="mt-4 leading-relaxed text-charcoal">
          My AI never sees your name, phone number or email. It only sees your answers and, if you&apos;re signed in,
          a simple taste summary like &ldquo;prefers iced, lightly sweet&rdquo;. You can reset it or switch it off in{' '}
          <Link href="/account" className="font-semibold text-tan-dark hover:underline">
            your account
          </Link>
          .
        </p>
      </section>

      {/* 7. What I can't do */}
      <section aria-labelledby="coffey-cant-heading" className="mt-16 max-w-2xl">
        <SectionHeading id="coffey-cant-heading">What I can&apos;t do</SectionHeading>
        <p className="mt-4 leading-relaxed text-charcoal">
          I don&apos;t chat or take orders by myself, and I can&apos;t answer allergen questions; please ask our team
          at the counter.
        </p>
      </section>

      {/* 8. Call to action */}
      <section
        aria-labelledby="coffey-cta-heading"
        className="mt-16 flex flex-col items-center gap-4 rounded-md border border-line bg-surface px-6 py-10 text-center"
      >
        {flags.suggest ? (
          <>
            <CoffeyMascot size={88} expression="wink" />
            <h2 id="coffey-cta-heading" className="text-2xl font-bold text-charcoal">
              Ready to try me?
            </h2>
            <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-5">
              <Link href="/suggest" className={buttonVariants({ size: 'lg' })}>
                Ask Coffey
              </Link>
              <Link
                href="/menu"
                className="inline-flex min-h-[44px] items-center font-semibold text-tan-dark hover:underline"
              >
                or browse the full menu
              </Link>
            </div>
          </>
        ) : (
          <>
            <CoffeyMascot size={88} expression="thinking" />
            <h2 id="coffey-cta-heading" className="text-2xl font-bold text-charcoal">
              Coffey is almost ready
            </h2>
            <p className="max-w-md text-muted">
              I&apos;m still brewing. In the meantime, the full menu is right this way.
            </p>
            <Link href="/menu" className={buttonVariants({ size: 'lg' })}>
              Browse the menu
            </Link>
          </>
        )}
      </section>
    </div>
  );
}

// One "What I can do" card: an icon tile, a title, and the words (plus anything
// extra as children, like the taste-profile chips).
function Capability({
  icon,
  title,
  badge,
  children,
}: {
  icon: string;
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="md:mb-4 md:break-inside-avoid">
      <Card className="flex gap-4">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface text-xl"
        >
          {icon}
        </span>
        <div className="min-w-0">
          {/* A wrapping row with a gap (not a margin), so on a narrow card the
              badge drops to its own line flush with the title instead of indented. */}
          <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-charcoal">
            {title}
            {badge ? (
              <span className="whitespace-nowrap rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-tan-dark">
                {badge}
              </span>
            ) : null}
          </h3>
          <div className="mt-1 text-muted">{children}</div>
        </div>
      </Card>
    </li>
  );
}

// One step of "How I choose". The number badge is decoration (the <ol> already
// numbers the steps for assistive tech); on wide screens a small arrow points on
// to the next card.
function Step({
  number,
  title,
  last = false,
  children,
}: {
  number: number;
  title: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="relative">
      <Card className="flex h-full gap-4 md:flex-col md:gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tan-dark font-bold text-cream"
        >
          {number}
        </span>
        <div>
          <h3 className="font-semibold text-charcoal">{title}</h3>
          <p className="mt-1 text-sm text-muted">{children}</p>
        </div>
      </Card>
      {last ? null : (
        <span aria-hidden="true" className="absolute -right-5 top-7 hidden text-tan-dark md:block">
          →
        </span>
      )}
    </li>
  );
}

// One line of "Why I ask what I ask", with a small tan dot as its bullet.
function Reason({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-tan" />
      <span>{children}</span>
    </li>
  );
}
