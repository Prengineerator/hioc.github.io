'use client';

// The /suggest 3-step wizard (§3.2/§3.3 of the Phase-7 spec). Owns all client
// state; talks to the server only through components/suggest/api.ts, which is
// the seam that follows the lib/suggest/types.ts contract.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart/CartContext';
import { MenuItemCustomizeModal } from '@/components/menu/MenuItemCustomizeModal';
import { Chip } from '@/components/suggest/Chip';
import { MoodCard } from '@/components/suggest/MoodCard';
import { SuggestionCard } from '@/components/suggest/SuggestionCard';
import { ResultsSkeleton } from '@/components/suggest/ResultsSkeleton';
import { fetchSuggestions, getAnonId, postSuggestEvent } from '@/components/suggest/api';
import { buttonVariants } from '@/components/ui/Button';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';
import type {
  Budget,
  BasePref,
  Extra,
  Mood,
  Need,
  RelaxHint,
  SuggestInputs,
  SuggestResponse,
  TemperaturePref,
} from '@/lib/suggest/types';
import type { MenuItem } from '@/lib/types';

const TEMPERATURE_OPTIONS: { value: TemperaturePref; label: string }[] = [
  { value: 'hot', label: 'Hot' },
  { value: 'iced', label: 'Iced' },
  { value: 'either', label: 'Either' },
];

const BASE_OPTIONS: { value: BasePref; label: string }[] = [
  { value: 'coffee', label: 'Coffee' },
  { value: 'no_coffee', label: 'No coffee' },
  { value: 'either', label: 'Either' },
];

const EXTRA_OPTIONS: { value: Extra; label: string }[] = [
  { value: 'sweet', label: 'Something sweet' },
  { value: 'eat', label: 'Something to eat' },
  { value: 'light', label: 'Light' },
  { value: 'filling', label: 'Filling' },
];

const NEED_OPTIONS: { value: Need; label: string }[] = [
  { value: 'no_caffeine', label: 'No caffeine' },
  { value: 'less_sugar', label: 'Less sugar' },
];

const BUDGET_OPTIONS: { value: Budget; label: string }[] = [
  { value: 'under_150', label: 'Under ₹150' },
  { value: '150_300', label: '₹150–₹300' },
  { value: 'treat', label: 'Treat myself' },
  { value: 'any', label: 'No preference' },
];

const MOOD_OPTIONS: { value: Mood; label: string; icon: string }[] = [
  { value: 'boost', label: 'Need a boost', icon: '⚡' },
  { value: 'cosy', label: 'Calm & cosy', icon: '☕' },
  { value: 'celebrate', label: 'Celebrating', icon: '🎉' },
  { value: 'comfort', label: 'Need some comfort', icon: '🤗' },
  { value: 'cool', label: 'Hot day, cool me down', icon: '🧊' },
  { value: 'surprise', label: 'Surprise me', icon: '✨' },
];

const SUGGEST_TIMEOUT_MS = 8000;

function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-6">
      <h2 className="mb-2 text-sm font-bold text-charcoal">{label}</h2>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

type Step = 'preferences' | 'mood' | 'results';

interface CustomizeTarget {
  item: MenuItem;
  sessionId: string;
  beforeCartTotal: number;
}

export function SuggestWizard() {
  const router = useRouter();
  const { addItem, totalItems, setPendingSuggestionSessionId } = useCart();

  const [step, setStep] = useState<Step>('preferences');
  const [temperature, setTemperature] = useState<TemperaturePref>('either');
  const [base, setBase] = useState<BasePref>('either');
  const [extras, setExtras] = useState<Extra[]>([]);
  const [needs, setNeeds] = useState<Need[]>([]);
  const [budget, setBudget] = useState<Budget>('any');
  const [mood, setMood] = useState<Mood | null>(null);
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

  useEffect(() => {
    sessionIdRef.current = response?.sessionId ?? null;
  }, [response]);

  // Accessibility: move focus to the current step's heading on every step
  // change, so a screen-reader user (and a keyboard user who just pressed
  // Next/Back) lands on the new step's content instead of wherever the old
  // button used to be.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

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

  const buildInputs = useCallback(
    (overrides: Partial<SuggestInputs> = {}): SuggestInputs => ({
      temperature,
      base,
      extras,
      needs,
      budget,
      // mood is required to reach step 3 (the button that calls this is
      // disabled until one is chosen), so this fallback is unreachable in
      // practice — it only satisfies the type.
      mood: mood ?? 'surprise',
      note: note.trim().slice(0, SUGGEST_LIMITS.noteMaxChars),
      ...overrides,
    }),
    [temperature, base, extras, needs, budget, mood, note],
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
        const ids = [
          ...(result.usual ? [result.usual.menuItemId] : []),
          ...result.picks.map((p) => p.menuItemId),
        ];
        setShownIds((prev) => Array.from(new Set([...prev, ...ids])));
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

  function toggleExtra(value: Extra) {
    setExtras((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }
  function toggleNeed(value: Need) {
    setNeeds((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  function submitForSuggestions() {
    if (!mood) return;
    runSuggest(buildInputs());
  }

  function handleRefine() {
    if (!response) return;
    postSuggestEvent(response.sessionId, 'refined');
    engagedRef.current = true;
    runSuggest(buildInputs(), { refineOf: response.sessionId, exclude: shownIds });
  }

  function handleRelax(constraint: RelaxHint['constraint']) {
    let nextInputs: SuggestInputs;
    switch (constraint) {
      case 'temperature':
        setTemperature('either');
        nextInputs = buildInputs({ temperature: 'either' });
        break;
      case 'base':
        setBase('either');
        nextInputs = buildInputs({ base: 'either' });
        break;
      case 'budget':
        setBudget('any');
        nextInputs = buildInputs({ budget: 'any' });
        break;
      case 'extras':
        setExtras([]);
        nextInputs = buildInputs({ extras: [] });
        break;
      case 'needs':
        setNeeds([]);
        nextInputs = buildInputs({ needs: [] });
        break;
      default:
        nextInputs = buildInputs();
    }
    runSuggest(nextInputs);
  }

  function handleAddToCart(item: MenuItem) {
    if (!response) return;
    const isSimple = item.variants.length === 1 && item.addon_groups.length === 0;
    engagedRef.current = true;
    if (isSimple && item.variants[0]) {
      const variant = item.variants[0];
      addItem({
        menuItemId: item.id,
        variantId: variant.id,
        name: item.name,
        variantLabel: variant.label,
        unitPriceInr: variant.price_inr,
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
      setCustomizeTarget({ item, sessionId: response.sessionId, beforeCartTotal: totalItems });
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

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 pb-28">
      {step === 'preferences' ? (
        <section aria-labelledby="suggest-step1-heading">
          <h1
            id="suggest-step1-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-bold text-charcoal outline-none"
          >
            What are you in the mood for?
          </h1>
          <p className="mt-1 text-sm text-muted">
            Pick as many or as few as you like — nothing here is required.
          </p>

          <FieldGroup label="Temperature">
            {TEMPERATURE_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                pressed={temperature === opt.value}
                onClick={() => setTemperature(opt.value)}
              />
            ))}
          </FieldGroup>

          <FieldGroup label="Coffee or not">
            {BASE_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                pressed={base === opt.value}
                onClick={() => setBase(opt.value)}
              />
            ))}
          </FieldGroup>

          <FieldGroup label="Anything extra">
            {EXTRA_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                pressed={extras.includes(opt.value)}
                onClick={() => toggleExtra(opt.value)}
              />
            ))}
          </FieldGroup>

          <FieldGroup label="Any needs">
            {NEED_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                pressed={needs.includes(opt.value)}
                onClick={() => toggleNeed(opt.value)}
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

          <div className="mt-8 flex justify-end">
            <button type="button" onClick={() => setStep('mood')} className={buttonVariants({ size: 'lg' })}>
              Next
            </button>
          </div>
        </section>
      ) : null}

      {step === 'mood' ? (
        <section aria-labelledby="suggest-step2-heading">
          <button
            type="button"
            onClick={() => setStep('preferences')}
            className="mb-4 text-sm font-bold text-tan hover:underline"
          >
            ← Back
          </button>
          <h1
            id="suggest-step2-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-bold text-charcoal outline-none"
          >
            How are you feeling?
          </h1>

          <div
            role="radiogroup"
            aria-labelledby="suggest-step2-heading"
            className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3"
          >
            {MOOD_OPTIONS.map((opt) => (
              <MoodCard
                key={opt.value}
                label={opt.label}
                icon={opt.icon}
                selected={mood === opt.value}
                onSelect={() => setMood(opt.value)}
              />
            ))}
          </div>

          <div className="mt-6">
            <label htmlFor="suggest-note" className="mb-1 block text-sm font-bold text-charcoal">
              Anything else? <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id="suggest-note"
              type="text"
              value={note}
              maxLength={SUGGEST_LIMITS.noteMaxChars}
              onChange={(e) => setNote(e.target.value.slice(0, SUGGEST_LIMITS.noteMaxChars))}
              placeholder="e.g. meeting a friend"
              className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
            <p className="mt-1 text-right text-xs text-muted">
              {note.length}/{SUGGEST_LIMITS.noteMaxChars}
            </p>
          </div>

          <div className="mt-8 flex justify-end">
            <button
              type="button"
              disabled={!mood}
              onClick={submitForSuggestions}
              className={buttonVariants({ size: 'lg' })}
            >
              Show me some picks
            </button>
          </div>
        </section>
      ) : null}

      {step === 'results' ? (
        <section aria-labelledby="suggest-step3-heading">
          <button
            type="button"
            onClick={() => setStep('mood')}
            className="mb-4 text-sm font-bold text-tan hover:underline"
          >
            ← Back
          </button>
          <h1
            id="suggest-step3-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-bold text-charcoal outline-none"
          >
            {loading
              ? 'Finding your picks…'
              : errorMsg
                ? 'We had trouble with that'
                : (response?.header ?? "Here's what we'd pour for you ☕")}
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
                    className="min-h-[44px] shrink-0 rounded-full border border-tan px-3 text-xs font-bold text-tan hover:bg-tan hover:text-cream"
                  >
                    Show me more options
                  </button>
                </div>
              ) : null}

              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {response.usual && itemsById.get(response.usual.menuItemId) ? (
                  <SuggestionCard
                    item={itemsById.get(response.usual.menuItemId)!}
                    pick={response.usual}
                    isUsual
                    feedback={feedbackGiven[response.usual.menuItemId]}
                    onAddToCart={() => handleAddToCart(itemsById.get(response.usual!.menuItemId)!)}
                    onFeedback={(dir) => handleFeedback(response.usual!.menuItemId, dir)}
                  />
                ) : null}
                {response.picks.map((pick) => {
                  const item = itemsById.get(pick.menuItemId);
                  if (!item) return null;
                  return (
                    <SuggestionCard
                      key={pick.menuItemId}
                      item={item}
                      pick={pick}
                      feedback={feedbackGiven[pick.menuItemId]}
                      onAddToCart={() => handleAddToCart(item)}
                      onFeedback={(dir) => handleFeedback(pick.menuItemId, dir)}
                    />
                  );
                })}
              </div>

              {response.picks.length === 0 && !response.usual ? (
                <p className="mt-6 text-center text-sm text-muted">
                  Nothing quite fits yet — try the option above, or browse the full menu below.
                </p>
              ) : null}

              <div className="mt-8 flex flex-col items-center gap-2">
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

      {customizeTarget ? (
        <MenuItemCustomizeModal item={customizeTarget.item} onClose={handleCloseCustomize} />
      ) : null}
    </div>
  );
}
