'use client';

// The /suggest wizard, v2 — "Ask Coffey" (docs/COFFEY-SPEC.md §1). Owns all
// client state; talks to the server only through components/suggest/api.ts,
// which is the seam that follows the lib/suggest/types.ts contract.
//
// Three steps, with Coffey (the mascot and a speech bubble) on every one:
//   1. "How are you feeling?": up to two feelings, as cards.
//   2. "What sounds good?": what to have, hot or iced, coffee, how sweet,
//      flavours, budget, fine-tune (texture), and a free note.
//   3. Coffey's picks.
// What the customer picks is sent as v2 SuggestInputs (the API also still accepts
// v1 bodies, but nothing here sends one).

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart/CartContext';
import { CoffeyBubble } from '@/components/coffey/CoffeyBubble';
import { MenuItemCustomizeModal } from '@/components/menu/MenuItemCustomizeModal';
import { Chip } from '@/components/suggest/Chip';
import { MoodCard } from '@/components/suggest/MoodCard';
import { SuggestionCard } from '@/components/suggest/SuggestionCard';
import { customizeModalProps, needsCustomizeModal } from '@/components/suggest/addonHint';
import { SweetnessScale } from '@/components/suggest/SweetnessScale';
import { ResultsSkeleton, ThinkingCopy } from '@/components/suggest/ResultsSkeleton';
import { fetchSuggestions, getAnonId, postSuggestEvent } from '@/components/suggest/api';
import { buttonVariants } from '@/components/ui/Button';
import { FLAVOUR_FAMILY_INFO, MOOD_INFO } from '@/lib/suggest/traitVocabulary';
import {
  BODY_PREFS,
  BUDGETS,
  BUDGET_CAPS,
  FLAVOUR_FAMILIES,
  KINDS,
  MAX_MOODS,
  MOODS,
  SUGGEST_LIMITS,
} from '@/lib/suggest/types';
import type {
  BodyPref,
  Budget,
  FlavourAddonSuggestion,
  FlavourFamily,
  Mood,
  RelaxHint,
  SuggestInputs,
  SuggestResponse,
  SuggestionPick,
  SugarPreset,
  SweetnessPref,
  TemperaturePref,
  TraitKind,
} from '@/lib/suggest/types';
import type { MenuItem } from '@/lib/types';

// "What would you like?" — in the contract's KINDS order (drink, dessert, food).
const KIND_INFO: Record<TraitKind, { label: string; icon: string }> = {
  drink: { label: 'A drink', icon: '☕' },
  dessert: { label: 'Something sweet', icon: '🧇' },
  food: { label: 'Something savoury', icon: '🥪' },
};

const TEMPERATURE_OPTIONS: { value: TemperaturePref; label: string }[] = [
  { value: 'hot', label: 'Hot' },
  { value: 'iced', label: 'Iced' },
  { value: 'either', label: 'Either' },
];

// "Coffee?" is ONE question for the customer that maps onto three engine
// fields (COFFEY-SPEC §1): whether the drink is coffee, how strong, and whether
// it must be caffeine-free. Strength is a soft preference; coffee / no coffee /
// caffeine-free are hard.
type CoffeeChoice = 'strong' | 'smooth' | 'none' | 'decaf' | 'either';

// Worded so no two can both be true ("No coffee (tea's fine)" vs "No caffeine at
// all"), which is why each says what it does and doesn't allow.
const COFFEE_OPTIONS: { value: CoffeeChoice; label: string }[] = [
  { value: 'strong', label: 'Strong coffee' },
  { value: 'smooth', label: 'Smooth & milky coffee' },
  { value: 'none', label: "No coffee (tea's fine)" },
  { value: 'decaf', label: 'No caffeine at all' },
  { value: 'either', label: 'Either' },
];

function coffeeFields(choice: CoffeeChoice): Pick<SuggestInputs, 'base' | 'strength' | 'needs'> {
  switch (choice) {
    case 'strong':
      return { base: 'coffee', strength: 'strong', needs: [] };
    case 'smooth':
      return { base: 'coffee', strength: 'mild', needs: [] };
    case 'none':
      return { base: 'no_coffee', strength: 'any', needs: [] };
    case 'decaf':
      return { base: 'no_coffee', strength: 'any', needs: ['no_caffeine'] };
    case 'either':
      return { base: 'either', strength: 'any', needs: [] };
  }
}

// "Filling" keeps a hunger cue now that the old "Filling" chip is gone.
const BODY_LABEL: Record<BodyPref, string> = {
  light: 'Light & refreshing',
  rich: 'Rich & filling',
  any: 'Any',
};

// Budget is a price CEILING on an item's cheapest size (COFFEY-SPEC §1), so the
// labels are read straight off the contract's caps and can't drift from what the
// engine filters on.
const BUDGET_OPTIONS: { value: Budget; label: string }[] = BUDGETS.map((value) => {
  const cap = BUDGET_CAPS[value];
  return { value, label: cap === null ? 'Any' : `Up to ₹${cap}` };
});

// Above SUGGEST_LIMITS.deciderTimeoutMs (9s) plus room for the rest of the
// route's work; the skeleton cards + Coffey's rotating "thinking" lines cover
// the wait.
const SUGGEST_TIMEOUT_MS = 15000;

const FALLBACK_HEADER = "Here's what I'd pour for you ☕";

// A titled group of controls: the heading names the group for assistive tech
// (role="group" + aria-labelledby) so a screen-reader user hears "Hot or iced?,
// group" before the toggles, and the optional hint is read as its description.
function FieldGroup({
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

function BackButton({ onClick }: { onClick: () => void }) {
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

type Step = 'feeling' | 'wants' | 'results';

interface CustomizeTarget {
  item: MenuItem;
  sessionId: string;
  beforeCartTotal: number;
  /** The sugar option Coffey preselected for this pick, if any (§4.7). */
  sugarPreset: SugarPreset | null;
  /** The add-on Coffey points to for a requested flavour, if any
   * (COFFEY-ADDONS-PAIRINGS-SPEC §1.1). Highlighted in the modal, never
   * preselected. */
  flavourAddon: FlavourAddonSuggestion | null;
}

// The customise modal for a pick. Coffey's sugar preselection (§4.7) goes in as
// `initialSelection`; the flavour add-on (COFFEY-ADDONS-PAIRINGS-SPEC §1.1) goes
// in as `suggestedOptions` and is NOT preselected, so it can never quietly add to
// the bill. The engine names groups and options; the modal vets them against the
// item. Hints stack, sugar first (components/suggest/addonHint.ts).
function CustomizeModal({ target, onClose }: { target: CustomizeTarget; onClose: () => void }) {
  const { initialSelection, suggestedOptions, hint } = customizeModalProps(target.item, target);
  return (
    <MenuItemCustomizeModal
      item={target.item}
      onClose={onClose}
      initialSelection={initialSelection}
      suggestedOptions={suggestedOptions}
      hint={hint}
    />
  );
}

export function SuggestWizard() {
  const router = useRouter();
  const { addItem, totalItems, setPendingSuggestionSessionId } = useCart();

  const [step, setStep] = useState<Step>('feeling');
  // In the order they were picked: the first is the primary feeling, the second
  // the secondary one. Taking the primary off promotes the other.
  const [moods, setMoods] = useState<Mood[]>([]);
  const [kinds, setKinds] = useState<TraitKind[]>(['drink']);
  const [temperature, setTemperature] = useState<TemperaturePref>('either');
  const [coffee, setCoffee] = useState<CoffeeChoice>('either');
  const [sweetness, setSweetness] = useState<SweetnessPref>('any');
  const [flavours, setFlavours] = useState<FlavourFamily[]>([]);
  const [body, setBody] = useState<BodyPref>('any');
  const [budget, setBudget] = useState<Budget>('any');
  // null = the customer hasn't touched the disclosure, so it follows the value:
  // shut while texture is on "any", open as soon as it isn't.
  const [fineTuneOpen, setFineTuneOpen] = useState<boolean | null>(null);
  const [note, setNote] = useState('');

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [response, setResponse] = useState<SuggestResponse | null>(null);
  const [shownIds, setShownIds] = useState<string[]>([]);
  const [feedbackGiven, setFeedbackGiven] = useState<Record<string, 'up' | 'down'>>({});
  const [customizeTarget, setCustomizeTarget] = useState<CustomizeTarget | null>(null);
  const [closedCustomizeTarget, setClosedCustomizeTarget] = useState<CustomizeTarget | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Has this session already produced an explicit signal (added to cart,
  // refined, or the customer chose to browse the menu instead)? Only if not
  // do we consider it "dismissed" when the customer leaves (see the pagehide
  // effect below).
  const engagedRef = useRef(false);
  // Context defaults (COFFEY-SPEC §1) fill in a group only if the customer
  // hasn't touched it, and only once per feeling — so going Back and forth never
  // undoes an edit or re-ticks something they un-ticked. Refs, not state: they
  // are only ever read from event handlers and never change what is drawn.
  const touchedRef = useRef({ kinds: false, temperature: false });
  const appliedMoodsRef = useRef(new Set<Mood>());

  const fineTunePanelId = useId();
  const noteId = useId();

  useEffect(() => {
    sessionIdRef.current = response?.sessionId ?? null;
  }, [response]);

  // Accessibility: move focus to the current step's heading on every step
  // change, so a screen-reader user (and a keyboard user who just pressed
  // Next/Back) lands on the new step's content instead of wherever the old
  // button used to be. It also runs when a request starts and ends, because
  // "Show me something different" replaces the very button that was focused.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step, loading]);

  // 'dismissed' (§7): fires once, only if suggestions were actually shown and
  // the customer leaves without adding anything, refining, or explicitly
  // choosing "browse the menu" (those each fire their own event instead).
  // Covers both an in-app navigation away (this component unmounting) and a
  // real tab close/reload (pagehide — postSuggestEvent uses sendBeacon there).
  useEffect(() => {
    function fireIfDue() {
      if (sessionIdRef.current && !engagedRef.current) {
        postSuggestEvent(sessionIdRef.current, 'dismissed');
        engagedRef.current = true;
      }
    }
    window.addEventListener('pagehide', fireIfDue);
    return () => {
      window.removeEventListener('pagehide', fireIfDue);
      fireIfDue();
    };
  }, []);

  const itemsById = useMemo(() => {
    const map = new Map<string, MenuItem>();
    for (const item of response?.items ?? []) map.set(item.id, item);
    return map;
  }, [response]);

  const wantsDrink = kinds.includes('drink');

  const buildInputs = useCallback(
    (overrides: Partial<SuggestInputs> = {}): SuggestInputs => ({
      // moods[0] exists by the time this runs: Next is disabled until one is
      // picked, so the 'surprise' fallback is unreachable in practice — it only
      // satisfies the type.
      mood: moods[0] ?? 'surprise',
      secondaryMood: moods[1] ?? null,
      // Canonical order, no duplicates, whatever order they were ticked in.
      kinds: KINDS.filter((k) => kinds.includes(k)),
      // Hot or iced and Coffee? are only shown while "A drink" is ticked; when
      // hidden they go out as their neutral values, so a stale pick can't filter
      // a dessert-only request.
      temperature: wantsDrink ? temperature : 'either',
      ...coffeeFields(wantsDrink ? coffee : 'either'),
      sweetness,
      body,
      flavours: FLAVOUR_FAMILIES.filter((f) => flavours.includes(f)),
      budget,
      note: note.trim().slice(0, SUGGEST_LIMITS.noteMaxChars),
      ...overrides,
    }),
    [moods, kinds, wantsDrink, temperature, coffee, sweetness, body, flavours, budget, note],
  );

  const runSuggest = useCallback(
    async (inputs: SuggestInputs, opts: { refineOf?: string; exclude?: string[] } = {}) => {
      setStep('results');
      setLoading(true);
      setErrorMsg(null);
      const anonId = getAnonId();

      const attempt = () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
        return fetchSuggestions(
          {
            inputs,
            anonId,
            refineOf: opts.refineOf,
            excludeItemIds: opts.exclude?.slice(0, SUGGEST_LIMITS.excludeMax),
          },
          { signal: controller.signal },
        ).finally(() => clearTimeout(timer));
      };

      try {
        let result: SuggestResponse;
        try {
          result = await attempt();
        } catch {
          // One retry on timeout/network error, per §3.3.
          result = await attempt();
        }
        setResponse(result);
        engagedRef.current = false;
        const shown = [
          ...(result.usual ? [result.usual.menuItemId] : []),
          ...result.picks.map((p) => p.menuItemId),
        ];
        setShownIds((prev) => Array.from(new Set([...prev, ...shown])));
      } catch {
        setErrorMsg(
          "We couldn't quite get suggestions together just now. Please try again in a moment, or head straight to the menu.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  function toggleMood(mood: Mood) {
    setMoods((prev) => {
      if (prev.includes(mood)) return prev.filter((m) => m !== mood);
      // The cards past the cap are disabled, so this is a backstop.
      return prev.length >= MAX_MOODS ? prev : [...prev, mood];
    });
  }

  // Leaving step 1: apply the context defaults (visible and editable on the next
  // step). `celebrate` ticks the sweet kind; `cool` selects Iced.
  function goToWants() {
    if (moods.length === 0) return;
    const fresh = moods.filter((m) => !appliedMoodsRef.current.has(m));
    if (fresh.includes('celebrate') && !touchedRef.current.kinds) {
      setKinds((prev) => (prev.includes('dessert') ? prev : [...prev, 'dessert']));
    }
    if (fresh.includes('cool') && !touchedRef.current.temperature) {
      setTemperature('iced');
    }
    for (const m of fresh) appliedMoodsRef.current.add(m);
    setStep('wants');
  }

  function toggleKind(kind: TraitKind) {
    touchedRef.current.kinds = true;
    setKinds((prev) => {
      if (!prev.includes(kind)) return [...prev, kind];
      // The last one ticked can't be un-ticked: a request needs something in it.
      return prev.length > 1 ? prev.filter((k) => k !== kind) : prev;
    });
  }

  function toggleFlavour(flavour: FlavourFamily) {
    setFlavours((prev) => (prev.includes(flavour) ? prev.filter((f) => f !== flavour) : [...prev, flavour]));
  }

  function submitForSuggestions() {
    if (moods.length === 0) return;
    runSuggest(buildInputs());
  }

  function handleRefine() {
    if (!response) return;
    postSuggestEvent(response.sessionId, 'refined');
    engagedRef.current = true;
    runSuggest(buildInputs(), { refineOf: response.sessionId, exclude: shownIds });
  }

  // "Show me more options": drop the one constraint the engine named, on screen
  // as well as in the request, so what the customer sees on Back matches.
  function handleRelax(constraint: RelaxHint['constraint']) {
    let nextInputs: SuggestInputs;
    switch (constraint) {
      case 'temperature':
        setTemperature('either');
        nextInputs = buildInputs({ temperature: 'either' });
        break;
      case 'sweetness':
        setSweetness('any');
        nextInputs = buildInputs({ sweetness: 'any' });
        break;
      case 'base':
        if (coffee === 'decaf') {
          // "Caffeine-free" is one choice made of two parts; only loosen the
          // coffee half. (The engine offers `needs` for the other.)
          nextInputs = buildInputs({ base: 'either' });
        } else {
          setCoffee('either');
          nextInputs = buildInputs({ base: 'either', strength: 'any' });
        }
        break;
      case 'needs':
        // No caffeine only ever comes from "Caffeine-free": relaxing it leaves
        // "No coffee".
        if (coffee === 'decaf') setCoffee('none');
        nextInputs = buildInputs({ needs: [] });
        break;
      case 'budget':
        setBudget('any');
        nextInputs = buildInputs({ budget: 'any' });
        break;
      default:
        // 'extras' (the v1 composition rule) is never offered by the v2 engine.
        nextInputs = buildInputs();
    }
    runSuggest(nextInputs);
  }

  function handleAddToCart(item: MenuItem, pick: SuggestionPick) {
    if (!response) return;
    // A pick that carries a flavour add-on never takes the one-tap path, even on
    // an otherwise simple item: the customer has to see the suggestion (§1.1).
    const isSimple = !needsCustomizeModal(item, pick);
    engagedRef.current = true;
    if (isSimple && item.variants[0]) {
      const variant = item.variants[0];
      addItem({
        menuItemId: item.id,
        variantId: variant.id,
        name: item.name,
        variantLabel: variant.label,
        unitPriceInr: variant.price_inr,
        gstExempt: item.gst_exempt === true,
        addons: [],
        specialInstructions: '',
        suggestionSessionId: response.sessionId,
      });
      postSuggestEvent(response.sessionId, 'added_to_cart', item.id);
    } else {
      // Required addon choices (or multiple sizes) mean this has to go
      // through the existing customize modal, same as /menu (§3.2). The
      // session id rides along via the cart's one-shot "pending" hint since
      // that modal calls addItem() itself and isn't part of this phase.
      setPendingSuggestionSessionId(response.sessionId);
      setCustomizeTarget({
        item,
        sessionId: response.sessionId,
        beforeCartTotal: totalItems,
        sugarPreset: pick.sugarPreset ?? null,
        flavourAddon: pick.flavourAddon ?? null,
      });
    }
  }

  function handleCloseCustomize() {
    setClosedCustomizeTarget(customizeTarget);
    setCustomizeTarget(null);
    setPendingSuggestionSessionId(null);
  }

  // Fires 'added_to_cart' only if the modal's close actually followed a
  // successful add (cart total grew) — a Cancel/Escape/X close must not.
  useEffect(() => {
    if (!closedCustomizeTarget) return;
    if (totalItems > closedCustomizeTarget.beforeCartTotal) {
      postSuggestEvent(closedCustomizeTarget.sessionId, 'added_to_cart', closedCustomizeTarget.item.id);
    }
    setClosedCustomizeTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalItems, closedCustomizeTarget]);

  function handleFeedback(menuItemId: string, direction: 'up' | 'down') {
    if (!response) return;
    postSuggestEvent(response.sessionId, direction === 'up' ? 'feedback_up' : 'feedback_down', menuItemId);
    setFeedbackGiven((prev) => ({ ...prev, [menuItemId]: direction }));
  }

  function handleBrowseMenu() {
    if (response) {
      postSuggestEvent(response.sessionId, 'browse_menu');
    }
    engagedRef.current = true;
    router.push('/menu');
  }

  function renderCard(pick: SuggestionPick, isUsual = false) {
    const item = itemsById.get(pick.menuItemId);
    if (!item) return null;
    return (
      <SuggestionCard
        key={pick.menuItemId}
        item={item}
        pick={pick}
        isUsual={isUsual}
        feedback={feedbackGiven[pick.menuItemId]}
        onAddToCart={() => handleAddToCart(item, pick)}
        onFeedback={(dir) => handleFeedback(pick.menuItemId, dir)}
      />
    );
  }

  const moodsFull = moods.length >= MAX_MOODS;

  const fineTuneIsOpen = fineTuneOpen ?? body !== 'any';
  const fineTuneSummary = body === 'any' ? 'Any texture' : BODY_LABEL[body];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 pb-28">
      {step === 'feeling' ? (
        <section aria-labelledby="suggest-step1-heading">
          <CoffeyBubble>
            Hi, I&apos;m Coffey! I know every item on the HIOC. menu — let&apos;s find your pick.
          </CoffeyBubble>

          <h1
            id="suggest-step1-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mt-6 text-2xl font-bold text-charcoal outline-none"
          >
            How are you feeling?
          </h1>
          {/* role="status": when the second pick fills the cap, the other cards
              switch off, and this is where a screen-reader user hears why. */}
          <p id="suggest-mood-hint" role="status" className="mt-1 text-sm text-muted">
            {moodsFull ? 'Pick up to two — tap one to swap.' : 'Pick one or two.'}
          </p>

          <div
            role="group"
            aria-labelledby="suggest-step1-heading"
            aria-describedby="suggest-mood-hint"
            className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"
          >
            {/* Eight cards: a 2×4 grid on phones, 4×2 on wider screens. */}
            {MOODS.map((mood) => {
              const selected = moods.includes(mood);
              return (
                <MoodCard
                  key={mood}
                  label={MOOD_INFO[mood].card}
                  icon={MOOD_INFO[mood].icon}
                  selected={selected}
                  disabled={moodsFull && !selected}
                  onToggle={() => toggleMood(mood)}
                />
              );
            })}
          </div>

          <div className="mt-8 flex justify-end">
            <button
              type="button"
              disabled={moods.length === 0}
              onClick={goToWants}
              className={buttonVariants({ size: 'lg' })}
            >
              Next
            </button>
          </div>
        </section>
      ) : null}

      {step === 'wants' ? (
        <section aria-labelledby="suggest-step2-heading">
          <BackButton onClick={() => setStep('feeling')} />
          <CoffeyBubble>Lovely. What sounds good right now?</CoffeyBubble>

          <h1
            id="suggest-step2-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mt-6 text-2xl font-bold text-charcoal outline-none"
          >
            What sounds good?
          </h1>
          <p className="mt-1 text-sm text-muted">Skip whatever you like — I&apos;ll work with the rest.</p>

          <FieldGroup label="What would you like?" hint="Pick one or more.">
            {KINDS.map((kind) => (
              <Chip
                key={kind}
                label={KIND_INFO[kind].label}
                icon={KIND_INFO[kind].icon}
                pressed={kinds.includes(kind)}
                onClick={() => toggleKind(kind)}
              />
            ))}
          </FieldGroup>

          {wantsDrink ? (
            <>
              <FieldGroup label="Hot or iced?">
                {TEMPERATURE_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.value}
                    label={opt.label}
                    pressed={temperature === opt.value}
                    onClick={() => {
                      touchedRef.current.temperature = true;
                      setTemperature(opt.value);
                    }}
                  />
                ))}
              </FieldGroup>

              <FieldGroup label="Coffee?" hint="Strong = bold and espresso-forward. Smooth = milky and mellow.">
                {COFFEE_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.value}
                    label={opt.label}
                    pressed={coffee === opt.value}
                    onClick={() => setCoffee(opt.value)}
                  />
                ))}
              </FieldGroup>
            </>
          ) : null}

          <FieldGroup
            label="How sweet?"
            hint="Coffee drinks can be made with or without sugar — Coffey sets it for you."
            className="flex flex-col gap-3"
          >
            <SweetnessScale value={sweetness} onChange={setSweetness} />
          </FieldGroup>

          <FieldGroup label="Flavours you love" hint="Pick any that tempt you.">
            {FLAVOUR_FAMILIES.map((family) => (
              <Chip
                key={family}
                label={FLAVOUR_FAMILY_INFO[family].label}
                icon={FLAVOUR_FAMILY_INFO[family].emoji}
                pressed={flavours.includes(family)}
                onClick={() => toggleFlavour(family)}
              />
            ))}
          </FieldGroup>

          <FieldGroup label="Budget">
            {BUDGET_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                pressed={budget === opt.value}
                onClick={() => setBudget(opt.value)}
              />
            ))}
          </FieldGroup>

          {/* Fine-tune: progressive disclosure for the one rarely-needed control.
              Shut, it summarises what's set; it opens by itself when texture isn't
              "any". */}
          <div className="mt-6 rounded-md border border-line">
            <button
              type="button"
              aria-expanded={fineTuneIsOpen}
              aria-controls={fineTunePanelId}
              onClick={() => setFineTuneOpen(!fineTuneIsOpen)}
              className="flex min-h-[56px] w-full items-center justify-between gap-3 rounded-md px-4 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-tan"
            >
              <span>
                <span className="block text-sm font-semibold text-charcoal">Fine-tune</span>
                {fineTuneIsOpen ? null : <span className="block text-sm text-muted">{fineTuneSummary}</span>}
              </span>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                className={'h-5 w-5 shrink-0 text-charcoal transition-transform ' + (fineTuneIsOpen ? 'rotate-180' : '')}
              >
                <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div id={fineTunePanelId} hidden={!fineTuneIsOpen} className="border-t border-line px-4 pb-4">
              <FieldGroup label="Texture">
                {BODY_PREFS.map((pref) => (
                  <Chip key={pref} label={BODY_LABEL[pref]} pressed={body === pref} onClick={() => setBody(pref)} />
                ))}
              </FieldGroup>
            </div>
          </div>

          <div className="mt-6">
            <label htmlFor={noteId} className="mb-1 block text-sm font-semibold text-charcoal">
              Tell Coffey anything <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id={noteId}
              type="text"
              value={note}
              maxLength={SUGGEST_LIMITS.noteMaxChars}
              onChange={(e) => setNote(e.target.value.slice(0, SUGGEST_LIMITS.noteMaxChars))}
              placeholder="e.g. studying late, sharing with a friend"
              className="w-full rounded-md border border-line px-3 py-2 text-base text-charcoal placeholder:text-muted focus:border-tan"
            />
            <p className="mt-1 text-right text-sm text-muted">
              {note.length}/{SUGGEST_LIMITS.noteMaxChars}
            </p>
          </div>

          <div className="mt-8 flex justify-end">
            <button type="button" onClick={submitForSuggestions} className={buttonVariants({ size: 'lg' })}>
              Ask Coffey
            </button>
          </div>
        </section>
      ) : null}

      {step === 'results' ? (
        <section aria-labelledby="suggest-step3-heading">
          <BackButton onClick={() => setStep('wants')} />
          {/* One bubble stays mounted from "thinking" through the picks (and the
              error), so its live region is already on the page when its text
              changes and a screen reader speaks Coffey's header when it lands. */}
          <CoffeyBubble expression={loading || errorMsg ? 'thinking' : 'happy'} live>
            {loading ? (
              <ThinkingCopy />
            ) : errorMsg ? (
              "Hmm, that one got away from me."
            ) : (
              response?.header || FALLBACK_HEADER
            )}
          </CoffeyBubble>

          <h1
            id="suggest-step3-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mt-6 text-2xl font-bold text-charcoal outline-none"
          >
            {loading ? 'Finding your picks…' : errorMsg ? 'We had trouble with that' : 'Your picks'}
          </h1>

          {loading ? (
            <div className="mt-6">
              <ResultsSkeleton />
            </div>
          ) : errorMsg ? (
            <div className="mt-6 flex flex-col items-center gap-4 rounded-md border border-line bg-cream p-6 text-center">
              <p className="text-muted">{errorMsg}</p>
              <Link href="/menu" className={buttonVariants({ size: 'md' })}>
                Browse the menu
              </Link>
            </div>
          ) : response ? (
            <>
              {response.relaxHint ? (
                <div
                  role="status"
                  className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-tan bg-surface px-4 py-3 text-sm text-charcoal"
                >
                  <span>{response.relaxHint.message}</span>
                  <button
                    type="button"
                    onClick={() => handleRelax(response.relaxHint!.constraint)}
                    className="min-h-[44px] shrink-0 rounded-full border border-tan px-3 text-sm font-semibold text-tan-dark hover:bg-tan-dark hover:text-cream"
                  >
                    Show me more options
                  </button>
                </div>
              ) : null}

              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {response.usual ? renderCard(response.usual, true) : null}
                {response.picks.map((pick) => renderCard(pick))}
              </div>

              {response.picks.length === 0 && !response.usual ? (
                <p className="mt-6 text-center text-sm text-muted">
                  Nothing quite fits yet — try the option above, or browse the full menu below.
                </p>
              ) : null}

              <div className="mt-8 flex flex-col items-center gap-1">
                {response.refinesLeft > 0 ? (
                  <button
                    type="button"
                    onClick={handleRefine}
                    className={buttonVariants({ variant: 'secondary' })}
                  >
                    Show me something different
                  </button>
                ) : (
                  <Link href="/menu" className={buttonVariants({ variant: 'secondary' })}>
                    Browse the full menu
                  </Link>
                )}
                <Link
                  href="/coffey"
                  className="mt-2 inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline"
                >
                  What can Coffey do?&nbsp;<span aria-hidden="true">→</span>
                </Link>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      <div className="mt-10 text-center">
        <button
          type="button"
          onClick={handleBrowseMenu}
          className="min-h-[44px] px-2 text-sm text-muted underline hover:text-charcoal"
        >
          No thanks, I&apos;ll browse the menu
        </button>
      </div>

      {customizeTarget ? <CustomizeModal target={customizeTarget} onClose={handleCloseCustomize} /> : null}
    </div>
  );
}
