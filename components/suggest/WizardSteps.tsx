'use client';

// The two question steps of the /suggest wizard, as plain presentational
// components over the pure model in ./wizardModel.ts. SuggestWizard.tsx owns the
// state and the network; these draw it. They take no router or cart context, so
// they can be server-rendered in tests.
//
//   Step 1: "How are you feeling?": eight cards, one tap picks one and moves on.
//   Step 2: "What sounds good?": five groups of toggle chips, then one
//           collapsed "More options" section, then a sticky "Show my picks".
//
// Every chip is a toggle: tap again to clear it, and cleared means "no
// preference". There is no "Either" or "Any" chip anywhere.

import { useId, useState, type ReactNode, type RefObject } from 'react';
import { CoffeyBubble } from '@/components/coffey/CoffeyBubble';
import { Chip } from '@/components/suggest/Chip';
import { MoodCard } from '@/components/suggest/MoodCard';
import {
  BODY_CHOICES,
  BODY_LABEL,
  BUDGET_CHOICES,
  BUDGET_LABEL,
  CAFFEINE_FREE_LABEL,
  COFFEE_CHOICES,
  COFFEE_LABEL,
  KIND_INFO,
  bodyOption,
  budgetOption,
  coffeeOption,
  disabledOptions,
  flavourOption,
  sweetOption,
  tempOption,
  CAFFEINE_FREE_OPTION,
  MORE_OPTIONS_LABEL,
  SWEETNESS_CHOICES,
  SWEETNESS_LABEL,
  TEMPERATURES,
  TEMPERATURE_LABEL,
  moreOptionsSet,
  moreOptionsSummary,
  offeredFlavours,
  toggleBody,
  toggleBudget,
  toggleCaffeineFree,
  toggleCoffee,
  toggleFlavour,
  toggleKind,
  toggleSweetness,
  toggleTemperature,
  wantsDrink,
  type WizardState,
} from '@/components/suggest/wizardModel';
import { buttonVariants } from '@/components/ui/Button';
import { FLAVOUR_FAMILY_INFO, MOOD_INFO } from '@/lib/suggest/traitVocabulary';
import type { FacetOption, MenuFacet } from '@/lib/suggest/facets';
import { KINDS, MOODS, SUGGEST_LIMITS } from '@/lib/suggest/types';
import type { FlavourCounts, Mood } from '@/lib/suggest/types';

// A titled group of controls: the heading names the group for assistive tech
// (role="group" + aria-labelledby) so a screen-reader user hears "Hot or iced?,
// group" before the toggles, and the optional hint is read as its description.
export function FieldGroup({
  label,
  hint,
  className = 'flex flex-wrap gap-2',
  children,
}: {
  label: string;
  hint?: string;
  /** Layout of the controls; most groups are a wrapping row of chips. */
  className?: string;
  children: ReactNode;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="mt-6">
      <h2 id={labelId} className="text-sm font-semibold text-charcoal">
        {label}
      </h2>
      {hint ? (
        <p id={hintId} className="mt-0.5 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        className={'mt-2 ' + className}
      >
        {children}
      </div>
    </div>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-2 mb-2 inline-flex min-h-[44px] items-center px-2 text-sm font-semibold text-tan-dark hover:underline"
    >
      <span aria-hidden="true">←&nbsp;</span>
      Back
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 1
// ---------------------------------------------------------------------------

export function FeelingStep({
  selected,
  headingRef,
  onPick,
}: {
  selected: Mood | null;
  headingRef: RefObject<HTMLHeadingElement>;
  onPick: (mood: Mood) => void;
}) {
  return (
    <section aria-labelledby="suggest-step1-heading">
      <CoffeyBubble>
        Hi, I&apos;m Coffey! I know every item on the menu here at HIOC. Let&apos;s find your pick.
      </CoffeyBubble>

      <h1
        id="suggest-step1-heading"
        ref={headingRef}
        tabIndex={-1}
        className="mt-6 text-2xl font-bold text-charcoal outline-none"
      >
        How are you feeling?
      </h1>
      <p className="mt-1 text-sm text-muted">Tap the one that fits.</p>

      <div role="group" aria-labelledby="suggest-step1-heading" className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* Eight cards: a 2×4 grid on phones, 4×2 on wider screens. */}
        {MOODS.map((mood) => (
          <MoodCard
            key={mood}
            label={MOOD_INFO[mood].card}
            icon={MOOD_INFO[mood].icon}
            selected={selected === mood}
            onToggle={() => onPick(mood)}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 2
// ---------------------------------------------------------------------------

export function WantsStep({
  state,
  flavourCounts,
  facets = null,
  cartHasItems,
  headingRef,
  onChange,
  onBack,
  onSubmit,
}: {
  state: WizardState;
  flavourCounts: FlavourCounts | null;
  /** Per-item option states from the server; null = nothing is greyed out. */
  facets?: MenuFacet[] | null;
  /** The floating cart bar is showing, so the sticky button sits above it. */
  cartHasItems: boolean;
  headingRef: RefObject<HTMLHeadingElement>;
  onChange: (update: (prev: WizardState) => WizardState) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const noteId = useId();
  const morePanelId = useId();
  // null = the customer has not touched the section, so it follows the values:
  // shut while nothing inside is set, open as soon as something is.
  const [moreOpenChoice, setMoreOpenChoice] = useState<boolean | null>(null);

  const drink = wantsDrink(state);
  const flavours = offeredFlavours(state.kinds, flavourCounts);
  const moreSet = moreOptionsSet(state);
  const moreOpen = moreOpenChoice ?? moreSet;
  const off = disabledOptions(state, facets, flavourCounts);

  return (
    <section aria-labelledby="suggest-step2-heading">
      <BackButton onClick={onBack} />
      <CoffeyBubble>Lovely. What sounds good right now?</CoffeyBubble>

      <h1
        id="suggest-step2-heading"
        ref={headingRef}
        tabIndex={-1}
        className="mt-6 text-2xl font-bold text-charcoal outline-none"
      >
        What sounds good?
      </h1>
      {/* The greyed-out rule is said once, here, and is always on screen while it
          can apply — not repeated under every group, and not popping in and out
          (which would shift the chips under the customer's thumb). */}
      <p className="mt-1 text-sm text-muted">
        Pick what matters to you — skip the rest.
        {facets !== null ? ' Greyed-out choices aren’t on the menu with what you’ve picked.' : ''}
      </p>

      <FieldGroup label="What would you like?" hint="Pick one or more.">
        {KINDS.map((kind) => (
          <Chip
            key={kind}
            label={KIND_INFO[kind].label}
            icon={KIND_INFO[kind].icon}
            pressed={state.kinds.includes(kind)}
            onClick={() => onChange((s) => toggleKind(s, kind))}
          />
        ))}
      </FieldGroup>

      {drink ? (
        <>
          <FieldGroup label="Hot or iced?">
            {TEMPERATURES.map((value) => (
              <Chip
                key={value}
                label={TEMPERATURE_LABEL[value]}
                disabled={off.has(tempOption(value))}
                pressed={state.temperature === value}
                onClick={() => onChange((s) => toggleTemperature(s, value))}
              />
            ))}
          </FieldGroup>

          <FieldGroup
            label="Coffee?"
            hint={
              state.caffeineFree
                ? 'Strong and smooth coffee are off while Caffeine-free is on.'
                : 'Strong = bold and espresso-forward. Smooth = milky and mellow.'
            }
          >
            {COFFEE_CHOICES.map((value) => (
              <Chip
                key={value}
                label={COFFEE_LABEL[value]}
                pressed={state.coffee === value}
                disabled={(state.caffeineFree && value !== 'none') || off.has(coffeeOption(value))}
                onClick={() => onChange((s) => toggleCoffee(s, value))}
              />
            ))}
          </FieldGroup>
        </>
      ) : null}

      <FieldGroup
        label="How sweet?"
        hint={drink ? 'Coffee drinks can be made with or without sugar — Coffey sets it for you.' : undefined}
      >
        {SWEETNESS_CHOICES.map((value) => (
          <Chip
            key={value}
            label={SWEETNESS_LABEL[value]}
            disabled={off.has(sweetOption(value))}
            pressed={state.sweetness === value}
            onClick={() => onChange((s) => toggleSweetness(s, value))}
          />
        ))}
      </FieldGroup>

      {flavours.length > 0 ? (
        <FieldGroup label="Any flavour you fancy?" hint="Pick any that tempt you.">
          {flavours.map((family) => (
            <Chip
              key={family}
              label={FLAVOUR_FAMILY_INFO[family].label}
              icon={FLAVOUR_FAMILY_INFO[family].emoji}
              disabled={off.has(flavourOption(family))}
              pressed={state.flavours.includes(family)}
              onClick={() => onChange((s) => toggleFlavour(s, family))}
            />
          ))}
        </FieldGroup>
      ) : null}

      {/* One disclosure for everything rarely needed. Shut, it summarises what is
          set inside it; it opens by itself when anything is. */}
      <div className="mt-6 rounded-md border border-line">
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-controls={morePanelId}
          onClick={() => setMoreOpenChoice(!moreOpen)}
          className="flex min-h-[56px] w-full items-center justify-between gap-3 rounded-md px-4 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-tan"
        >
          <span>
            <span className="block text-sm font-semibold text-charcoal">{MORE_OPTIONS_LABEL}</span>
            {!moreOpen && moreSet ? (
              <span className="block text-sm text-muted">{moreOptionsSummary(state)}</span>
            ) : null}
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            className={'h-5 w-5 shrink-0 text-charcoal transition-transform ' + (moreOpen ? 'rotate-180' : '')}
          >
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div id={morePanelId} hidden={!moreOpen} className="border-t border-line px-4 pb-4">
          <FieldGroup label="Caffeine" hint="There's no caffeine-free coffee on the menu, so this leaves coffee out.">
            <Chip
              label={`${CAFFEINE_FREE_LABEL} only`}
              disabled={off.has(CAFFEINE_FREE_OPTION)}
              pressed={state.caffeineFree}
              onClick={() => onChange(toggleCaffeineFree)}
            />
          </FieldGroup>

          <FieldGroup label="Budget">
            {BUDGET_CHOICES.map((value) => (
              <Chip
                key={value}
                label={BUDGET_LABEL[value]}
                disabled={off.has(budgetOption(value))}
                pressed={state.budget === value}
                onClick={() => onChange((s) => toggleBudget(s, value))}
              />
            ))}
          </FieldGroup>

          <FieldGroup label="Texture">
            {BODY_CHOICES.map((value) => (
              <Chip
                key={value}
                label={BODY_LABEL[value]}
                disabled={off.has(bodyOption(value))}
                pressed={state.body === value}
                onClick={() => onChange((s) => toggleBody(s, value))}
              />
            ))}
          </FieldGroup>

          <div className="mt-6">
            <label htmlFor={noteId} className="mb-1 block text-sm font-semibold text-charcoal">
              Tell Coffey anything <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id={noteId}
              type="text"
              value={state.note}
              maxLength={SUGGEST_LIMITS.noteMaxChars}
              onChange={(e) => {
                const note = e.target.value.slice(0, SUGGEST_LIMITS.noteMaxChars);
                onChange((s) => ({ ...s, note }));
              }}
              placeholder="e.g. studying late, sharing with a friend"
              className="w-full rounded-md border border-line px-3 py-2 text-base text-charcoal placeholder:text-muted focus:border-tan"
            />
            <p className="mt-1 text-right text-sm text-muted">
              {state.note.length}/{SUGGEST_LIMITS.noteMaxChars}
            </p>
          </div>
        </div>
      </div>

      {/* Sticky, so the way forward is always on screen. Solid background so chips
          don't show through. The floating cart bar (z-30, fixed to the bottom,
          52px tall plus max(1rem, safe-area) of padding) is transparent around
          its pill, so when it is showing this strip keeps its own background
          underneath it and pads the button up by the bar's height (3.75rem) so
          neither covers the other. */}
      <div
        className={
          'sticky bottom-0 z-20 -mx-4 mt-8 border-t border-line bg-cream px-4 pt-3 ' +
          (cartHasItems
            ? 'pb-[calc(max(1rem,env(safe-area-inset-bottom))+3.75rem)]'
            : 'pb-[max(0.75rem,env(safe-area-inset-bottom))]')
        }
      >
        <button type="button" onClick={onSubmit} className={buttonVariants({ size: 'lg', fullWidth: true })}>
          Show my picks
        </button>
      </div>
    </section>
  );
}
